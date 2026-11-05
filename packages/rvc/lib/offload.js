import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'

const defaults = { pitch: 0, brightness: 0, indexMethod: 'cosine1', indexRatio: .3,
  protect: .33, ttsVoice: 'zh-CN-XiaoxiaoNeural', ttsRate: '+0%', synthesisMode: 'chunked',
  noiseScale: 1, intonationScale: 1 }

export function voiceContract(profile) {
  const assets = {}
  for (const name of ['model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index']) {
    const sha = profile.assets?.[name]?.sha256
    if (!/^[a-f0-9]{64}$/i.test(sha || '')) throw new Error('Incomplete voice assets for PC offload')
    assets[name] = sha
  }
  return { id: profile.id, assets,
    settings: Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, profile[key] ?? value])) }
}

export function saveOffloadAudio(result, contract, outWav) {
  if (!result?.ok || result.voiceId !== contract.id || result.mode !== 'pc_onnx_offload'
    || !['CPUExecutionProvider', 'CUDAExecutionProvider'].includes(result.provider) || result.sampleRate !== 40000) throw new Error('Invalid PC voice result')
  for (const [name, sha] of Object.entries(contract.assets)) {
    if (result.assets?.[name] !== sha) throw new Error('PC voice model mismatch')
  }
  for (const [key, value] of Object.entries(contract.settings)) {
    if (result.settings?.[key] !== value) throw new Error('PC voice settings mismatch')
  }
  if (typeof result.audioBase64 !== 'string' || result.audioBase64.length > 11184812
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(result.audioBase64)) throw new Error('Invalid PC audio encoding')
  const data = Buffer.from(result.audioBase64, 'base64')
  if (data.length <= 44 || data.length > 8388608 || data.toString('ascii', 0, 4) !== 'RIFF'
    || data.toString('ascii', 8, 12) !== 'WAVE'
    || createHash('sha256').update(data).digest('hex') !== result.sha256) throw new Error('PC audio checksum/format mismatch')
  const output = outWav || path.join(os.homedir(), '.dsh', 'audio', `pc_voice_${randomUUID()}.wav`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, data, { flag: 'wx', mode: 0o600 })
  return { ok: true, audioPath: output, mode: result.mode, durationMs: result.durationMs,
    profileId: contract.id, acoustic: result.acoustic, offload: { attempted: true, status: 'completed', provider: result.provider } }
}
