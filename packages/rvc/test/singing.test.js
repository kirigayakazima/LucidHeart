import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { apply } from '../lib/index.js'
import { runPcSong } from '../lib/sing.js'
import { DatabaseSync } from 'node:sqlite'
import { taskLedger, taskSchema } from '../../companion/lib/tasks/ledger.js'

const mp3 = Buffer.alloc(256)
mp3.write('ID3')
const jobsPath = '/v1/voice/sing/jobs'
const remoteId = 'pc-song-01'
const downloadPath = `/v1/voice/sing/download/${remoteId}`
const ack = '小满收到啦，这就去后台翻曲谱~'
const messagesByStage = [
  '满宝去换装准备啦，正在切伴奏哦～',
  '伴奏准备好啦，满宝开始变声录歌咯～',
  '录好啦，正在做温暖的母带混音哦～',
]

function snapshot(stage) {
  return Response.json({ jobId: remoteId, status: stage, stage,
    ...(stage === 'completed' ? { result: { ok: true, task: remoteId, executionProvider: 'CUDAExecutionProvider' } } : {}),
  })
}

function mockCompletedJob(t, download) {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const route = new URL(url).pathname
    if (route === '/health') return new Response()
    if (route === jobsPath && options.method === 'POST') return snapshot('completed')
    assert.equal(route, downloadPath)
    return download()
  })
}

test('singing client consumes fragmented stage events over loopback before publishing the download', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'dsh-sing-stream-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const file = path.join(folder, 'source.mp3')
  const output = path.join(folder, 'result.mp3')
  const audio = childProcess.execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=440:d=0.3', '-f', 'mp3', '-'])
  await writeFile(file, audio)
  const stages = []
  const seenRvc = Promise.withResolvers()
  const server = createServer(async (req, res) => {
    if (req.url === '/health') return res.end()
    if (req.method === 'POST') {
      const received = []
      for await (const chunk of req) received.push(chunk)
      assert.deepEqual(Buffer.concat(received), audio)
      if (new URL(req.url, 'http://localhost').pathname === jobsPath) {
        res.statusCode = 404
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
      res.write('{"type":"stage","stage":"separation"}\n{"type":"stage",')
      res.write('"stage":"rvc"}\n{"type":"heartbeat","stage":"rvc"}\n')
      await seenRvc.promise
      res.end('{"type":"stage","stage":"mastering"}\n{"type":"stage","stage":"mixing"}\n'
        + '{"type":"result","result":{"ok":true,"task":"song"}}')
      return
    }
    assert.equal(req.url, '/v1/voice/sing/download/song')
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' })
    res.end(audio)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  await runPcSong({
    source: { file, size: audio.length }, jobId: 'song', pitch: 0, output,
    signal: AbortSignal.timeout(4000), gatewayUrl: `http://127.0.0.1:${server.address().port}`,
    onStage(stage) {
      stages.push(stage)
      if (stage === 'rvc') seenRvc.resolve()
    },
  })
  assert.deepEqual(stages, ['separation', 'rvc', 'mixing'])
  assert.deepEqual(await readFile(output), audio)
  await assert.rejects(stat(`${output}.part`), { code: 'ENOENT' })
})

async function fixture(t) {
  const songsDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-sing-test-'))
  t.after(() => rm(songsDir, { recursive: true, force: true }))
  await writeFile(path.join(songsDir, 'yinghuacao.m4a'), mp3)
  const tools = new Map()
  const messages = []
  const files = []
  const observed = Promise.withResolvers()
  const target = { scope: 'group', targetId: 'original-group', msgId: 'request-msg' }
  const ctx = {
    tools: { register: tool => tools.set(tool.name, tool) },
    on() {},
    heart: {
      evaluateActivity(intent, { execution }) {
        assert.equal(intent.intent, 'voice_sing')
        assert.equal(execution.agent.id, 'request-session')
        return { suitable: true, origin: 'user_request', quotaApplied: false }
      },
      observe: observed.resolve,
    },
    qqbotSender: { async sendMarkdown(peer, message) { messages.push({ peer, message }) } },
    qqbotMediaSender: {
      resolveTargetForSession: id => id === 'request-session' ? { ...target } : undefined,
      async sendFile(peer, { localPath }, options) {
        files.push({ peer, data: await readFile(localPath), options })
      },
    },
  }
  apply(ctx, { songsDir })
  const controller = new AbortController()
  t.after(() => controller.abort())
  const exec = { agent: { id: 'request-session' }, signal: controller.signal }
  return { songsDir, ctx, target, messages, files, observed, controller, exec,
    request: args => tools.get('rvc_sing').execute({ song_title: '樱花草', ...args }, exec) }
}

test('QQ 点歌后台按阶段去重播报，完成后只向原会话投递完整附件', { timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(taskSchema)
  const ledger = taskLedger(db, Date.now)
  f.ctx.companion = { tasks: ledger }
  const remote = Promise.withResolvers()
  const upload = Promise.withResolvers()
  const stages = ['demucs', 'demucs', 'rvc_convert', 'demucs', 'mastering', 'mastering', 'completed']
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url)
    assert.equal(route.origin, 'http://127.0.0.1:28765')
    if (route.pathname === '/health') return new Response()
    assert.match(opts.headers.Authorization, /^Bearer /)
    if (opts.method === 'POST') {
      assert.equal(route.pathname, jobsPath)
      assert.equal(route.searchParams.get('format'), 'm4a')
      assert.equal(route.searchParams.get('pitch'), '-4')
      const chunks = []
      for await (const chunk of opts.body) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), mp3)
      upload.resolve()
      return snapshot('queued')
    }
    if (route.pathname === `${jobsPath}/${remoteId}`) {
      await remote.promise
      return snapshot(stages.shift())
    }
    assert.equal(route.pathname, downloadPath)
    return new Response(mp3)
  })
  const job = await f.request({ pitch: -2 })
  assert.equal(job.status, 'dispatched')
  assert.equal(f.messages[0].message, ack)
  assert.deepEqual(f.messages[0].peer, f.target)
  await upload.promise
  assert.equal((await f.request({ pitch: -2 })).job_id, job.job_id)
  assert.equal(f.files.length, 0)
  f.ctx.qqbotMediaSender.resolveTargetForSession = () => ({ scope: 'c2c', targetId: 'later-chat' })
  remote.resolve()
  const observation = await f.observed.promise
  assert.equal(ledger.get(job.task_id).status, 'delivered')
  assert.equal(ledger.get(job.task_id).result.output_path, job.expected_output)
  assert.equal(observation.evidence.mode, 'pc_gpu_pipeline')
  assert.equal(observation.evidence.execution.provider, 'CUDAExecutionProvider')
  assert.deepEqual(f.messages, [ack, ...messagesByStage].map(message => ({ peer: f.target, message })))
  assert.deepEqual(f.files, [{ peer: f.target, data: mp3, options: { fileName: '樱花草.mp3' } }])
  assert.deepEqual(await readFile(job.expected_output), mp3)
})

