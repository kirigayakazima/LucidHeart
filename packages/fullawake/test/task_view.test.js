import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { taskLedger, taskSchema } from '../../companion/lib/tasks/ledger.js'
import { registerTaskView } from '../lib/task_view.js'

test('task view follows durable stages, keeps missing ETA unknown and scopes results', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(taskSchema)
  const ledger = taskLedger(db, Date.now)
  const tools = new Map()
  registerTaskView({ tools: { register: tool => tools.set(tool.name, tool) }, companion: { tasks: ledger } })
  const task = ledger.create('singing', 'key', 'owner')
  const query = (scope = 'owner') => tools.get('task_status_query').execute({ task_id: task.id }, { agent: { id: scope } })
  ledger.update(task.id, 'processing', 0, { result: { phase: 'queued', queue_position: 2 } })
  assert.equal((await query()).task.queue_position, 2)
  ledger.update(task.id, 'processing', 70, { result: { phase: 'rvc_convert', slice_progress: { current: 12, total: 19 } } })
  const rvc = (await query()).task
  assert.equal(rvc.status, 'CONVERTING_RVC')
  assert.equal(rvc.eta_seconds, null)
  assert.deepEqual(rvc.slice_progress, { current: 12, total: 19 })
  ledger.update(task.id, 'processing', 75, { result: { phase: 'rvc_convert', eta_seconds: 4, eta_stage: 'rvc_convert' } })
  const estimated = (await query()).task
  assert.equal(estimated.eta_seconds, 4)
  assert.equal(estimated.eta_stage, 'rvc_convert')
  assert.deepEqual(await query('different'), { ok: false, reason: 'task_not_found' })
  ledger.update(task.id, 'processing', 100, { result: { phase: 'delivering_qq', output_path: '/song.mp3' } })
  assert.equal((await query()).task.status, 'DELIVERING_QQ')
  ledger.update(task.id, 'failed', 100, { error: 'QQ rejected upload' })
  assert.equal((await query()).task.reason, 'QQ rejected upload')
  assert.deepEqual((await tools.get('task_status_active').execute({}, { agent: { id: 'owner' } })).tasks, [])
})
