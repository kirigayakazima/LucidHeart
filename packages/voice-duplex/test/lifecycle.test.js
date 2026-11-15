import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AudioLifecycle } from '../lib/lifecycle.js'
import { DuplexSession, FRAME_BYTES } from '../lib/session.js'
import { apply } from '../lib/index.js'

test('epoch advances before pending callbacks observe cancellation', () => {
  const life = new AudioLifecycle()
  const previous = life.capture()
  let seen
  previous.signal.addEventListener('abort', () => { seen = life.epoch })
  assert.equal(life.advance('stop').audio_epoch, 1)
  assert.equal(seen, 1)
  assert.equal(life.accepts(previous.audio_epoch), false)
})

test('intentional stop revokes but natural end preserves the epoch', () => {
  const session = new DuplexSession()
  const { client, epoch } = session.connect(0)
  session.play(client, epoch, 'first', 1)
  assert.equal(session.stop(client, epoch, 'first', true).epoch, epoch)
  session.play(client, epoch, 'second', 2)
  assert.equal(session.stop(client, epoch, 'second').epoch, epoch + 1)
  assert.equal(session.accepts(client, epoch, 0, 3), false)
})

test('speech opens a new epoch with no playback lease', () => {
  const session = new DuplexSession()
  const input = session.connect(0)
  const event = session.feed({ ...input, sequence: 0, pcm: Buffer.alloc(FRAME_BYTES), probability: .55 }, 32)
  assert.equal(event.epoch, input.epoch + 1)
  assert.equal(event.interrupt, null)
})

test('host cancellation invalidates the in-flight desktop transcript', async () => {
  let service, cancel
  const messages = []
  const dispose = apply({ provide: (_, value) => { service = value }, on: (_, handler) => { cancel = handler } })
  const agent = { id: 'host', followup: message => messages.push(message) }
  const capture = service.remote(agent)
  capture.open({ audio_epoch: 2, turnId: 'old' })
  cancel({ agent })
  assert.equal(await capture.receive({ audio_epoch: 2, turnId: 'old', is_final: true, text: 'old' }), false)
  capture.open({ audio_epoch: 3, turnId: 'next' })
  assert.equal(await capture.receive({ audio_epoch: 3, turnId: 'next', is_final: true, text: 'next' }), true)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].text, 'next')
  dispose()
})
