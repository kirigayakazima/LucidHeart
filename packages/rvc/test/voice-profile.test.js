import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readVoiceProfile } from '../lib/voice-profile.js'
import { runSpeak } from '../lib/runner.js'

test('profile selection rejects unrelated TTS checkpoints and invalid pitch', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-voice-profile-'))
  const filename = path.join(root, 'profile.json')
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(root).startsWith('lucid-voice-profile-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.writeFileSync(filename, JSON.stringify({ engine: 'cosyvoice3' }))
  assert.throws(() => readVoiceProfile(filename), /CosyVoice/)
  const profile = { schema: 'lucidheart-voice-profile-v1', id: 'candidate', engine: 'rvc-onnx',
    modelsDir: '.', index: 'voice.mobile.index', assets: {}, pitch: -2 }
  fs.writeFileSync(filename, JSON.stringify(profile))
  assert.throws(() => readVoiceProfile(filename), /invalid/)
  profile.pitch = 0
  fs.writeFileSync(filename, JSON.stringify(profile))
  assert.equal(readVoiceProfile(filename).id, 'candidate')
})

test('an explicit voice profile cannot silently fall back to mock or Dv5', async () => {
  await assert.rejects(runSpeak({ voiceProfile: 'missing.json', mock: true }), /real worker/)
  await assert.rejects(runSpeak({ voiceProfile: 'missing.json', text: 'test' }), /ENOENT/)
  const original = await runSpeak({ mock: true, acoustic: { pitch: 0 } })
  assert.equal(original.mode, 'mock')
})
