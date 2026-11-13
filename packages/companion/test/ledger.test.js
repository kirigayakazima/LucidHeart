import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixture, host, execution } from './fixture.js'

test('task submission is idempotent across connections and rejects key conflicts', t => {
  const f = fixture(t)
  const task = f.tasks.create('singing', 'key', 'scope', { title: 'A' })
  assert.equal(f.reopen().tasks.create('singing', 'key', 'scope', { title: 'A' }).id, task.id)
  assert.throws(() => f.tasks.create('singing', 'key', 'other', { title: 'A' }), /冲突/)
})

test('ledger enforces transitions, monotonic progress and durable results', t => {
  const f = fixture(t)
  const { id } = f.tasks.create('storyboard', null, 'scope')
  assert.throws(() => f.tasks.update(id, 'completed'))
  f.tasks.update(id, 'processing', 40)
  assert.throws(() => f.tasks.update(id, 'processing', 39))
  f.tasks.update(id, 'completed', 60, { result: { files: ['board.png'] } })
  const delivered = f.reopen().tasks.update(id, 'delivered')
  assert.deepEqual(delivered.result, { files: ['board.png'] })
  assert.equal(delivered.progress, 100)
})

test('recovery marks only expired processing jobs and allows expired keys to be reused', t => {
  const f = fixture(t)
  const old = f.tasks.create('singing', 'old', 'scope', null, 1000)
  const fresh = f.tasks.create('singing', 'fresh', 'scope', null, 10_000)
  f.tasks.update(old.id, 'processing', 10)
  f.tasks.update(fresh.id, 'processing', 10)
  f.advance(1000)
  const { tasks } = f.reopen()
  assert.equal(tasks.get(old.id).error_message, 'host_restarted')
  assert.equal(tasks.get(fresh.id).status, 'processing')
  assert.notEqual(tasks.create('singing', 'old', 'scope').id, old.id)
})

test('tool ownership prevents reading or editing another session’s task', async t => {
  const h = host(t)
  const { data } = await h.run('task_create', { kind: 'download', idempotency_key: 'a' })
  const foreign = execution('', { scope: 'another' })
  assert.equal((await h.run('task_get', { id: data.id }, foreign)).ok, false)
  assert.equal((await h.run('task_update', { id: data.id, status: 'failed' }, foreign)).ok, false)
})
