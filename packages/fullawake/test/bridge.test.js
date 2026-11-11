import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test } from 'node:test'
import { WebSocketServer } from 'ws'
import { FullAwakeBridgeClient } from '../lib/bridge-client.js'

const TOKEN = 'bridge-test-only'
const waitEvent = (emitter, name) => once(emitter, name, { signal: AbortSignal.timeout(3000) })

async function fixture(t, initialEpoch = 100) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/ws/bridge' })
  await waitEvent(server, 'listening')
  const client = new FullAwakeBridgeClient(`ws://127.0.0.1:${server.address().port}/ws/bridge`, TOKEN, { retryMs: 20 })
  t.after(async () => {
    client.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise(resolve => server.close(resolve))
  })

  async function session(open = () => {}) {
    const connected = waitEvent(server, 'connection')
    open()
    const [socket, request] = await connected
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(request.headers.origin, undefined)
    const next = async () => JSON.parse((await waitEvent(socket, 'message'))[0])
    const hello = await next()
    assert.deepEqual(Object.keys(hello).sort(), ['commandSeq', 'connectionId', 'payload', 'protocol', 'sessionId', 'type'])
    assert.equal(hello.type, 'session.handshake')
    assert.equal(hello.protocol, 'lucid.voice/1')
    assert.equal(hello.commandSeq, 1)
    assert.match(hello.sessionId, /^watch-session-/)
    assert.match(hello.connectionId, /^conn-[0-9a-f-]{36}$/)
    assert.deepEqual(hello.payload, { clientVersion: '0.2.7', heartVersion: '0.21.3', device: 'redmi-note12turbo' })
    let seq = 0
    const send = (type, payload, overrides) => socket.send(JSON.stringify({ protocol: hello.protocol, type,
      sessionId: hello.sessionId, connectionId: hello.connectionId, commandSeq: ++seq, payload, ...overrides }))
    const ready = waitEvent(client, 'ready')
    send('session.handshake_ack', { status: 'ready', gatewayVersion: '0.2.5', initialEpoch, vadSupported: true, turnLifecycle: true })
    await ready
    return { socket, hello, next, send }
  }
  return { client, session }
}

test('native WebSocket sends bearer and monotonic speak, interrupt and ACK frames', { timeout: 5000 }, async t => {
  const { client, session } = await fixture(t)
  const { hello, next, send } = await session(() => client.connect())
  const speaking = next()
  const handle = client.speak({ text: '我在' })
  assert.deepEqual(await speaking, { protocol: 'lucid.voice/1', type: 'audio.speak',
    sessionId: client.sessionId, connectionId: hello.connectionId, commandSeq: 2,
    payload: { epoch: 101, utteranceId: handle.utteranceId, text: '我在', voiceProfile: 'feiyu-rvc-v1',
      pitchShift: -4, deadlineMs: 4000 } })
  const interrupt = { abortedEpoch: 101, utteranceId: handle.utteranceId,
    reason: 'near_end_speech', localAudioStopped: true, elapsedAudioMs: 1420 }
  const observed = waitEvent(client, 'interrupt')
  const ack = next()
  send('audio.interrupt', { ...interrupt, utteranceId: 'old-utterance' })
  send('audio.interrupt', interrupt)
  assert.deepEqual(await observed, [interrupt])
  assert.equal(handle.signal.reason, 'user_interrupt')
  assert.deepEqual(await handle.done, { status: 'interrupted' })
  assert.deepEqual(await ack, { protocol: 'lucid.voice/1', type: 'audio.interrupt_ack',
    sessionId: client.sessionId, connectionId: hello.connectionId, commandSeq: 3,
    payload: { abortedEpoch: 101, currentEpoch: 102 } })
  const fresh = next()
  client.speak({ text: '下一句' })
  assert.equal((await fresh).payload.epoch, 103)
})

test('disconnect aborts the pending lease and reconnects with new connection ID and fresh sequence', { timeout: 5000 }, async t => {
  const { client, session } = await fixture(t)
  const first = await session(() => client.connect())
  const preparing = first.next()
  const handle = client.begin()
  const { payload } = await preparing
  assert.deepEqual(payload, { epoch: 101, utteranceId: handle.utteranceId })
  first.send('audio.prepared', payload)
  assert.equal(await handle.prepared, true)
  const reconnected = session(() => first.socket.terminate())
  assert.equal((await handle.done).status, 'cancelled')
  assert.equal(handle.signal.reason, 'bridge_disconnected')
  const second = await reconnected
  assert.notEqual(second.hello.connectionId, first.hello.connectionId)
  assert.equal(second.hello.sessionId, first.hello.sessionId)
  const fresh = second.next()
  client.speak({ text: '重新连接' })
  assert.equal((await fresh).commandSeq, 2)
})

test('strict result shape rejects unknown fields and cannot report playback before speech', { timeout: 5000 }, async t => {
  const { client, session } = await fixture(t)
  const { next, send } = await session(() => client.connect())
  const preparing = next()
  const handle = client.begin()
  const { payload } = await preparing
  send('audio.prepared', payload)
  await handle.prepared
  send('audio.result', { ...payload, status: 'played' })
  send('audio.result', { ...payload, status: 'played', extra: true })
  assert.deepEqual(await handle.done, { status: 'cancelled' })
  assert.equal(handle.signal.reason, 'bridge_disconnected')
})

test('external cancellation sends a correlated audio.cancel', { timeout: 5000 }, async t => {
  const { client, session } = await fixture(t)
  const { next } = await session(() => client.connect())
  const controller = new AbortController()
  const preparing = next()
  const handle = client.begin({ signal: controller.signal })
  const { payload } = await preparing
  const cancelling = next()
  controller.abort('watch_stopped')
  assert.equal(handle.signal.reason, 'watch_stopped')
  assert.deepEqual(await handle.done, { status: 'cancelled' })
  const cancelled = await cancelling
  assert.equal(cancelled.type, 'audio.cancel')
  assert.deepEqual(cancelled.payload, payload)
})
