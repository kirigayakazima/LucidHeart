// Explicit opt-in: execute the same CPU ONNX worker on Windows and the phone.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { addAbortListener } from 'node:events'

const worker = fileURLToPath(new URL('../scripts/voice_profile_speak.py', import.meta.url))

export function readVoiceProfile(filename) {
  const profile = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''))
  if (profile.schema !== 'lucidheart-voice-profile-v1' || profile.engine !== 'rvc-onnx') {
    throw new Error('Unsupported voice profile: expected rvc-onnx; CosyVoice requires a separate TTS provider')
  }
  if (!profile.id || !profile.modelsDir || !profile.index || !profile.assets || ![0, -4].includes(profile.pitch)) {
    throw new Error('Incomplete or invalid voice profile')
  }
  return profile
}

async function runWorker({ voiceProfile, profilePython, text, acoustic, outWav, signal, input, dryOnly, provider }) {
  const filename = path.resolve(voiceProfile)
  const profile = readVoiceProfile(filename)
  const output = outWav || path.join(os.homedir(), '.dsh', 'audio', `voice_profile_${randomUUID()}.wav`)
  const python = profilePython || (process.platform === 'win32' ? 'python' : 'python3')
  const args = [worker, '--profile', filename, '--output', path.resolve(output)]
  if (input) args.push('--input', input)
  else args.push('--text', text)
  if (!input && acoustic?.rate !== undefined) args.push(`--rate=${acoustic.rate}`)
  if (acoustic?.pitch !== undefined) args.push('--pitch', String(acoustic.pitch))
  if (acoustic?.brightness !== undefined) args.push('--brightness', String(acoustic.brightness))
  if (dryOnly) args.push('--dry-only')
  if (provider) args.push('--provider', provider)
  const result = await new Promise((resolve, reject) => {
    signal?.throwIfAborted()
    const env = profile.pythonPath
      ? { ...process.env, PYTHONPATH: [profile.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      : process.env
    const grouped = process.platform === 'linux'
    const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: grouped, windowsHide: true, env })
    const abort = signal && addAbortListener(signal, () => {
      if (!proc.pid) return
      try { grouped ? process.kill(-proc.pid, 'SIGKILL') : proc.kill() } catch {}
    })
    let stdout = '', stderr = ''
    proc.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024) })
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384) })
    let processError
    proc.on('error', error => { processError = error })
    proc.on('close', code => {
      abort?.[Symbol.dispose]()
      if (signal?.aborted) return reject(signal.reason)
      if (processError) return reject(processError)
      if (code !== 0) return reject(new Error(`Voice profile worker failed (${code}): ${stderr.slice(-3000)}`))
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1)
        const value = JSON.parse(line)
        if (!value.ok || !fs.existsSync(output) || value.profileId !== profile.id) throw new Error('Invalid worker result')
        resolve(value)
      } catch (error) { reject(new Error(`Voice profile output validation failed: ${error.message}`)) }
    })
  })
  return { output, result, profile }
}

export async function renderDryVoice(params) {
  const { result } = await runWorker({ ...params, dryOnly: true })
  return result.punctuationSeconds
}

export async function runProfileSpeak(params) {
  const { output, result, profile } = await runWorker(params)
  return { ok: true, audioPath: path.resolve(output), durationMs: result.elapsedTotalMs,
    mode: result.mode, profileId: profile.id, validation: result,
    acoustic: { ...params.acoustic, pitch: result.pitch, brightness: result.brightness,
      rate: result.ttsRate ?? params.acoustic?.rate ?? profile.ttsRate ?? '+0%',
      intonationScale: result.intonationScale ?? 1 } }
}
