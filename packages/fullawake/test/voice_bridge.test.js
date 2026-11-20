import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { FullAwakeBridgeClient } from '../lib/bridge-client.js'
import { apply } from '../lib/index.js'
import { apply as applyDuplex } from '../../voice-duplex/lib/index.js'
import { apply as applyMemory, loadLastHandoff } from '../../memory/lib/index.js'

async function gateway(t) {
  let checks = 0
  const server = createServer(async (request, response) => {
    if (request.url !== '/mcp') {
      response.end(JSON.stringify({ online: true, voice_calls: ++checks >= 2 }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const summary = { status: 'playing', widgetOnline: true, watchSessionId: 'desktop-12345678', timelineId: 'desktop-fixture',
      playbackPositionSec: 1, watchedInterval: [0, 1], frameCount: 0, timecodes: [], tokenCost: 0, subtitles: [] }
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(summary) }] } }))
  })
  const sockets = new WebSocketServer({ server, path: '/ws/bridge' })
  const connected = Promise.withResolvers()
  sockets.on('connection', socket => {
    let send, seq = 0
    const speech = Promise.withResolvers(), calls = [], replies = []
    socket.on('message', raw => {
      const { type, payload, ...identity } = JSON.parse(raw)
      send = (type, payload) => socket.send(JSON.stringify({ ...identity, type, commandSeq: ++seq, payload }))
      if (type === 'session.handshake') {
        send('session.handshake_ack', { status: 'ready', initialEpoch: 100, vadSupported: false, turnLifecycle: true })
        connected.resolve({ speech: speech.promise, calls, replies, send: (type, payload) => send(type, payload) })
      }
      if (type === 'audio.prepare') send('audio.prepared', { epoch: payload.epoch, utteranceId: payload.utteranceId })
      if (type === 'audio.speak') speech.resolve(payload)
      if (['call.state', 'watch.state'].includes(type)) replies.push([type, payload])
      if (type === 'voice.call') {
        calls.push(payload.active)
        send('voice.call.status', { requestId: payload.requestId, active: payload.active })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate()
    await new Promise(resolve => sockets.close(resolve))
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  })
  return { url: `http://127.0.0.1:${server.address().port}`, connected: connected.promise }
}

for (const mode of ['estimate', 'wav', 'unconfirmed', 'zero']) {
  test(`interrupt repair uses ${mode} playback and is consumed once by its owner`, { timeout: 5000 }, async t => {
    const pc = await gateway(t)
    const client = new FullAwakeBridgeClient(pc.url.replace('http:', 'ws:') + '/ws/bridge', 'test')
    t.after(() => client.stop())
    const ready = once(client, 'ready')
    client.connect()
    const control = await pc.connected
    await ready
    const handle = client.begin({ agentId: 'owner' })
    await handle.prepared
    const words = '一二😀四五六'
    if (mode === 'wav') {
      const wav = Buffer.alloc(44 + 16000 * 2)
      wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
      wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32)
      wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(32000, 40)
      assert.ok(client.playAudio({ text: words, audio: wav }, handle))
    } else assert.ok(client.speak({ text: words }, handle))
    const interrupted = once(client, 'interrupt')
    control.send('audio.interrupt', { abortedEpoch: handle.epoch, utteranceId: handle.utteranceId,
      reason: 'near_end_speech', localAudioStopped: mode !== 'unconfirmed', elapsedAudioMs: mode === 'zero' ? 0 : 480 })
    await interrupted
    assert.equal(handle.signal.reason, 'user_interrupt')
    assert.equal(client.consumeLastInterrupt('another'), null)
    const count = mode === 'wav' ? 3 : mode === 'zero' ? 0 : 2
    assert.deepEqual(client.consumeLastInterrupt('owner'), mode === 'unconfirmed' ? null : {
      spokenText: [...words].slice(0, count).join(''), remainingText: [...words].slice(count).join(''),
    })
    assert.equal(client.consumeLastInterrupt('owner'), null)
  })
}

test('the next claimed user turn receives the repair clue with the QQ quotation offset preserved', { timeout: 5000 }, async t => {
  const pc = await gateway(t)
  const handlers = new Map(), tools = new Map(), disposers = []
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    get(name) { if (name === 'heart') return { evaluateActivity: () => ({ suitable: true }), observe() {} } },
    on(event, callback) { handlers.set(event, callback) },
    effect(callback) { disposers.push(callback()) },
  }
  t.after(() => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose() })
  apply(ctx, { gatewayUrl: pc.url, voiceEpochProtocol: true, duplexTarget: 'owner' })
  const control = await pc.connected
  await delay(20)
  const execution = { agent: { id: 'owner' }, signal: new AbortController().signal }
  const speaking = tools.get('pc_duplex_speak').execute({ text: '一二三四五六' }, execution)
  const payload = await control.speech
  control.send('audio.interrupt', { abortedEpoch: payload.epoch, utteranceId: payload.utteranceId, reason: 'near_end_speech',
    localAudioStopped: true, elapsedAudioMs: 480 })
  assert.match((await speaking).message, /interrupted/)
  const message = () => ({ role: 'user', source: { kind: 'user', qq: { start: 0, length: 4 } },
    content: [{ type: 'text', text: '等一下呀' }] })
  const claim = (id, message) => handlers.get('agent/inbox/claimed')({ agent: { id }, message })
  const other = message()
  claim('other', other)
  assert.equal(other.content[0].text, '等一下呀')
  const repaired = message()
  claim('owner', repaired)
  assert.match(repaired.content[0].text, /已说出「一二」.*未说完「三四五六」/u)
  assert.equal(repaired.content[0].text.slice(repaired.source.qq.start, repaired.source.qq.start + 4), '等一下呀')
  const next = message()
  claim('owner', next)
  assert.equal(next.source.qq.start, 0)
})

