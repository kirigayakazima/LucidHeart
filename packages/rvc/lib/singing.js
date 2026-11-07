import { createReadStream, createWriteStream } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const formats = ['m4a', 'mp3', 'wav', 'flac']
const maxBytes = 60 * 1024 * 1024
const auth = { Authorization: 'Bearer xiaoman-pc-bridge-secret-2026' }
const gateway = 'http://127.0.0.1:28765'
const localScript = fileURLToPath(new URL('../vendor/phone/sing-chain.sh', import.meta.url))

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

export async function runPcSong({ source, jobId, pitch, output, signal }) {
  if (source.size > maxBytes) throw new Error('Song exceeds PC upload limit')
  const query = new URLSearchParams({ task: jobId, pitch, format: path.extname(source.file).slice(1).toLowerCase(), heartbeat: 'true' })
  const upload = createReadStream(source.file)
  const stalled = new AbortController()
  const uploadSignal = AbortSignal.any([signal, stalled.signal, AbortSignal.timeout(300_000)])
  let timer
  function refreshDeadline() {
    clearTimeout(timer)
    timer = setTimeout(() => stalled.abort(new Error('PC singing gateway timed out')), 30_000)
  }
  try {
    refreshDeadline()
    const response = await requireResponse(await fetch(`${gateway}/v1/voice/sing?${query}`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.size) },
      body: upload, duplex: 'half', redirect: 'error', signal: uploadSignal,
    }))
    let reply = ''
    refreshDeadline()
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      refreshDeadline()
      reply += chunk
      if (reply.length > 16_384) throw new Error('PC singing response exceeds limit')
    }
    const result = JSON.parse(reply)
    if (result?.ok !== true || result.task !== jobId) throw new Error(result?.error || 'Invalid PC singing result')
  } finally {
    clearTimeout(timer)
    upload.destroy()
  }
  const partial = `${output}.part`
  try {
    const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    const response = await requireResponse(await fetch(`${gateway}/v1/voice/sing/download/${jobId}`, {
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
  } finally {
    await rm(partial, { force: true })
  }
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
  await checkMp3(output)
}

export async function renderSong(job, onFallback) {
  job.artifactDir = job.artifacts.begin(`sing_${job.jobId}`)
  let complete = false
  try {
    try {
      await runPcSong(job)
      complete = true
      return { mode: 'pc_gpu_pipeline' }
    } catch (error) {
      job.signal.throwIfAborted()
      console.warn('[@dsh/rvc] PC 唱歌分流失败:', error.message)
      await onFallback()
      await runLocalSong(job)
      complete = true
      return { mode: 'phone_onnx_fallback', profileId: 'feiyu-rvc-v1' }
    }
  } finally {
    job.artifacts.cleanJob(job.artifactDir, job.output, complete)
  }
}
