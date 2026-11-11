import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { commitQuota, maybeTrigger, readTrigger, reserveAutonomousQuota, rollbackQuota, writeTrigger } from '../lib/trigger.js'

const now = new Date('2026-11-09T12:00:00+08:00')
const config = { idleTurnDailyCap: 6, idleCategories: [{ id: 'bilibili', dailyCap: 4 }] }

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-quota-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

test('memory reservations share the final slot and rollback preserves the entire trigger file', async t => {
  const root = fixture(t)
  writeTrigger(root, { idleDate: '2026-11-09', idleCount: 5, nextIdleAt: 'kept' })
  const file = path.join(root, 'trigger.json')
  const before = fs.readFileSync(file)
  const attempts = await Promise.all(Array.from({ length: 12 }, async () => reserveAutonomousQuota(root, 'bilibili', config, now)))
  const accepted = attempts.filter(result => result.ok)
  assert.equal(accepted.length, 1)
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(rollbackQuota(root, accepted[0].reservationId), true)
  assert.equal(commitQuota(root, accepted[0].reservationId, config, now), false)
  assert.deepEqual(fs.readFileSync(file), before)
  const { reservationId } = reserveAutonomousQuota(root, 'bilibili', config, now)
  assert.equal(commitQuota(root, reservationId, config, now), true)
  assert.equal(commitQuota(root, reservationId, config, now), false)
  assert.equal(readTrigger(root).idleCount, 6)
  assert.equal(readTrigger(root).idleCategoryCounts.bilibili, 1)
  assert.equal(readTrigger(root).nextIdleAt, 'kept')
  assert.deepEqual(reserveAutonomousQuota(root, 'bilibili', config, now), { ok: false, reason: 'daily-cap' })
})

test('category reservations are isolated by root and expire without charging a new day', t => {
  const root = fixture(t)
  const other = fixture(t)
  const midnight = new Date('2026-11-09T23:59:50+08:00')
  writeTrigger(root, { idleCategoryDate: '2026-11-09', idleCategoryCounts: { bilibili: 3 } })
  const { reservationId } = reserveAutonomousQuota(root, 'bilibili', config, midnight)
  assert.deepEqual(reserveAutonomousQuota(root, 'bilibili', config, midnight), { ok: false, reason: 'category-cap' })
  assert.equal(rollbackQuota(other, reservationId), false)
  assert.equal(commitQuota(root, reservationId, config, new Date(midnight.getTime() + 15_000)), false)
  assert.equal(readTrigger(root).idleCount, undefined)
  const expiring = reserveAutonomousQuota(root, 'bilibili', config, now)
  assert.equal(commitQuota(root, expiring.reservationId, config, new Date(now.getTime() + 30_000)), false)
  assert.equal(readTrigger(root).idleCategoryCounts.bilibili, 3)
})

test('a malformed trigger file does not authorize a reservation or overwrite accounting', t => {
  const root = fixture(t)
  const file = path.join(root, 'trigger.json')
  fs.writeFileSync(file, '{invalid')
  assert.throws(() => reserveAutonomousQuota(root, 'bilibili', config, now))
  assert.throws(() => writeTrigger(root, { idleCount: 0 }))
  assert.equal(fs.readFileSync(file, 'utf8'), '{invalid')
})

test('legacy trigger and Watch cannot take the same final slot during followup callbacks', async t => {
  const root = fixture(t)
  const sessionsRoot = path.join(root, 'sessions')
  const session = path.join(sessionsRoot, 'ws', 'active')
  fs.mkdirSync(session, { recursive: true })
  fs.writeFileSync(path.join(session, 'session.v4.jsonl.zstd'), '')
  const activeAt = new Date('2026-11-09T19:00:00+08:00')
  const prev = { presence: 'away', at: activeAt.toISOString(),
    awaySince: new Date(activeAt.getTime() - 40 * 60_000).toISOString() }
  writeTrigger(root, { idleDate: '2026-11-09', idleCount: 5 })
  let attempted
  const agent = { id: 'active', followup() { attempted = reserveAutonomousQuota(root, 'bilibili', config, activeAt) } }
  const ctx = { agents: { list: () => [agent] } }
  assert.equal(await maybeTrigger(ctx, root, prev, { presence: 'present' }, { ...config, sessionsRoot }, activeAt), true)
  assert.deepEqual(attempted, { ok: false, reason: 'daily-cap' })
  assert.equal(readTrigger(root).idleCount, 6)
})
