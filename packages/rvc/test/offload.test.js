import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { voiceContract, saveOffloadAudio } from '../lib/offload.js'
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
})
