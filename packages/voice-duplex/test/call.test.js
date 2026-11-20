import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { test } from 'node:test'
import { apply as applyDuplex } from '../lib/index.js'
import { apply as applyMemory, loadLastHandoff } from '../../memory/lib/index.js'
import { registerVoiceCall } from '../../fullawake/lib/voice_call.js'

for (const ending of ['tool', 'speech', 'disconnect']) {
  test(`call ${ending} flushes real exchanges and resumes the owner's QQ conversation once`, async t => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'duplex-handoff-'))
    const handlers = new Map(), services = new Map(), tools = new Map(), disposers = []
    const emit = (name, ...args) => { for (const callback of handlers.get(name) ?? []) callback(...args) }
    const ctx = {
      tools: { register(tool) { tools.set(tool.name, tool) } },
      on(name, callback) {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name).add(callback)
        return () => handlers.get(name).delete(callback)
      },
      get: name => services.get(name),
      provide(name, value) { services.set(name, value) },
      effect(callback) { disposers.push(callback()) },
    }
    applyMemory(ctx, { dataDir, scope: 'xiaoman_private' })
    let allowCall = false
    services.set('heart', { evaluateActivity: () => ({ suitable: allowCall }) })
    disposers.push(applyDuplex(ctx))
    const session = { id: 'pc', events: [] }
    let followups = 0
    const agent = { id: 'pc', session, followup(message) {
      followups++
      for (const event of [{ type: 'turn/start' }, { type: 'user/message', data: message },
        { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: `回应${followups}` }] } },
        { type: 'turn/end' }]) {
        session.events.push(event)
        emit('session/event', session, event)
      }
    } }
    services.set('agents', { get: id => id === 'pc' ? agent : undefined })
    const bridge = new EventEmitter()
    const switches = []
    Object.assign(bridge, { turnLifecycle: true, cancelCurrent() {},
      async setCallActive(active) { switches.push(active); return { active } } })
    disposers.push(registerVoiceCall(ctx, { duplexTarget: 'pc', duplexQqSessions: ['owner'] },
      { bridge, defineTool: tool => tool, output: {}, readyForCall: async () => true }))
    t.after(() => {
      for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
      fs.rmSync(dataDir, { recursive: true, force: true })
    })
    const execute = (text, enabled, channel = 'direct') => {
      const message = { role: 'user', source: { kind: 'user', qq: {
        channel, speaker: 'owner', targetId: 'owner', speakerId: 'owner', start: 0, length: text.length,
      } },
        content: [{ type: 'text', text }] }
      return tools.get('voice_call_toggle').execute({ enabled }, { agent: { id: 'owner', session: { id: 'owner', events: [
        { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: message },
        { type: 'tool/call', data: { turn: 1, callId: 'call' } },
      ] } }, callId: 'call' })
    }
    await execute('开启通话', true, 'group')
    assert.match((await execute('开启通话', true)).message, /Heart/)
    assert.deepEqual(switches, [])
    allowCall = true
    assert.match((await execute('小满，开启通话', true)).message, /已开启/)
    const send = async (turn, text) => {
      bridge.emit('capture', { turnId: `turn-${turn}`, audio_epoch: turn })
      bridge.emit('transcript', { turnId: `turn-${turn}`, audio_epoch: turn, text: '草稿', is_final: false })
      await setImmediate()
      assert.equal(followups, turn - 1)
      bridge.emit('transcript', { turnId: `turn-${turn}`, audio_epoch: turn, text, is_final: true })
      await setImmediate()
    }
    for (let i = 1; i <= 3; i++) await send(i, `通话话题${i}`)
    const journal = path.join(dataDir, 'journal.jsonl')
    const before = fs.existsSync(journal) ? fs.readFileSync(journal) : null
    if (ending === 'tool') await execute('先挂了', false)
    else if (ending === 'disconnect') bridge.emit('disconnected')
    else {
      bridge.emit('capture', { turnId: 'end', audio_epoch: 4 })
      bridge.emit('transcript', { turnId: 'end', audio_epoch: 4, text: '先挂了', is_final: true })
      await setImmediate()
    }
    assert.equal(followups, 3)
    const handoff = loadLastHandoff(dataDir, { channel: 'direct', scope: 'xiaoman_private', targetId: 'owner', speaker: 'owner' })
    assert.equal(handoff.kind, 'voice_call')
    assert.equal(handoff.lastExchange.user, '通话话题1 / 通话话题2 / 通话话题3')
    assert.equal(handoff.lastExchange.assistant, '回应1 / 回应2 / 回应3')
    assert.deepEqual(fs.existsSync(journal) ? fs.readFileSync(journal) : null, before)
    const message = { role: 'user', source: { kind: 'user', qq: {
      channel: 'direct', speaker: 'owner', targetId: 'owner', speakerId: 'owner', start: 0, length: 4,
    } },
      content: [{ type: 'text', text: '继续聊呀' }] }
    const qq = { id: 'owner', session: { id: 'owner', messages: [{ role: 'user' }, { role: 'user' }] } }
    emit('agent/inbox/claimed', { agent: qq, message })
    assert.match(message.content[0].text, /近期工作记忆[\s\S]*通话话题3/)
    assert.equal(message.content[0].text.slice(message.source.qq.start, message.source.qq.start + 4), '继续聊呀')
    const next = { ...message, source: { kind: 'user', qq: { ...message.source.qq, start: 0 } }, content: [{ type: 'text', text: '继续聊呀' }] }
    emit('agent/inbox/claimed', { agent: qq, message: next })
    assert.equal(next.source.qq.start, 0)
    bridge.emit('capture', { turnId: 'late', audio_epoch: 5 })
    bridge.emit('transcript', { turnId: 'late', audio_epoch: 5, text: '迟到定稿', is_final: true })
    await setImmediate()
    assert.equal(followups, 3)
    if (ending !== 'disconnect') assert.equal(switches.at(-1), false)
  })
}
