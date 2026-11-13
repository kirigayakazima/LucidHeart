import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { dayMs } from '../lib/tasks/ledger.js'
import { evidence, execution, fixture, host } from './fixture.js'

test('care uses measured first-return gaps, dedupes requests and caps the whole day', t => {
  const f = fixture(t)
  for (const scope of ['a', 'b', 'c']) f.care.noteInteraction(scope, 'old')
  f.advance(4 * 3_600_000)
  for (const scope of ['a', 'b', 'c']) f.care.noteInteraction(scope, 'new')
  assert.equal(f.care.evaluate('a', 'old').reason, 'not_due')
  assert.equal(f.care.evaluate('a', 'new').reason, 'user_returned')
  assert.equal(f.care.evaluate('a', 'new').reason, 'already_suggested')
  assert.equal(f.care.evaluate('b', 'new').should_care, true)
  assert.equal(f.care.evaluate('c', 'new').reason, 'daily_cap')
})

test('due commitments take priority and confirmation is atomic and scoped', t => {
  const f = fixture(t)
  const due_at = Date.parse('2026-11-13T13:00:00+08:00')
  const { id } = f.care.addCommitment('a', { title: '散步', due_at }, evidence('我们说好去散步'))
  assert.equal(f.care.evaluate('a').reason, 'not_due')
  f.advance(4 * 3_600_000)
  assert.equal(f.care.evaluate('a').commitment_id, id)
  assert.throws(() => f.care.complete('b', id, evidence('散步已完成')))
  assert.throws(() => f.care.complete('a', id, evidence('散步还没完成')))
  assert.equal(f.reopen().care.complete('a', id, evidence('散步已完成')).completed, true)
  assert.equal(f.care.evaluate('a').reason, 'not_due')
})

test('Memory commitment references remain read-only and can be locally completed', async t => {
  const h = host(t, { memory: { commitments: {
    getActiveCommitmentCare: () => ({ id: 'm1', title: '散步', status: 'expired' }),
    resolve: () => assert.fail('must not write Memory'),
  } } })
  const result = await h.run('care_evaluate', {}, execution('还记得约好散步吗'))
  assert.equal(result.data.reason, 'commitment_due')
  assert.equal((await h.run('care_commitment_complete', { id: result.data.commitment_id }, execution('散步已经完成'))).ok, true)
  assert.equal((await h.run('care_evaluate', {}, execution('散步'))).data.should_care, false)
})

test('a caller-supplied gap cannot synthesize a return or bypass quiet time', async t => {
  const h = host(t)
  assert.equal((await h.run('care_evaluate', { session_gap_seconds: 30_000 })).data.should_care, false)
  const quiet = host(t, { heart: { evaluateActivity: () => ({ suitable: false, reason: 'quiet-hours' }) } })
  assert.equal((await quiet.run('care_evaluate', { session_gap_seconds: 30_000 })).data.reason, 'quiet-hours')
})

test('interests count only distinct messages and require strong enthusiasm for promotion suggestion', t => {
  const f = fixture(t)
  const args = { topic: '爵士', details: '音乐', enthusiasm: 5 }
  assert.throws(() => f.recordInterest('a', args, evidence('喜欢古典')))
  for (const id of ['1', '1', '2', '3']) {
    f.recordInterest('a', args, evidence('喜欢爵士', id))
  }
  const result = f.recordInterest('a', args, evidence('喜欢爵士', '3'))
  assert.equal(result.mention_count, 3)
  assert.equal(result.suggest_promotion, true)
})

test('approval requires trusted, non-negated user evidence tied to the candidate', async t => {
  const h = host(t)
  const { data } = await h.run('growth_observe', { category: 'expression', insight: '慢一点说' })
  const args = { id: data.id, approval_source: 'user_confirmation' }
  for (const exec of [execution('喜欢慢一点说', { kind: 'schedule' }), execution('不喜欢慢一点说'), execution('喜欢别的')]) {
    assert.equal((await h.run('growth_promote', args, exec)).ok, false)
  }
  assert.equal((await h.run('growth_promote', args, execution('我喜欢慢一点说'))).data.status, 'approved')
  assert.equal((await h.run('growth_list', {})).data[0].insight, '慢一点说')
})

test('quoted history in a QQ envelope cannot approve a candidate', async t => {
  const h = host(t)
  const { data } = await h.run('growth_observe', { category: 'expression', insight: '轻声说' })
  const prefix = '引用：我喜欢轻声说\n'
  const exec = execution(prefix + '今天吃饭了吗')
  exec.agent.session.events[1].data.source.qq = { channel: 'group', start: prefix.length, length: 7 }
  assert.equal((await h.run('growth_promote', { id: data.id, approval_source: 'user_confirmation' }, exec)).ok, false)
})

test('three reinforcements expire, cannot replay, and promotion writes an append-only audit', t => {
  const f = fixture(t)
  const input = { category: 'habit', insight: '早睡', quote: '喜欢早睡' }
  const first = f.experience.observe('a', input, evidence('喜欢早睡', '1'))
  f.experience.observe('a', input, evidence('喜欢早睡', '1'))
  f.advance(8 * dayMs)
  for (const id of ['2', '3']) f.experience.observe('a', input, evidence('喜欢早睡', id))
  const request = { id: first.id, approval_source: 'reinforcement' }
  assert.throws(() => f.experience.promote('a', request), /三条/)
  f.experience.observe('a', input, evidence('喜欢早睡', '4'))
  assert.match(f.experience.promote('a', request).audit_hash, /^[a-f0-9]{64}$/)
  assert.equal(f.experience.approved('a').length, 1)
  const db = new DatabaseSync(path.join(f.dataDir, 'care.sqlite'))
  try { assert.throws(() => db.exec('DELETE FROM growth_promotions'), /append only/) } finally { db.close() }
})
