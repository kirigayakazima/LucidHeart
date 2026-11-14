import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as wait } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const formats = ['m4a', 'mp3', 'wav', 'flac']
const maxBytes = 60 * 1024 * 1024
const auth = { Authorization: 'Bearer xiaoman-pc-bridge-secret-2026' }
const gateway = 'http://127.0.0.1:28765'
const localScript = fileURLToPath(new URL('../vendor/phone/sing-chain.sh', import.meta.url))
const connectTimeout = 3_000
const pollInterval = 1_500
const stageAliases = new Map([
  ['demucs', 'separation'], ['separation', 'separation'],
  ['rvc_convert', 'rvc'], ['rvc', 'rvc'],
  ['mastering', 'mixing'], ['mixing', 'mixing'],
])
const stages = ['separation', 'rvc', 'mixing']

export class PcSongCancelled extends Error {}

export async function findSong(root, input, title, taskName) {
  const stems = new Set([title, input && path.basename(input), taskName])
  if (stems.has('樱花草')) stems.add('yinghuacao')
  const candidates = input ? [path.resolve(input), path.resolve(root, input)] : []
  for (const stem of stems) {
    if (!stem || path.basename(stem) !== stem) continue
    for (const format of formats) candidates.push(path.join(root, `${stem}.${format}`))
  }
  for (const file of candidates) {
    if (!formats.includes(path.extname(file).slice(1).toLowerCase())) continue
    const info = await stat(file).catch(() => null)
    if (info?.isFile() && info.size > 0) return { file, size: info.size }
  }
}

async function checkMp3(file) {
  const handle = await open(file, 'r')
  try {
    const header = Buffer.alloc(3)
    await handle.read(header, 0, 3, 0)
    if ((await handle.stat()).size < 128 ||
        (header.toString() !== 'ID3' && (header[0] !== 0xff || (header[1] & 0xe0) !== 0xe0))) {
      throw new Error('Invalid song MP3')
    }
  } finally {
    await handle.close()
  }
}

async function requireResponse(response) {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`PC singing HTTP ${response.status}`)
  }
  return response
}

function uploadOptions(source, body, signal) {
  return {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.size) },
    body, duplex: 'half', redirect: 'error', signal,
  }
}

async function readPcJson(response) {
  let text = ''
  for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
    text += chunk
    if (text.length > 16_384) throw new Error('PC singing response exceeds limit')
  }
  return JSON.parse(text)
}

async function submitPcJob({ source, pitch, signal, gatewayUrl }) {
  signal.throwIfAborted()
  const query = new URLSearchParams({ pitch, format: path.extname(source.file).slice(1).toLowerCase() })
  const upload = createReadStream(source.file)
  function stopUpload() {
    // After the upload is read, keep the bounded acknowledgement alive so a
    // concurrent abort can still obtain the remote ID and cancel the job.
    if (!upload.readableEnded) upload.destroy()
  }
  signal.addEventListener('abort', stopUpload, { once: true })
  try {
    const response = await fetch(`${gatewayUrl}/v1/voice/sing/jobs?${query}`,
      uploadOptions(source, upload, AbortSignal.timeout(95_000)))
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel()
      return
    }
    return await readPcJson(await requireResponse(response))
  } finally {
    signal.removeEventListener('abort', stopUpload)
    upload.destroy()
  }
}

function remoteId(snapshot) {
  return snapshot?.jobId ?? snapshot?.job_id
}

