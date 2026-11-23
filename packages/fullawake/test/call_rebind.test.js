import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { registerVoiceCall } from '../lib/voice_call.js'
import { apply } from '../../voice-duplex/lib/index.js'

test('after an agent rebuild, only its new session can own the spoken reply', async t => {
  const ctx = new EventEmitter()
  ctx.tools = { register() {} }
  ctx.provide = (key, value) => { ctx[key] = value }
  ctx.memory = { handoff: { saveCall() {} } }
  const warnings = []
  ctx.logger = { warn: value => warnings.push(value) }
  const original = { id: 'owner', session: { id: 'owner', events: [] }, followup: assert.fail }
  let active = original
  ctx.agents = { get: id => id === 'owner' ? active : null }
  const bridge = Object.assign(new EventEmitter(), {
    turnLifecycle: true, cancelCurrent() {}, setCallActive: async active => ({ active }),
    replyDesktop() {},
  })
  const spoken = []
  const unload = apply(ctx)
  const stop = registerVoiceCall(ctx, { duplexTarget: 'owner' }, { bridge, defineTool: tool => tool,
    readyForCall: () => true, canSpeak: () => true, speak: (text, { agent }) => spoken.push([text, agent]) })
  t.after(() => { stop(); unload() })
  bridge.emit('pc-call-request', { enabled: true, requestId: 'open' })
  await setImmediate()
  const session = { id: 'owner', events: [{ type: 'turn/start', data: { turn: 2 } }] }
  active = { id: 'owner', session, followup(message) {
    ctx.emit('session/event', session, { type: 'user/message', data: message })
    ctx.emit('session/event', session, { type: 'assistant/message', data: { content: [{ type: 'text', text: '听到了' }] } })
    ctx.emit('session/event', session, { type: 'turn/end' })
  } }
  const capture = { audio_epoch: 3, turnId: 'new' }
  bridge.emit('capture', capture)
  bridge.emit('transcript', { ...capture, text: '在吗', is_final: true })
  await setImmediate()
  assert.deepEqual(spoken, [['听到了', active]])
  bridge.emit('transcript', { ...capture, text: '重复', is_final: true })
  await setImmediate()
  assert.equal(warnings.filter(line => line.includes('转写未投递')).length, 1)
})
