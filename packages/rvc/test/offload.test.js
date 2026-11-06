import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { voiceContract, saveOffloadAudio, offloadDryVoice } from '../lib/offload.js'
import { readPcm16, writePcm16 } from '../lib/acoustic.js'
import { runSpeak } from '../lib/runner.js'

test('新音色先走PC，校验音色/音频hash后在本机落盘，不使用Windows路径', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-offload-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('rvc-offload-'))
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const assets = Object.fromEntries(['model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index'].map(name => [name, { sha256: 'a'.repeat(64) }]))
  const profile = { schema: 'lucidheart-voice-profile-v1', id: 'feiyu-rvc-v1', engine: 'rvc-onnx', modelsDir: '.', index: 'voice.mobile.index', assets, pitch: 0, synthesisMode: 'continuous', indexMethod: 'l2-8' }
  const profilePath = path.join(dir, 'profile.json')
  fs.writeFileSync(profilePath, JSON.stringify(profile))
  const data = Buffer.alloc(84)
  data.write('RIFF', 0); data.write('WAVE', 8)
  const contract = voiceContract(profile)
  const result = { ok: true, voiceId: contract.id, assets: contract.assets, settings: contract.settings,
    mode: 'pc_onnx_offload', provider: 'CPUExecutionProvider', sampleRate: 40000,
    audioBase64: data.toString('base64'), sha256: createHash('sha256').update(data).digest('hex'),
    acoustic: { pitch: 0, brightness: 0, rate: '+0%' }, audioPath: 'C:/never-use-this.wav' }
  let calls = 0
  const output = path.join(dir, 'returned.wav')
  const res = await runSpeak({ text: '短句', acoustic: {}, voiceProfile: profilePath, outWav: output,
    profilePython: path.join(dir, 'missing-python'),
    offloadBridge: { async callPcRvc(args) { calls++; assert.deepEqual(args.voice, contract); return result } } })
  assert.equal(calls, 1)
  assert.equal(res.mode, 'pc_onnx_offload')
  assert.equal(res.audioPath, output)
  assert.deepEqual(fs.readFileSync(output), data)
  assert.throws(() => saveOffloadAudio({ ...result, sha256: 'bad' }, contract, path.join(dir, 'bad.wav')), /checksum/)
  assert.throws(() => saveOffloadAudio({ ...result, voiceId: 'dv5' }, contract, path.join(dir, 'wrong.wav')), /Invalid/)
  assert.throws(() => saveOffloadAudio({ ...result, settings: { ...contract.settings, pitch: -4 } }, contract, path.join(dir, 'wrong2.wav')), /settings/)
  // Verify CUDAExecutionProvider is accepted
  const cudaResult = saveOffloadAudio({ ...result, provider: 'CUDAExecutionProvider' }, contract, path.join(dir, 'cuda.wav'))
  assert.equal(cudaResult.offload.provider, 'CUDAExecutionProvider')
  // A 20s 40kHz PCM16 reply exceeded the previous 1MiB/base64 limits.
  const long = Buffer.alloc(1600044)
  long.write('RIFF', 0); long.write('WAVE', 8)
  const longResult = { ...result, audioBase64: long.toString('base64'),
    sha256: createHash('sha256').update(long).digest('hex') }
  const saved = saveOffloadAudio(longResult, contract, path.join(dir, 'long.wav'))
  assert.equal(fs.statSync(saved.audioPath).size, long.length)
  const oversized = Buffer.alloc(8388609)
  assert.throws(() => saveOffloadAudio({ ...result, audioBase64: oversized.toString('base64') }, contract, path.join(dir, 'oversized.wav')), /encoding|checksum/)
})

const dry = Int16Array.from({ length: 16_000 * 16 + 3 }, (_, i) => 1000 + Math.floor(i / 16_000))
const dryWav = writePcm16(dry, 16000)
const contract = voiceContract({ id: 'feiyu-rvc-v1', pitch: -4, brightness: 2.8, ttsRate: '+6%',
  assets: Object.fromEntries(['model.onnx', 'hubert.onnx', 'rmvpe.onnx', 'voice.mobile.index']
    .map(name => [name, { sha256: 'a'.repeat(64) }])) })

function gpuReply(audioBase64, provider = 'CUDAExecutionProvider') {
  const input = readPcm16(Buffer.from(audioBase64, 'base64'), 16000)
  const out = Int16Array.from({ length: Math.round(input.length * 2.5) }, (_, i) => input[Math.floor(i / 2.5)])
  const wav = writePcm16(out, 40000)
  return { ok: true, voiceId: contract.id, assets: contract.assets, settings: contract.settings,
    provider, mode: 'pc_onnx_offload', sampleRate: 40000,
    audioBase64: wav.toString('base64'), sha256: createHash('sha256').update(wav).digest('hex') }
}

test('实长语音并发两块，乱序返回按原时间线拼接并保留尾句', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-batch-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const second = Promise.withResolvers()
  const starts = []
  let active = 0
  let maxActive = 0
  const bridge = { async callPcRvc({ audioBase64, voice }) {
    assert.deepEqual(voice, contract)
    const order = starts.length
    starts.push(order)
    maxActive = Math.max(++active, maxActive)
    if (order === 0) await second.promise
    if (order === 1) second.resolve()
    active--
    return gpuReply(audioBase64)
  } }
  const result = await offloadDryVoice({ dryWav, bridge, contract, outWav: path.join(dir, 'out.wav') })
  assert.equal(maxActive, 2)
  assert.equal(result.offload.chunks, 3)
  assert.equal(result.offload.provider, 'CUDAExecutionProvider')
  assert.deepEqual(result.acoustic, { pitch: -4, brightness: 2.8, rate: '+6%' })
  const output = readPcm16(fs.readFileSync(result.audioPath), 40000)
  assert.equal(output.length, Math.round(dry.length * 2.5))
  assert.equal(output[0], dry[0])
  assert.equal(output.at(-1), dry.at(-1))
  assert.ok(output[40000 * 10] > output[40000 * 5])
})

test('一个长语音块失败时取消同批推理且不生成部分音频', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-batch-fail-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const outWav = path.join(dir, 'failed.wav')
  let calls = 0
  let cancelled = false
  const bridge = { async callPcRvc({ audioBase64, signal }) {
    if (++calls === 1) {
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true
        reject(signal.reason)
      }, { once: true }))
    }
    return gpuReply(audioBase64, 'CPUExecutionProvider')
  } }
  await assert.rejects(offloadDryVoice({ dryWav, bridge, contract, outWav }), /CUDA/)
  assert.equal(calls, 2)
  assert.equal(cancelled, true)
  assert.equal(fs.existsSync(outWav), false)
})
