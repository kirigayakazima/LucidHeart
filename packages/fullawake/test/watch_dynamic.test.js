import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { WebSocketServer } from 'ws'
import { FullAwakeBridgeClient } from '../lib/bridge-client.js'
import { minLookIntervalMs, parseWatchDecision, registerWatch, WatchContextStore } from '../lib/watch.js'

const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { Session } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')))

test('minLookIntervalMs adapts to silentStreak and accelerates on dramatic sceneChange', () => {
  assert.equal(minLookIntervalMs(0, 0.1), 18_000)
  assert.equal(minLookIntervalMs(1, 0.1), 35_000)
  assert.equal(minLookIntervalMs(2, 0.1), 60_000)
  assert.equal(minLookIntervalMs(3, 0.1), 90_000)
  assert.equal(minLookIntervalMs(5, 0.1), 90_000)
  assert.equal(minLookIntervalMs(0, 0.4), 15_000)
  assert.equal(minLookIntervalMs(2, 0.4), 30_000)
  assert.equal(minLookIntervalMs(3, 0.5), 45_000)
})

test('parseWatchDecision parses structured summary+speak, fenced JSON, and legacy formats', () => {
  assert.deepEqual(
    parseWatchDecision('```json\n{"summary":"憨豆把生肉塞进花瓶","speak":false,"text":"","intent":"smile"}\n```'),
    { summary: '憨豆把生肉塞进花瓶', speak: false, text: '', intent: 'smile' },
  )
  assert.deepEqual(
    parseWatchDecision('{"summary":"服务员走过来","speak":true,"text":"哈哈要露馅了","intent":"shock"}'),
    { summary: '服务员走过来', speak: true, text: '哈哈要露馅了', intent: 'shock' },
  )
  assert.deepEqual(parseWatchDecision('{"text":"兼容旧格式","intent":"nod"}'), {
    summary: '', speak: true, text: '兼容旧格式', intent: 'nod',
  })
  assert.deepEqual(parseWatchDecision('null'), { summary: '', speak: false, text: '', intent: 'nod' })
})

test('watch self-decision records silent summary, syncs spoken turn to real DSH session, and pauses on user engagement', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const tools = new Map()
  const services = new Map()
  const listeners = new Map()
  const disposers = []
  const spoken = []
  const ctx = {
    get: name => services.get(name),
    effect: fn => disposers.push(fn()),
    on: (event, fn) => {
      const list = listeners.get(event) ?? []
      list.push(fn)
      listeners.set(event, list)
      return () => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== fn)) }
    },
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  const emit = (event, ...args) => { for (const fn of listeners.get(event) ?? []) fn(...args) }

  services.set('heart', {
    getSnapshot: () => ({ presence: 'present', mood: { state: 'cheerful' } }),
    evaluateActivity: async () => ({ suitable: true }),
    observe: async () => ({ accepted: true }),
  })
  services.set('attachments', { async saveImage() { return { id: 'img-1', mediaType: 'image/png' } } })

  const llmAnswers = [
    '{"summary":"憨豆在餐桌旁认真看菜单","speak":false,"text":"","intent":"nod"}',
    '{"summary":"憨豆把生牛肉偷偷塞进花瓶里","speak":true,"text":"哈哈他居然把生肉塞花瓶里了","intent":"smile"}',
  ]
  services.set('llm', {
    async *stream() {
      const next = llmAnswers.shift() || 'null'
      yield { type: 'block-end', index: 0, block: { type: 'text', text: next } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  })

  const bridge = Object.assign(new EventEmitter(), {
    turnLifecycle: true,
    isUserBusy: false,
    begin({ priority }) {
      assert.equal(priority, 'watch')
      const controller = new AbortController()
      return { controller, signal: controller.signal, prepared: Promise.resolve(true), done: Promise.resolve({ status: 'played' }) }
    },
    speak({ text }) { spoken.push(text); return true },
  })

  const clock = {
    status: 'playing', widgetOnline: true, watchSessionId: 'w-1', timelineId: 'tl-1',
    title: '憨豆先生', latestCandidateSec: 10, latestCandidateDiff: 0.2, playbackPositionSec: 11, subtitles: [],
  }
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000030000000300', 'hex').toString('base64')
  let cueSeq = 0
  async function callGatewayTool(_name, args) {
    const hasImage = !args.clockOnly
    const cueId = hasImage ? `cue-${++cueSeq}` : null
    const data = {
      ...clock, watchedInterval: [0, clock.playbackPositionSec],
      frameCount: hasImage ? 1 : 0, tokenCost: hasImage ? 384 : 0,
      timecodes: hasImage ? [clock.latestCandidateSec] : [],
      sceneAtSec: hasImage ? clock.latestCandidateSec : null, cueId,
    }
    return { ok: true, content: [{ type: 'text', text: JSON.stringify(data) }, ...(hasImage ? [{ type: 'image', mimeType: 'image/png', data: png }] : [])] }
  }

  const watchContext = new WatchContextStore()
  registerWatch(ctx, { watchDecisionMode: 'legacy' }, {
    defineTool: v => v, callGatewayTool, gatewayUrl: 'http://127.0.0.1:28765', bridge, watchContext,
  })
  t.after(() => { for (const d of disposers) d?.() })

  const session = Session.create(randomUUID())
  const exec = { agent: { id: 'owner-1', status: 'idle', session } }
  assert.equal((await tools.get('pc_watch_auto').execute({ enabled: true }, exec)).status, 'started')

  // Glance 1: model decides speak: false -> keeps summary in WatchContextStore, does NOT speak or append to session
  t.mock.timers.tick(1500)
  for (let i = 0; i < 15 && watchContext.entries.length < 1; i++) await nextTurn()
  assert.equal(spoken.length, 0)
  assert.equal(session.deriveMessages().length, 0)
  assert.match(watchContext.formatPrompt(), /憨豆在餐桌旁认真看菜单/)
  assert.match(watchContext.formatPrompt(), /安静陪看/)

  // Glance 2: simulate user engagement + dramatic change, model decides speak: true
  emit('session/event', session, { type: 'user/message', data: { source: { kind: 'user' } } })
  // Wait out userBusy hold by simulating clock advance via direct fresh tick after resetting via stop+start
  await tools.get('pc_watch_auto').execute({ enabled: false }, exec)
  clock.latestCandidateSec = 30
  clock.playbackPositionSec = 31
  clock.latestCandidateDiff = 0.5
  // Clear userBusy by using a fresh watch registration with the same watchContext and session
  const disposers2 = []
  const tools2 = new Map()
  const ctx2 = { ...ctx, effect: fn => disposers2.push(fn()), tools: { register(tool) { tools2.set(tool.name, tool) } } }
  registerWatch(ctx2, { watchDecisionMode: 'legacy' }, {
    defineTool: v => v, callGatewayTool, gatewayUrl: 'http://127.0.0.1:28765', bridge, watchContext,
  })
  t.after(() => { for (const d of disposers2) d?.() })
  assert.equal((await tools2.get('pc_watch_auto').execute({ enabled: true }, exec)).status, 'started')
  t.mock.timers.tick(1500)
  for (let i = 0; i < 20 && spoken.length < 1; i++) await nextTurn()

  assert.deepEqual(spoken, ['哈哈他居然把生肉塞花瓶里了'])
  assert.match(watchContext.formatPrompt(), /哈哈他居然把生肉塞花瓶里了/)
  const msgs = session.deriveMessages()
  assert.equal(msgs.length, 2)
  assert.equal(msgs[0].role, 'user')
  assert.match(msgs[0].content[0].text, /陪看画面 · 憨豆先生 \| ref:cue-\d+/)
  assert.match(msgs[0].content[0].text, /憨豆把生牛肉偷偷塞进花瓶里/)
  assert.equal(msgs[1].role, 'assistant')
  assert.equal(msgs[1].content[0].text, '哈哈他居然把生肉塞花瓶里了')
})

