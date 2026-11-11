import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { test } from 'node:test'
import { Config } from '../lib/index.js'
import { registerWatch } from '../lib/watch.js'
import { readModuleLogs } from '../../heart/lib/logger.js'
import { writeSense } from '../../heart/lib/sense.js'
import { HeartService } from '../../heart/lib/service.js'
import { dateOf, ensureLayout } from '../../heart/lib/store.js'
import { readTrigger, writeTrigger } from '../../heart/lib/trigger.js'

function fixture(t, watchDecisionMode, { widgetOnline = false, agency2PCQuota = true } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fullawake-agency-test-'))
  const tools = new Map()
  const services = new Map()
  const disposers = []
  const calls = { gateway: [], infer: 0, image: 0, tts: 0, begin: 0, speak: 0, reserve: 0, commit: 0, rollback: 0 }
  const ctx = {
    get: name => services.get(name),
    effect: effect => disposers.push(effect()),
    tools: { register(tool) { tools.set(tool.name, tool) } },
  }
  const heart = new HeartService(ctx, root, { agency2PCQuota, quietFrom: '04:00', quietTo: '04:00' })
  ensureLayout(root)
  writeSense(root, { presence: 'present', at: new Date().toISOString() })
  writeTrigger(root, { idleDate: dateOf(), idleCount: 0 })
  services.set('heart', heart)
  services.set('agency', heart.agency)
  for (const [method, counter] of [['reserveAutonomousQuota', 'reserve'], ['commitQuota', 'commit'], ['rollbackQuota', 'rollback']]) {
    const original = heart[method].bind(heart)
    heart[method] = (...args) => {
      calls[counter]++
      return original(...args)
    }
  }
  services.set('attachments', { async saveImage() { calls.image++; return { id: 'watch-image', mediaType: 'image/png' } } })
  services.set('llm', { async *stream() {
    calls.infer++
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '{"text":"这个切镜真快。","intent":"nod"}' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } })
  services.set('rvcWatchVoice', { async prepare() { calls.tts++; throw Error('Unexpected TTS call') } })
  const bridge = { turnLifecycle: widgetOnline, begin() {
    calls.begin++
    const controller = new AbortController()
    return { controller, signal: controller.signal, prepared: Promise.resolve(true), done: Promise.resolve({ status: 'played' }) }
  }, speak() { calls.speak++; return true } }
  const clock = { status: 'playing', widgetOnline, watchSessionId: 'watch-1', timelineId: 'timeline-1',
    latestCandidateSec: 10, latestCandidateDiff: 0.8, playbackPositionSec: 11,
    title: 'Private fixture title', subtitles: [{ start: 9, end: 10, text: 'Private fixture subtitle' }] }
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000030000000300', 'hex').toString('base64')
  const gateway = { sendUnexpectedImage: false }
  async function callGatewayTool(name, args) {
    calls.gateway.push([name, args.clockOnly === true])
    const hasImage = !args.clockOnly || gateway.sendUnexpectedImage
    const data = { ...clock, watchedInterval: [0, clock.playbackPositionSec],
      frameCount: hasImage ? 1 : 0, tokenCost: hasImage ? 384 : 0,
      timecodes: hasImage ? [clock.latestCandidateSec] : [],
      sceneAtSec: hasImage ? clock.latestCandidateSec : null, cueId: hasImage ? 'cue-1' : null }
    return { ok: true, content: [{ type: 'text', text: JSON.stringify(data) },
      ...(hasImage ? [{ type: 'image', mimeType: 'image/png', data: png }] : [])] }
  }
  registerWatch(ctx, { watchDecisionMode }, {
    defineTool: value => value, callGatewayTool, gatewayUrl: 'http://127.0.0.1:28765', bridge,
  })
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const exec = { agent: { id: 'watch-owner' } }
  return {
    root, heart, services, clock, gateway, calls,
    tool: (name, args) => tools.get(name).execute(args, exec),
    async tick() { t.mock.timers.tick(1500); await nextTurn() },
    decisions: () => readModuleLogs(root, 'core').filter(entry => entry.action === 'agency_decision'),
  }
}

