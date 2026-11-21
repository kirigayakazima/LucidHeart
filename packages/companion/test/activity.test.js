import assert from 'node:assert/strict'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { execution, fixture, host, noon } from './fixture.js'

test('activity lifecycle is durable, scoped, and rounds cannot be overridden', t => {
  const f = fixture(t)
  const a = f.activities.start('a', { title: '读书', type: 'reading' }, { round: 0 })
  assert.equal(f.activities.change('a', a.id, 'step', { delta_state: { round: 90 }, action_summary: '读完一页' }).state.round, 1)
  assert.equal(f.activities.change('a', a.id, 'pause', { reason: '吃饭' }).status, 'paused')
  assert.equal(f.reopen().activities.change('a', a.id, 'resume').status, 'active')
  assert.equal(f.activities.change('a', a.id, 'finish', { summary: '读完第一章' }).status, 'completed')
  assert.equal(f.activities.get('b', a.id), null)
  assert.throws(() => f.activities.change('a', a.id, 'resume'))
})

test('unique active slot holds across SQLite connections and allows other sessions', t => {
  const f = fixture(t)
  const data = { title: '读书', type: 'reading' }
  const a = f.activities.start('a', data)
  assert.throws(() => f.reopen().activities.start('a', data), /先暂停/)
  f.activities.start('b', data)
  f.activities.change('a', a.id, 'pause', { reason: '暂停' })
  assert.equal(f.activities.change('a', a.id, 'abort', { reason: '放弃' }).status, 'aborted')
})

test('Cordis gates activity entry and reports start and finish to Heart', async t => {
  const h = host(t)
  const opened = await h.run('activity_start', { type: 'reading', title: '读书' })
  const result = await h.run('activity_finish', { id: opened.data.id, summary: '读完' })
  assert.equal(result.ok, true)
  assert.deepEqual(h.observations.map(item => item.type), ['activity_started', 'activity_finished'])
  const quiet = host(t, { heart: { evaluateActivity: () => ({ suitable: false, reason: 'quiet-hours' }) } })
  assert.equal((await quiet.run('activity_start', { type: 'reading', title: '读书' }, execution())).ok, false)
})

test('Home activity and project peeks omit private titles and leave expired rows unchanged', t => {
  const f = fixture(t)
  const budget = { deadlineAt: noon + 1000 }
  f.activities.start('a', { title: 'private activity', type: 'reading', budget })
  f.projects.create('a', { name: 'private project', goal: 'private goal', milestones: ['private milestone'], budget })
  assert.deepEqual(f.activities.peekActive('a'), { type: 'reading', created_at: noon, updated_at: noon })
  assert.deepEqual(f.projects.peekActive('a'), { created_at: noon, updated_at: noon })
  assert.equal(f.activities.peekActive('b'), null)
  assert.equal(f.projects.peekActive('b'), null)
  f.advance(1000)
  assert.equal(f.activities.peekActive('a'), null)
  assert.equal(f.projects.peekActive('a'), null)
  for (const [file, table, status] of [['activity', 'activities', 'active'], ['projects', 'projects', 'in_progress']]) {
    const db = new DatabaseSync(path.join(f.dataDir, file + '.sqlite'), { readOnly: true })
    try { assert.equal(db.prepare('SELECT status FROM ' + table).get().status, status) }
    finally { db.close() }
  }
})
