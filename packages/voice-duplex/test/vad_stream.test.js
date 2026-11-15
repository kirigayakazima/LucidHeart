import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AudioLifecycle } from '../lib/lifecycle.js'
import { createTranscriptGate, FRAME_MS, PCM16_BYTES, toFloat32, VadStream } from '../lib/vad_stream.js'

test('PCM16 adapter preserves frame width and signed samples', () => {
  const pcm = Buffer.alloc(PCM16_BYTES)
  pcm.writeInt16LE(-32768)
  assert.equal(toFloat32(pcm).readFloatLE(0), -1)
  assert.equal(toFloat32(pcm).length, 512 * 4)
  assert.throws(() => toFloat32(pcm.subarray(2)), /512/)
})

test('VAD stays open above exit threshold and closes on first complete frame after 200 ms', () => {
  const vad = new VadStream()
  const pcm = Buffer.alloc(PCM16_BYTES)
  assert.equal(vad.feed(pcm, .54).turnId, null)
  const { turnId } = vad.feed(pcm, .55)
  vad.feed(pcm, .35)
  for (let elapsed = FRAME_MS; elapsed < 200; elapsed += FRAME_MS) assert.equal(vad.feed(pcm, .34).complete, null)
  assert.equal(vad.feed(pcm, .34).complete.turnId, turnId)
  assert.equal(vad.listening, false)
})

test('duplicate drafts are UI-only and the post-VAD final creates a complete user message', async () => {
  const life = new AudioLifecycle()
  const drafts = [], finals = []
  const gate = createTranscriptGate(life, { onDraft: event => drafts.push(event), onFinal: message => finals.push(message) })
  const event = { turnId: 'turn', audio_epoch: life.epoch, text: ' hello ', is_final: false }
  gate.open(event.turnId, event.audio_epoch)
  await gate.receive(event)
  await gate.receive(event)
  assert.equal(drafts.length, 1)
  assert.equal(await gate.receive({ ...event, is_final: true }), false)
  gate.end(event.turnId)
  assert.equal(await gate.receive({ ...event, is_final: true }), true)
  assert.equal(await gate.receive({ ...event, is_final: true }), false)
  assert.deepEqual(finals[0].source, { kind: 'user' })
  assert.deepEqual(finals[0].content, [{ type: 'text', text: 'hello' }])
  assert.match(finals[0].id, /^[a-f0-9-]{36}$/)
})
