import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { ActiveTargetStore } from '../lib/active_target.js'
import { HomeProjection } from '../lib/home_projection.js'

const start = Date.parse('2026-11-21T16:50:00Z')

function setup(t) {
  const events = new EventEmitter()
  const bridge = new EventEmitter()
  const sent = []
  const services = {}
  let snapshot = { presence: { status: 'present', secret: 'presence secret' },
    mood: { state: 'cheerful', energy: .78, why: 'private chat' }, token: 'secret token' }
  let at = start
  let scope = null
  let send
  const heart = { getSnapshot: () => snapshot, evaluateActivity() { throw Error('unnecessary activity gate') } }
  const ctx = { on(event, callback) { events.on(event, callback); return () => events.off(event, callback) },
    get(name) { return name === 'heart' ? heart : services[name] } }
  const projection = new HomeProjection(ctx, {
    gatewayUrl: 'http://127.0.0.1:28765', authToken: 'unit-token', bridge, now: () => at, privateScope: () => scope,
    send: async (url, options) => {
      sent.push({ url, options, body: JSON.parse(options.body) })
      return send ? send() : { ok: true }
    },
  })
  const stop = projection.start()
  t.after(stop)
  return { events, bridge, sent, services, projection, stop, change(value) { snapshot = value },
    setTime(value) { at = value }, setScope(value) { scope = value }, setSend(value) { send = value } }
}

test('initial snapshot is strictly allowlisted and renews on a real change or reconnect', async t => {
  const h = setup(t)
  await setImmediate()
  const first = h.sent[0]
  assert.equal(first.url, 'http://127.0.0.1:28765/v1/home/snapshot')
  assert.equal(first.options.headers.Authorization, 'Bearer unit-token')
  assert.deepEqual(first.body, {
    schemaVersion: 1, actorId: 'xiaoman', sequence: start, generatedAt: new Date(start).toISOString(),
    expiresAt: new Date(start + 180000).toISOString(), presence: 'present', mood: { state: 'cheerful', energy: .78 },
    activity: { kind: 'idle', label: '', source: 'heart', startedAt: null }, recentAlbum: [],
  })
  h.events.emit('heart/state-changed', { current: { content: 'private event' } })
  await setImmediate()
  assert.equal(h.sent.length, 1)
  h.change({ presence: { status: 'asleep' }, mood: { state: 'tired', energy: .14 } })
  h.events.emit('heart/state-changed')
  await setImmediate()
  assert.equal(h.sent.at(-1).body.presence, 'asleep')
  h.bridge.emit('ready')
  await setImmediate()
  assert.equal(h.sent.length, 3)
  assert.ok(h.sent[2].body.sequence > h.sent[1].body.sequence)
  h.stop()
  h.bridge.emit('ready')
  await setImmediate()
  assert.equal(h.sent.length, 3)
})

test('offline errors are contained and queued changes coalesce behind the in-flight request', async t => {
  const h = setup(t)
  const request = Promise.withResolvers()
  h.setSend(() => request.promise)
  await setImmediate()
  h.change({ presence: 'away' })
  h.events.emit('heart/state-changed')
  h.change({ presence: 'asleep' })
  h.events.emit('heart/state-changed')
  await setImmediate()
  assert.equal(h.sent.length, 1)
  h.setSend(() => ({ ok: true }))
  request.reject(Error('USB disconnected'))
  await setImmediate()
  assert.deepEqual(h.sent.map(request => request.body.presence), ['present', 'asleep'])
  assert.ok(h.sent[1].body.sequence > h.sent[0].body.sequence)
})

test('activity and album stay in verified private scope, without forwarding ledger text', async t => {
  const h = setup(t)
  const task = { kind: 'singing', status: 'processing', expires_at: start + 1000,
    created_at: start, updated_at: start, payload: { title: 'private song title' } }
  let searches = 0
  const album = (kind, sessionId, channel, id, scope = 'xiaoman_private') => ({
    id, kind, scope, title: 'private title', summary: 'private summary', user_quote: 'private quote', source_hash: 'private hash',
    timestamp: new Date(start).toISOString(), revision: 3, source: { sessionId, channel, speaker: 'private speaker' },
  })
  h.services.companion = {
    tasks: { active: id => id === 'first' ? [task] : [] },
    activities: { peekActive: () => null },
    projects: { peekActive: () => null },
  }
  h.services.memory = { album: { search(_query, options) {
    searches++
    assert.deepEqual(options, { limit: 8, scope: 'xiaoman_private' })
    return [album('user_photo', 'first', 'direct', 'alb_12345678'),
      album('game_moment', 'first', 'group', 'alb_22345678'),
      album('user_photo', 'other', 'direct', 'alb_32345678'),
      album('user_photo', 'first', 'direct', 'alb_42345678', 'shared')]
  } } }
  h.setScope('first')
  await setImmediate()
  assert.equal(h.sent[0].body.activity.kind, 'singing')
  assert.deepEqual(h.sent[0].body.recentAlbum.map(item => item.id), ['alb_12345678'])
  assert.doesNotMatch(h.sent[0].options.body, /private|user_quote|source_hash/u)
  h.setTime(start + 1001)
  h.projection.refresh(true)
  await setImmediate()
  assert.equal(h.sent[1].body.activity.kind, 'idle')
  assert.equal(searches, 1)
  h.setScope('other')
  h.projection.refresh()
  await setImmediate()
  assert.equal(searches, 2)
  assert.deepEqual(h.sent[2].body.recentAlbum.map(item => item.id), ['alb_32345678'])
  h.setScope(null)
  h.projection.refresh()
  await setImmediate()
  assert.deepEqual(h.sent[3].body.recentAlbum, [])
})

test('Home resolves only an authorized positively identified QQ private session', () => {
  const agent = { id: 'session-owner', session: { id: 'session-owner' } }
  const target = new ActiveTargetStore({ duplexQqSessions: ['owner'] }, { stateFile: null })
  let destination = 'group'
  const services = { agents: { get: () => agent }, qqbotMediaSender: { resolveTargetForSession: () => ({ scope: destination }) } }
  const ctx = { get: key => services[key] }
  assert.equal(target.privateScope(ctx), null)
  target.observe(agent, { source: { kind: 'user', qq: { channel: 'direct' } } })
  assert.equal(target.privateScope(ctx), null)
  destination = 'c2c'
  assert.equal(target.privateScope(ctx), 'session-owner')
})