async function pollPcJob({ signal, onStage, onStatus, gatewayUrl, output }, submitted) {
  const id = remoteId(submitted)
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid PC singing job ID')
  const url = `${gatewayUrl}/v1/voice/sing/jobs/${id}`
  let cancellation
  function cancelJob() {
    cancellation ??= (async () => {
      try {
        const response = await requireResponse(await fetch(`${url}/cancel`, {
          method: 'POST', headers: auth, redirect: 'error', signal: AbortSignal.timeout(connectTimeout),
        }))
        await response.body?.cancel()
      } catch (error) {
        console.warn('[@dsh/rvc] PC 唱歌取消请求失败:', error.message)
      }
    })()
    return cancellation
  }
  signal.addEventListener('abort', cancelJob, { once: true })
  const polling = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
  let terminal = false
  let snapshot = submitted
  try {
    polling.throwIfAborted()
    while (true) {
      if (remoteId(snapshot) !== id) throw new Error('PC singing status job ID mismatch')
      const state = snapshot.status ?? snapshot.state
      if (state === 'cancelled') {
        terminal = true
        throw new PcSongCancelled('PC singing job was cancelled')
      }
      if (state === 'failed') {
        terminal = true
        throw new Error(snapshot.error || 'PC singing job failed')
      }
      if (state === 'completed') {
        terminal = true
        const result = snapshot.result
        if (result ? result.ok !== true || result.task !== id : !snapshot.result_audio_url) {
          throw new Error('Invalid PC singing result')
        }
        await downloadSong({ output, signal, gatewayUrl }, id)
        return { provider: result?.executionProvider ?? null, remoteJobId: id }
      }
      const stage = snapshot.stage ?? state
      if (!stageAliases.has(stage) && stage !== 'queued' && state !== 'running') {
        throw new Error('Invalid PC singing stage')
      }
      onStatus?.(stage, snapshot)
      onStage(stage)
      await wait(pollInterval, undefined, { signal: polling })
      const response = await requireResponse(await fetch(url, {
        headers: auth, redirect: 'error', signal: AbortSignal.any([polling, AbortSignal.timeout(5_000)]),
      }))
      snapshot = await readPcJson(response)
    }
  } finally {
    signal.removeEventListener('abort', cancelJob)
    if (signal.aborted || !terminal) await cancelJob()
  }
}

async function runLegacyPcSong({ source, jobId, pitch, output, signal, onStage, gatewayUrl }) {
  signal.throwIfAborted()
  const query = new URLSearchParams({ task: jobId, pitch, format: path.extname(source.file).slice(1).toLowerCase(),
    heartbeat: 'true', progress: 'true' })
  const upload = createReadStream(source.file)
  const stalled = new AbortController()
  const uploadSignal = AbortSignal.any([signal, stalled.signal, AbortSignal.timeout(300_000)])
  let timer
  let result
  function refreshDeadline() {
    clearTimeout(timer)
    timer = setTimeout(() => stalled.abort(new Error('PC singing gateway timed out')), 30_000)
  }
  function consumeEvent(line) {
    if (!line.trim()) return
    const event = JSON.parse(line)
    if (event.type === 'stage') onStage(event.stage)
    if (event.type === 'result') result = event.result
  }
  try {
    refreshDeadline()
    const response = await requireResponse(await fetch(`${gatewayUrl}/v1/voice/sing?${query}`,
      uploadOptions(source, upload, uploadSignal)))
    const streamed = response.headers.get('content-type')?.includes('application/x-ndjson')
    let reply = ''
    refreshDeadline()
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      refreshDeadline()
      reply += chunk
      if (reply.length > 16_384) throw new Error('PC singing response exceeds limit')
      if (streamed) {
        const lines = reply.split('\n')
        reply = lines.pop()
        for (const line of lines) consumeEvent(line)
      }
    }
    if (streamed) consumeEvent(reply)
    else result = JSON.parse(reply)
    if (result?.ok !== true || result.task !== jobId) throw new Error(result?.error || 'Invalid PC singing result')
  } finally {
    clearTimeout(timer)
    upload.destroy()
  }
  await downloadSong({ output, signal, gatewayUrl }, jobId)
  return { provider: result.executionProvider ?? null, remoteJobId: jobId }
}

export async function queuePcSong(remoteJobId, signal) {
  const response = await requireResponse(await fetch(`${gateway}/v1/voice/sing/play/${remoteJobId}`, {
    method: 'POST', headers: auth, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(connectTimeout)]),
  }))
  await response.body?.cancel()
}