test('无效 PC 下载先播报降级，调用仅本地链路，再投递本地产物', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  mockCompletedJob(t, () => Response.json({ detail: 'not an MP3' }))
  t.mock.method(childProcess, 'spawn', (command, args, { env }) => {
    assert.equal(command, 'bash')
    assert.equal(env.RVC_LOCAL_ONLY, '1')
    assert.match(f.messages.at(-1).message, /用手机/)
    const child = new EventEmitter()
    writeFile(path.join(env.RVC_OUTPUT_DIR, `song_${args[2]}.mp3`), mp3)
      .then(() => child.emit('close', 0), error => child.emit('error', error))
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const job = await f.request()
  assert.equal((await f.observed.promise).evidence.mode, 'phone_local')
  assert.deepEqual(f.files[0].data, mp3)
  await assert.rejects(stat(`${job.expected_output}.part`), { code: 'ENOENT' })
})

test('显式要求电脑外放时，成曲进入 PC 播放租约队列并保留 QQ 投递', async t => {
  const f = await fixture(t)
  const events = []
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url).pathname
    if (route === '/health') return new Response()
    if (route === jobsPath) {
      for await (const _ of opts.body) { /* drain the uploaded audio */ }
      return snapshot('completed')
    }
    if (route === downloadPath) {
      events.push('download')
      return new Response(mp3)
    }
    assert.equal(route, `/v1/voice/sing/play/${remoteId}`)
    assert.equal(opts.method, 'POST')
    events.push('playback')
    return Response.json({ status: 'queued' })
  })
  await f.request({ play_on_pc: true })
  await f.observed.promise
  assert.deepEqual(events, ['download', 'playback'])
  assert.equal(f.files.length, 1)
})

test('PC 连通探测 3 秒超时后直接降级，本地失败时不投递', { timeout: 6500 }, async t => {
  const f = await fixture(t)
  const failed = Promise.withResolvers()
  const send = f.ctx.qqbotSender.sendMarkdown
  f.ctx.qqbotSender.sendMarkdown = async (peer, text) => {
    await send(peer, text)
    if (text.includes('没能把歌合成出来')) failed.resolve()
  }
  let timedOut = false
  const fetch = t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    assert.equal(new URL(url).pathname, '/health')
    return new Promise((_resolve, reject) => {
      const unexpected = setTimeout(() => reject(new Error('Expected gateway probe timeout')), 5_000)
      signal.addEventListener('abort', () => {
        clearTimeout(unexpected)
        timedOut = signal.reason.name === 'TimeoutError'
        reject(signal.reason)
      }, { once: true })
    })
  })
  t.mock.method(childProcess, 'spawn', () => {
    const child = new EventEmitter()
    queueMicrotask(() => {
      child.emit('error', new Error('missing worker'))
      child.emit('close', -1)
    })
    return child
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  await f.request()
  await failed.promise
  assert.equal(timedOut, true)
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(f.messages.length, 3)
  assert.equal(f.files.length, 0)
})

