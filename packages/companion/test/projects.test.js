import assert from 'node:assert/strict'
import { test } from 'node:test'
import { dayMs } from '../lib/tasks/ledger.js'
import { fixture } from './fixture.js'

test('project keeps cross-day logs and completes all milestones', t => {
  const f = fixture(t)
  const { id } = f.projects.create('a', { name: '读书', goal: '读完一本书', milestones: ['第一章', '第二章'] })
  f.projects.checkin('a', { project_id: id, note: '第一章完成', milestone_index_done: 1 })
  f.advance(dayMs)
  const next = f.reopen().projects.checkin('a', { project_id: id, note: '第二章完成', milestone_index_done: 2 })
  assert.equal(next.status, 'completed')
  assert.deepEqual(next.remaining, [])
  assert.equal(next.logs[0].created_at - next.logs[1].created_at, dayMs)
})

test('project rejects wrong scopes and atomically rolls back invalid check-ins', t => {
  const f = fixture(t)
  const { id } = f.projects.create('a', { name: '学习', goal: '做习题', milestones: ['练习'] })
  assert.throws(() => f.projects.status('b', id))
  assert.throws(() => f.projects.checkin('a', { project_id: id, note: '', milestone_index_done: 1 }))
  assert.equal(f.projects.status('a', id).milestones[0].done, false)
})

test('repeating a completed milestone logs a zero delta', t => {
  const { projects } = fixture(t)
  const { id } = projects.create('a', { name: '自习', goal: '练习', milestones: ['复习'] })
  const args = { project_id: id, note: '已复习', milestone_index_done: 1 }
  projects.checkin('a', args)
  assert.deepEqual(projects.checkin('a', args).logs.map(log => log.progress_delta), [0, 1])
})