async function downloadSong({ output, signal, gatewayUrl }, remoteJobId) {
  signal.throwIfAborted()
  const partial = `${output}.part`
  try {
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const response = await requireResponse(await fetch(`${gatewayUrl}/v1/voice/sing/download/${remoteJobId}`, {
      headers: auth, redirect: 'error', signal: downloadSignal,
    }))
    let size = 0
    const limit = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length
        if (size > maxBytes) return done(new Error('Song exceeds download limit'))
        done(null, chunk)
      },
    })
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(partial, { flags: 'wx' }), { signal: downloadSignal })
    await checkMp3(partial)
    signal.throwIfAborted()
    await rename(partial, output)
    signal.throwIfAborted()
  } finally {
    await rm(partial, { force: true })
  }
}

export async function runPcSong({ source, jobId, pitch, output, signal, onStage, onStatus, gatewayUrl = gateway }) {
  if (source.size > maxBytes) throw new Error('Song exceeds PC upload limit')
  signal.throwIfAborted()
  // Check the tunnel before opening a potentially long-running audio upload.
  const health = await fetch(`${gatewayUrl}/health`, {
    redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(connectTimeout)]),
  })
  await health.body?.cancel()
  let lastStage = -1
  const job = { source, jobId, pitch, output, signal, gatewayUrl, onStatus, onStage(stage) {
    const canonical = stageAliases.get(stage)
    const rank = stages.indexOf(canonical)
    if (signal.aborted || rank <= lastStage) return
    lastStage = rank
    onStage?.(canonical)
  } }
  const submitted = await submitPcJob(job)
  return submitted === undefined ? runLegacyPcSong(job) : pollPcJob(job, submitted)
}

export async function runLocalSong({ source, jobId, pitch, output, signal, modelsDir, voiceProfile }) {
  const localSignal = AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)])
  localSignal.throwIfAborted()
  await new Promise((resolve, reject) => {
    const grouped = process.platform === 'linux'
    const child = spawn('bash', [localScript, source.file, jobId, String(pitch), modelsDir], {
      stdio: 'ignore', detached: grouped, windowsHide: true,
      env: { ...process.env, RVC_LOCAL_ONLY: '1', RVC_OUTPUT_DIR: path.dirname(output),
        RVC_VOICE_PROFILE: voiceProfile || path.join(modelsDir, 'voice-profile.json') },
    })
    function stop() {
      if (!child.pid) return
      try { grouped ? process.kill(-child.pid, 'SIGKILL') : child.kill() } catch {}
    }
    localSignal.addEventListener('abort', stop, { once: true })
    child.once('error', reject)
    child.once('close', code => {
      localSignal.removeEventListener('abort', stop)
      if (localSignal.aborted) reject(localSignal.reason)
      else if (code !== 0) reject(new Error(`Local singing exited with code ${code}`))
      else resolve()
    })
  })
  localSignal.throwIfAborted()
  await checkMp3(output)
}

export async function renderSong(job, onFallback) {
  job.artifactDir = job.artifacts.begin(`sing_${job.jobId}`)
  let complete = false
  try {
    try {
      const { provider, remoteJobId } = await runPcSong(job)
      job.signal.throwIfAborted()
      complete = true
      return { mode: 'pc_gpu_pipeline', provider, remoteJobId }
    } catch (error) {
      job.signal.throwIfAborted()
      if (error instanceof PcSongCancelled) throw error
      console.warn('[@dsh/rvc] PC 唱歌分流失败:', error.message)
      await onFallback(error)
      await runLocalSong(job)
      job.signal.throwIfAborted()
      complete = true
      return { mode: 'phone_onnx_fallback', profileId: 'feiyu-rvc-v1' }
    }
  } finally {
    job.artifacts.cleanJob(job.artifactDir, job.output, complete)
  }
}
