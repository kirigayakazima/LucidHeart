import { test } from 'node:test'
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTick } from 'node:timers/promises'
import { apply } from '../lib/index.js'

const mp3 = Buffer.alloc(256)
mp3.write('ID3')

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

test('QQ 点歌先确认、后台返回、完成下载后只向原会话投递完整附件', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const remote = Promise.withResolvers()
  const upload = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const route = new URL(url)
    assert.equal(route.origin, 'http://127.0.0.1:28765')
    assert.match(opts.headers.Authorization, /^Bearer /)
    if (opts.method === 'POST') {
      assert.equal(route.pathname, '/v1/voice/sing')
      assert.equal(route.searchParams.get('format'), 'm4a')
      assert.equal(route.searchParams.get('pitch'), '-4')
      const chunks = []
      for await (const chunk of opts.body) chunks.push(chunk)
      assert.deepEqual(Buffer.concat(chunks), mp3)
      upload.resolve(route.searchParams.get('task'))
      await remote.promise
      return Response.json({ ok: true, task: route.searchParams.get('task') })
    }
    assert.equal(route.pathname, `/v1/voice/sing/download/${await upload.promise}`)
    return new Response(mp3)
  })
  const job = await f.request({ pitch: -2 })
  assert.equal(job.status, 'dispatched')
  assert.match(f.messages[0].message, /一分钟/)
  assert.deepEqual(f.messages[0].peer, f.target)
  assert.equal(await upload.promise, job.job_id)
  assert.equal((await f.request({ pitch: -2 })).job_id, job.job_id)
  assert.equal(f.files.length, 0)
  f.ctx.qqbotMediaSender.resolveTargetForSession = () => ({ scope: 'c2c', targetId: 'later-chat' })
  remote.resolve()
  const observation = await f.observed.promise
  assert.equal(observation.evidence.mode, 'pc_gpu_pipeline')
  assert.deepEqual(f.files, [{ peer: f.target, data: mp3, options: { fileName: '樱花草.mp3' } }])
  assert.deepEqual(await readFile(job.expected_output), mp3)
})

test('无效 PC 下载先播报降级，调用仅本地链路，再投递本地产物', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'POST') return Response.json({ ok: true, task: new URL(url).searchParams.get('task') })
    return new Response(JSON.stringify({ detail: 'not an MP3' }))
  })
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

test('后台 PC 失败且本地 worker 无法启动时，QQ 收到失败提示且不投递', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const failed = Promise.withResolvers()
  const send = f.ctx.qqbotSender.sendMarkdown
  f.ctx.qqbotSender.sendMarkdown = async (peer, text) => {
    await send(peer, text)
    if (text.includes('没能把歌合成出来')) failed.resolve()
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('gateway offline') })
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
  assert.equal(f.messages.length, 3)
  assert.equal(f.files.length, 0)
})

test('回合取消终止后台下载且不播报失败或发送成曲', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  const downloading = Promise.withResolvers()
  const ended = Promise.withResolvers()
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'POST') return Response.json({ ok: true, task: new URL(url).searchParams.get('task') })
    downloading.resolve()
    return new Promise((_resolve, reject) => opts.signal.addEventListener('abort', () => {
      reject(opts.signal.reason)
      ended.resolve()
    }, { once: true }))
  })
  const job = await f.request()
  await downloading.promise
  f.controller.abort()
  await ended.promise
  await nextTick()
  assert.equal(f.messages.length, 1)
  assert.equal(f.files.length, 0)
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
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'POST') return Response.json({ ok: true, task: new URL(url).searchParams.get('task') })
    return new Response(mp3)
  })
  const job = await f.request()
  await f.observed.promise
  assert.match(f.messages.at(-1).message, /没能把音频送出去/)
  assert.deepEqual(await readFile(job.expected_output), mp3)
})

test('未知会话只保存成曲，QQ 服务存在时也不猜投递目标', { timeout: 3000 }, async t => {
  const f = await fixture(t)
  f.ctx.qqbotMediaSender.resolveTargetForSession = () => undefined
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    if (opts.method === 'POST') return Response.json({ ok: true, task: new URL(url).searchParams.get('task') })
    return new Response(mp3)
  })
  const job = await f.request()
  await f.observed.promise
  assert.equal(job.qq_auto_delivery, false)
  assert.equal(f.messages.length, 0)
  assert.equal(f.files.length, 0)
  assert.deepEqual(await readFile(job.expected_output), mp3)
})
