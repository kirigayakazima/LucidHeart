import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { AgencyArbiter, apply } from '../lib/index.js'
import { readModuleLogs } from '../lib/logger.js'
import { writeSense } from '../lib/sense.js'
import { dateOf } from '../lib/store.js'
import { reserveAutonomousQuota, rollbackQuota, writeTrigger } from '../lib/trigger.js'

const snapshot = { presence: { status: 'present' }, mood: { energy: 0.6 }, idle: { totalUsed: 0, totalCap: 6 } }
const cut = { active: true, sceneChange: 0.8 }

test('arbiter transitions through idle, observing, engaged, sleeping and wake', () => {
  const agency = new AgencyArbiter()
  const idle = agency.evaluate(snapshot)
  assert.deepEqual([idle.previousState, idle.state, idle.action], ['IDLE', 'IDLE', 'SILENCE'])
  const observing = agency.evaluate(snapshot, { active: true, sceneChange: 0.12 })
  assert.deepEqual([observing.previousState, observing.state, observing.action], ['IDLE', 'OBSERVING', 'OBSERVE_MORE'])
  const gesture = agency.evaluate(snapshot, { active: true, sceneChange: 0.26 })
  assert.deepEqual([gesture.previousState, gesture.state, gesture.action], ['OBSERVING', 'ENGAGED', 'MICRO_GESTURE'])
  const speech = agency.evaluate(snapshot, cut)
  assert.equal(speech.action, 'SPEAK')
  for (const { score, interest, contextFit, fatigue, disruption } of speech.scores) {
    assert([score, interest, contextFit, fatigue, disruption].every(Number.isInteger))
    assert.equal(score, 2 * interest + contextFit - fatigue - disruption)
  }
  assert.equal(speech.score, Math.max(...speech.scores.map(entry => entry.score)))
  const asleep = agency.evaluate({ ...snapshot, presence: 'asleep' }, cut)
  assert.deepEqual([asleep.previousState, asleep.state, asleep.action], ['ENGAGED', 'SLEEPING', 'SILENCE'])
  assert.equal(agency.evaluate(snapshot, cut).previousState, 'SLEEPING')
  assert.equal(agency.evaluate(snapshot, cut).state, 'ENGAGED')
  assert.equal(agency.evaluate(snapshot).state, 'IDLE')
})

test('hard gates take precedence and include in-flight reservations', () => {
  const agency = new AgencyArbiter()
  const blocked = { ...snapshot, idle: { totalUsed: 5, totalReserved: 1, totalCap: 6 },
    agency: { quietHours: true, cooldownRemainingMs: 100 } }
  assert.equal(agency.evaluate({ ...blocked, presence: 'asleep' }, cut).reason, 'asleep')
  assert.equal(agency.evaluate(blocked, cut).reason, 'quiet-hours')
  blocked.agency.quietHours = false
  assert.equal(agency.evaluate(blocked, cut).reason, 'interrupt-cooldown')
  blocked.agency.cooldownRemainingMs = 0
  const quota = agency.evaluate(blocked, cut)
  assert.equal(quota.reason, 'daily-cap')
  assert.equal(quota.action, 'SILENCE')
  assert.equal(quota.quotaRemaining, 0)
  assert.deepEqual(quota.scores, [])
  assert.equal(agency.evaluate({ ...snapshot, mood: { state: 'tired' } }, cut).action, 'SILENCE')
  assert.equal(agency.evaluate({ ...snapshot, presence: 'away' }, cut).action, 'OBSERVE_MORE')
  assert.equal(agency.evaluate(snapshot, { active: true, sceneChange: NaN }).reason, 'insufficient-scene-evidence')
})

test('plugin provides one agency bound to Heart state, cooldown and quota', async t => {
  let monotonic = 100
  t.mock.method(performance, 'now', () => monotonic)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-agency-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const services = new Map()
  const cleanups = []
  const ctx = {
    effect(effect) { cleanups.push(effect()) },
    get(name) { return services.get(name) },
    provide(name, service) {
      services.set(name, service)
      return () => services.delete(name)
    },
    tools: { register() {} },
  }
  apply(ctx, { root, quietFrom: '04:00', quietTo: '04:00', injectPrompt: false, runtimeDiagnostics: false })
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup?.() })
  const heart = ctx.get('heart')
  const agency = ctx.get('agency')
  assert.equal(agency, heart.agency)
  writeSense(root, { presence: 'present', at: new Date().toISOString() })
  writeTrigger(root, { idleDate: dateOf(), idleCount: 5 })
  const trigger = path.join(root, 'trigger.json')
  const before = fs.readFileSync(trigger)
  assert.equal(agency.evaluate({ ...cut, mode: 'shadow' }).action, 'SPEAK')

  const held = reserveAutonomousQuota(root, 'bilibili')
  assert.equal(held.ok, true)
  assert.equal(agency.evaluate({ ...cut, mode: 'shadow' }).reason, 'daily-cap')
  rollbackQuota(root, held.reservationId)
  await heart.observe({ type: 'sensor', source: 'fullawake', confidence: 1, evidence: { interrupted: true } })
  const cooled = agency.evaluate({ ...cut, sceneAtSec: 15, mode: 'shadow', cooldownRemainingMs: 0 })
  assert.equal(cooled.reason, 'interrupt-cooldown')
  assert.equal(cooled.cooldownRemainingMs, 30_000)
  assert.deepEqual(fs.readFileSync(trigger), before)
  const log = readModuleLogs(root, 'core').findLast(entry => entry.action === 'agency_decision')
  assert.deepEqual([log.detail.mode, log.detail.sceneAtSec, log.detail.action], ['shadow', 15, 'SILENCE'])
  monotonic += 30_000
  assert.equal(agency.evaluate({ ...cut, mode: 'shadow' }).action, 'SPEAK')
})
