// Explicit opt-in: execute the same CPU ONNX worker on Windows and the phone.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

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

export async function runProfileSpeak({ voiceProfile, profilePython, text, acoustic, outWav, signal }) {
  const filename = path.resolve(voiceProfile)
  const profile = readVoiceProfile(filename)
  const output = outWav || path.join(os.homedir(), '.dsh', 'audio', `voice_profile_${randomUUID()}.wav`)
  const python = profilePython || (process.platform === 'win32' ? 'python' : 'python3')
  const args = [worker, '--profile', filename, '--text', text, '--output', path.resolve(output)]
  const result = await new Promise((resolve, reject) => {
    const env = profile.pythonPath
      ? { ...process.env, PYTHONPATH: [profile.pythonPath, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) }
      : process.env
    const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'], signal, windowsHide: true, env })
    let stdout = '', stderr = ''
    proc.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-1024 * 1024) })
    proc.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384) })
    proc.on('error', reject)
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`Voice profile worker failed (${code}): ${stderr.slice(-3000)}`))
      try {
        const line = stdout.trim().split(/\r?\n/).at(-1)
        const value = JSON.parse(line)
        if (!value.ok || !fs.existsSync(output) || value.profileId !== profile.id) throw new Error('Invalid worker result')
        resolve(value)
      } catch (error) { reject(new Error(`Voice profile output validation failed: ${error.message}`)) }
    })
  })
  return { ok: true, audioPath: path.resolve(output), durationMs: result.elapsedTotalMs,
    mode: result.mode, profileId: profile.id, validation: result,
    acoustic: { ...acoustic, pitch: result.pitch, brightness: result.brightness,
      rate: result.ttsRate || '+0%', intonationScale: result.intonationScale ?? 1 } }
}