test('回合取消停止 PC 轮询，并使用独立信号通知 PC 终止作业', { timeout: 7000 }, async t => {
  const f = await fixture(t)
  const polling = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  let cancelCount = 0
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url).pathname
    if (route === '/health') return new Response()
    if (route === jobsPath && opts.method === 'POST') return snapshot('demucs')
    if (route.endsWith('/cancel')) {
      assert.equal(route, `${jobsPath}/${remoteId}/cancel`)
      assert.equal(opts.method, 'POST')
      assert.equal(opts.signal.aborted, false)
      cancelCount += 1
      cancelled.resolve()
      return snapshot('cancelled')
    }
    assert.equal(route, `${jobsPath}/${remoteId}`)
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
      polling.resolve()
    })
  })
  const job = await f.request()
  await polling.promise
  f.controller.abort()
  await cancelled.promise
  await nextTick()
  assert.equal(cancelCount, 1)
  assert.deepEqual(f.messages.map(({ message }) => message), [ack, messagesByStage[0]])
  assert.equal(f.files.length, 0)
  await assert.rejects(stat(job.expected_output), { code: 'ENOENT' })
})

test('回合取消终止后台下载且不播报失败或发送成曲', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const downloading = Promise.withResolvers()
  const ended = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url).pathname
    if (route === '/health') return new Response()
    if (route === jobsPath && opts.method === 'POST') return snapshot('completed')
    if (route === `${jobsPath}/${remoteId}/cancel`) {
      assert.equal(opts.method, 'POST')
      assert.equal(opts.signal.aborted, false)
      cancelled.resolve()
      return snapshot('completed')
    }
    assert.equal(route, downloadPath)
    downloading.resolve()
    return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => {
      reject(opts.signal.reason)
      ended.resolve()
    }, { once: true }))
  })
  const job = await f.request()
  await downloading.promise
  f.controller.abort()
  await Promise.all([ended.promise, cancelled.promise])
  await nextTick()
  assert.equal(f.messages.length, 1)
  assert.equal(f.files.length, 0)
  await assert.rejects(stat(job.expected_output), { code: 'ENOENT' })
})

test('上传完成后取消时，迟到的任务 ID 仍会收到取消请求', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const uploaded = Promise.withResolvers()
  const acknowledgement = Promise.withResolvers()
  const cancelled = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url).pathname
    if (route === '/health') return new Response()
    if (route === jobsPath && opts.method === 'POST') {
      for await (const _chunk of opts.body) { /* drain the upload before aborting */ }
      uploaded.resolve(opts.signal)
      return acknowledgement.promise
    }
    assert.equal(route, `${jobsPath}/${remoteId}/cancel`)
    assert.equal(opts.method, 'POST')
    cancelled.resolve()
    return snapshot('cancelled')
  })
  const job = await f.request()
  const submissionSignal = await uploaded.promise
  f.controller.abort()
  assert.equal(submissionSignal.aborted, false)
  acknowledgement.resolve(snapshot('queued'))
  await cancelled.promise
  await nextTick()
  assert.equal(f.files.length, 0)
  assert.deepEqual(f.messages.map(({ message }) => message), [ack])
  await assert.rejects(stat(job.expected_output), { code: 'ENOENT' })
})

test('Heart 静音时不发送确认、不提交 PC 任务', async t => {
  const f = await fixture(t)
  f.ctx.heart.evaluateActivity = () => ({ suitable: false, reason: 'quiet-hours' })
  const fetch = t.mock.method(globalThis, 'fetch', () => assert.fail('unexpected network call'))
  assert.equal((await f.request()).status, 'blocked_by_heart')
  assert.equal(f.messages.length, 0)
  assert.equal(fetch.mock.callCount(), 0)
})

test('QQ 明确拒收附件时告知用户，成曲仍可从本地取得', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  f.ctx.qqbotMediaSender.sendFile = async () => ({ ok: false, error: 'QQ rejected upload' })
  mockCompletedJob(t, () => new Response(mp3))
  const job = await f.request()
  await f.observed.promise
  assert.match(f.messages.at(-1).message, /没能把音频送出去/)
  assert.deepEqual(await readFile(job.expected_output), mp3)
})

test('未知会话只保存成曲，QQ 服务存在时也不猜投递目标', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  f.ctx.qqbotMediaSender.resolveTargetForSession = () => undefined
  mockCompletedJob(t, () => new Response(mp3))
  const job = await f.request()
  await f.observed.promise
  assert.equal(job.qq_auto_delivery, false)
  assert.equal(f.messages.length, 0)
  assert.equal(f.files.length, 0)
  assert.deepEqual(await readFile(job.expected_output), mp3)
})
