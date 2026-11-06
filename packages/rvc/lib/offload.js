import fs from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { DRY_SAMPLE_RATE, VOICE_SAMPLE_RATE, joinVoiceChunks, planVoiceChunks, readPcm16, writePcm16 } from './acoustic.js'

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

function validateOffloadAudio(result, contract) {
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
  return data
}

function offloadResult(result, contract, output) {
  return { ok: true, audioPath: output, mode: result.mode, durationMs: result.durationMs,
    profileId: contract.id, acoustic: result.acoustic, offload: { attempted: true, status: 'completed', provider: result.provider } }
}

export function saveOffloadAudio(result, contract, outWav) {
  const data = validateOffloadAudio(result, contract)
  const output = outWav || path.join(os.homedir(), '.dsh', 'audio', `pc_voice_${randomUUID()}.wav`)
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, data, { flag: 'wx', mode: 0o600 })
  return offloadResult(result, contract, output)
}

export async function offloadDryVoice({ dryWav, punctuationSeconds, bridge, contract, signal, outWav }) {
  const started = Date.now()
  const dry = readPcm16(dryWav, DRY_SAMPLE_RATE)
  const spans = planVoiceChunks(dry, punctuationSeconds)
  const converted = new Array(spans.length)
  const controller = new AbortController()
  const workSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  let cursor = 0
  let firstResult
  let failure
  async function convert() {
    while (!workSignal.aborted && cursor < spans.length) {
      const index = cursor++
      const { contextStart, contextEnd } = spans[index]
      // HuBERT loses a few frames at the edge. Discard the extra padding after inference.
      const padded = new Int16Array(contextEnd - contextStart + 640)
      padded.set(dry.subarray(contextStart, contextEnd))
      try {
        const result = await bridge.callPcRvc({
          audioBase64: writePcm16(padded, DRY_SAMPLE_RATE).toString('base64'), voice: contract, signal: workSignal,
        })
        const data = validateOffloadAudio(result, contract)
        if (spans.length > 1 && result.provider !== 'CUDAExecutionProvider') throw new Error('PC CUDA is unavailable')
        converted[index] = readPcm16(data, VOICE_SAMPLE_RATE)
        firstResult ??= result
      } catch (error) {
        failure ??= error
        controller.abort(error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(spans.length, 2) }, convert))
  signal?.throwIfAborted()
  if (failure) throw failure
  const samples = joinVoiceChunks(spans, converted)
  const output = outWav || path.join(os.homedir(), '.dsh', 'audio', `pc_voice_${randomUUID()}.wav`)
  await mkdir(path.dirname(output), { recursive: true })
  signal?.throwIfAborted()
  await writeFile(output, writePcm16(samples, VOICE_SAMPLE_RATE), { flag: 'wx', mode: 0o600 })
  const result = offloadResult(firstResult, contract, output)
  return { ...result, durationMs: Date.now() - started,
    acoustic: { pitch: contract.settings.pitch, brightness: contract.settings.brightness, rate: contract.settings.ttsRate },
    offload: { ...result.offload, chunks: spans.length } }
}