test('shadow runs without renderer or inference services and logs a SPEAK without side effects', async t => {
  const watch = fixture(t, 'shadow')
  watch.services.delete('llm')
  watch.services.delete('attachments')
  watch.services.delete('rvcWatchVoice')
  const trigger = path.join(watch.root, 'trigger.json')
  const before = fs.readFileSync(trigger)
  assert.equal((await watch.tool('pc_watch_auto', { enabled: true, voice: true })).status, 'started')
  await watch.tick()
  await watch.tick()
  const [first] = watch.decisions()
  assert.equal(watch.decisions().length, 1)
  assert.equal(first.detail.action, 'SPEAK')
  assert.equal(first.detail.mode, 'shadow')
  assert.equal(first.detail.sceneAtSec, 10)
  const observation = readModuleLogs(watch.root, 'core').find(entry => entry.action === 'observation_received')
  assert.equal(observation.detail.type, 'vision')
  assert.deepEqual(observation.detail.evidence, { sceneAtSec: 10, sceneChange: 0.8 })
  assert(!JSON.stringify([first, observation]).includes('Private fixture'))

  watch.clock.timelineId = 'timeline-2'
  watch.clock.latestCandidateSec = 3
  watch.clock.latestCandidateDiff = 0.25
  watch.clock.playbackPositionSec = 4
  await watch.tick()
  assert.equal(watch.decisions().at(-1).detail.action, 'MICRO_GESTURE')
  watch.clock.status = 'paused'
  await watch.tick()
  assert.equal(watch.decisions().at(-1).detail.state, 'IDLE')
  assert(watch.calls.gateway.every(([, clockOnly]) => clockOnly))
  const { gateway, ...effects } = watch.calls
  assert(Object.values(effects).every(count => count === 0))
  assert.deepEqual(fs.readFileSync(trigger), before)
})

test('shadow blocks manual speech and rejects images returned to a clock-only request', async t => {
  const watch = fixture(t, 'shadow', { widgetOnline: true })
  assert.equal((await watch.tool('pc_watch_auto', { enabled: true, voice: true })).status, 'started')
  await watch.tick()
  assert.equal(watch.decisions().at(-1).detail.action, 'SPEAK')
  const metadata = await watch.tool('pc_watch_get_summary', {})
  assert.equal(metadata.tokenCost, 0)
  assert.deepEqual(metadata.images, [])
  assert.equal(metadata.title, undefined)
  assert.equal(metadata.subtitles, undefined)
  assert.deepEqual(await watch.tool('pc_watch_react', { voice: true }), { status: 'shadow' })
  watch.gateway.sendUnexpectedImage = true
  assert.deepEqual(await watch.tool('pc_watch_get_summary', {}), { status: 'invalid' })
  assert.equal(watch.calls.image, 0)
  assert.equal(watch.calls.begin, 0)
  assert.equal(watch.calls.speak, 0)
  assert.equal(watch.calls.infer, 0)
  assert.equal(watch.calls.tts, 0)
  assert.equal(watch.calls.reserve, 0)
})

test('heart mode runs live speech only for SPEAK with a 2PC reservation', async t => {
  const watch = fixture(t, 'heart', { widgetOnline: true })
  assert.equal((await watch.tool('pc_watch_auto', { enabled: true })).status, 'started')
  watch.clock.latestCandidateDiff = 0.25
  await watch.tick()
  assert.equal(watch.decisions().at(-1).detail.action, 'MICRO_GESTURE')
  assert.equal(watch.calls.reserve, 0)
  assert.equal(watch.calls.infer, 0)

  watch.clock.latestCandidateSec++
  watch.clock.latestCandidateDiff = 0.8
  await watch.tick()
  for (let i = 0; i < 20 && !watch.calls.commit; i++) await nextTurn()
  assert.equal(watch.decisions().at(-1).detail.action, 'SPEAK')
  assert.equal(watch.calls.infer, 1)
  assert.equal(watch.calls.speak, 1)
  assert.equal(watch.calls.commit, 1)
  assert.equal(readTrigger(watch.root).idleCount, 1)
})

test('heart mode stops at a missing 2PC reservation even after SPEAK', async t => {
  const watch = fixture(t, 'heart', { widgetOnline: true, agency2PCQuota: false })
  assert.equal((await watch.tool('pc_watch_auto', { enabled: true })).status, 'started')
  await watch.tick()
  assert.equal(watch.decisions().at(-1).detail.action, 'SPEAK')
  assert.equal(watch.calls.reserve, 1)
  assert.equal(watch.calls.begin, 0)
  assert.equal(watch.calls.infer, 0)
  assert.equal(readTrigger(watch.root).idleCount, 0)
})

test('legacy remains the schema default and accepts existing settings', () => {
  assert.equal(Config({}).watchDecisionMode, 'legacy')
  assert.equal(Config({ watchDecisionMode: 'shadow' }).watchDecisionMode, 'shadow')
  assert.equal(Config({ watchDecisionMode: 'heart' }).watchDecisionMode, 'heart')
  assert.throws(() => Config({ watchDecisionMode: 'unknown' }))
})