for (const initiator of ['qq', 'desktop']) test(`FullAwake ${initiator} call carries ASR finals and flushes on hangup`, { timeout: 5000 }, async t => {
  const pc = await gateway(t)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullawake-call-'))
  const services = new Map(), tools = new Map(), handlers = new Map(), disposers = []
  const emit = (type, ...args) => { for (const handler of handlers.get(type) ?? []) handler(...args) }
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool) } },
    get: name => services.get(name), provide: (name, value) => services.set(name, value),
    on(type, handler) {
      if (!handlers.has(type)) handlers.set(type, new Set())
      handlers.get(type).add(handler)
      return () => handlers.get(type).delete(handler)
    },
    effect(fn) { disposers.push(fn()) },
  }
  applyMemory(ctx, { dataDir: root, scope: 'xiaoman_private' })
  disposers.push(applyDuplex(ctx))
  const accepted = Promise.withResolvers()
  const session = { id: 'pc', events: [] }
  const agent = { id: 'pc', session, followup(message) {
    for (const event of [{ type: 'turn/start' }, { type: 'user/message', data: message },
      { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '记得一起看电影。' }] } }, { type: 'turn/end' }]) {
      session.events.push(event)
      emit('session/event', session, event)
    }
    accepted.resolve(message)
  } }
  services.set('agents', { get: () => agent })
  services.set('heart', { evaluateActivity: () => ({ suitable: true }), observe() {} })
  services.set('llm', { async *stream() {} })
  services.set('attachments', { saveImage() {} })
  apply(ctx, { gatewayUrl: pc.url, voiceEpochProtocol: true, duplexTarget: 'pc' })
  t.after(() => {
    for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const control = await pc.connected
  await delay(20)
  if (initiator === 'desktop') {
    control.send('pc.call_request', { requestId: 'call-start', enabled: true, source: 'pc_desktop_app' })
    for (let i = 0; i < 100 && !control.replies.length; i++) await delay(10)
    assert.deepEqual(control.replies[0], ['call.state', { requestId: 'call-start', active: true, accepted: true }])
    control.send('pc.watch_request', { requestId: 'watch-start', action: 'start', mode: 'desktop', targetLabel: '外接屏' })
    for (let i = 0; i < 100 && control.replies.length < 2; i++) await delay(10)
    assert.deepEqual(control.replies[1], ['watch.state', { requestId: 'watch-start', active: true, accepted: true }])
    control.send('pc.watch_request', { requestId: 'watch-stop', action: 'stop', mode: 'desktop', targetLabel: '外接屏' })
    for (let i = 0; i < 100 && control.replies.length < 3; i++) await delay(10)
    assert.deepEqual(control.replies[2], ['watch.state', { requestId: 'watch-stop', active: false, accepted: true }])
  } else {
    session.events.push({ type: 'turn/start', data: { turn: 0 } },
      { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '开启通话' }], source: { kind: 'user' } } },
      { type: 'tool/call', data: { turn: 0, callId: 'call' } })
    const reply = await tools.get('voice_call_toggle').execute({ enabled: true }, { agent, callId: 'call' })
    assert.match(reply.message, /已开启/)
  }
  const speaking = tools.get('pc_duplex_speak').execute({ text: '一二三四五六' },
    { agent, signal: new AbortController().signal })
  const spoken = await control.speech
  control.send('audio.interrupt', { abortedEpoch: spoken.epoch, utteranceId: spoken.utteranceId,
    reason: 'near_end_speech', localAudioStopped: true, elapsedAudioMs: 480 })
  assert.match((await speaking).message, /interrupted/)
  control.send('audio.capture', { turnId: 'first', audio_epoch: 7 })
  control.send('audio.transcript', { turnId: 'first', audio_epoch: 7, text: '一起看电影', is_final: false })
  control.send('audio.transcript', { turnId: 'first', audio_epoch: 7, text: '一起看电影', is_final: true })
  assert.equal((await accepted.promise).source.kind, 'user')
  const next = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '一起看电影' }] }
  emit('agent/inbox/claimed', { agent, message: next })
  assert.match(next.content[0].text, /已说出「一二」.*未说完「三四五六」/u)
  if (initiator === 'desktop') {
    control.send('pc.call_request', { requestId: 'call-stop', enabled: false, source: 'pc_desktop_app' })
    for (let i = 0; i < 100 && control.replies.length < 4; i++) await delay(10)
    assert.deepEqual(control.replies[3], ['call.state', { requestId: 'call-stop', active: false, accepted: true }])
  } else {
    control.send('audio.capture', { turnId: 'end', audio_epoch: 8 })
    control.send('audio.transcript', { turnId: 'end', audio_epoch: 8, text: '先挂了', is_final: true })
  }
  for (let i = 0; i < 50 && control.calls.length < 2; i++) await delay(10)
  assert.deepEqual(control.calls, [true, false])
  assert.equal(loadLastHandoff(root).kind, 'voice_call')
  assert.equal(loadLastHandoff(root).lastExchange.user, '一起看电影')
})