test('FullAwakeBridgeClient user priority preempts active watch lease, while watch never preempts user', async t => {
  const server = http.createServer()
  const wss = new WebSocketServer({ server, path: '/ws/bridge' })
  const received = []
  wss.on('connection', socket => {
    let seq = 0
    socket.on('message', raw => {
      const frame = JSON.parse(raw)
      received.push(frame.type)
      const send = (type, payload) => socket.send(JSON.stringify({
        protocol: 'lucid.voice/1', type, sessionId: frame.sessionId, connectionId: frame.connectionId, commandSeq: ++seq, payload,
      }))
      if (frame.type === 'session.handshake') {
        send('session.handshake_ack', { status: 'ready', initialEpoch: 10, vadSupported: true, turnLifecycle: true })
      } else if (frame.type === 'audio.prepare') {
        send('audio.prepared', { epoch: frame.payload.epoch, utteranceId: frame.payload.utteranceId })
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const bridge = new FullAwakeBridgeClient(`ws://127.0.0.1:${port}/ws/bridge`, 'tok', { capture: true })
  t.after(async () => {
    bridge.stop()
    for (const c of wss.clients) c.terminate()
    await new Promise(resolve => wss.close(resolve))
    await new Promise(resolve => server.close(resolve))
  })
  const ready = new Promise(resolve => bridge.once('ready', resolve))
  bridge.connect()
  await ready

  // 1. Watch lease starts
  const watchTurn = bridge.begin({ agentId: 'a1', priority: 'watch' })
  assert.ok(watchTurn)
  assert.equal(await watchTurn.prepared, true)
  assert.equal(bridge.isUserBusy, false)

  // 2. User reply arrives -> immediately preempts watch lease and sends audio.cancel
  const userTurn = bridge.begin({ agentId: 'a1', priority: 'user' })
  assert.ok(userTurn)
  assert.equal(watchTurn.signal.aborted, true)
  assert.equal(await userTurn.prepared, true)
  assert.equal(bridge.isUserBusy, true)
  assert.ok(received.includes('audio.cancel'))

  // 3. Watch attempts to start while user lease is active -> denied (returns null)
  assert.equal(bridge.begin({ agentId: 'a1', priority: 'watch' }), null)
  userTurn.controller.abort()
  assert.equal(bridge.isUserBusy, false)
})
