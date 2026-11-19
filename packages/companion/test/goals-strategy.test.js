import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createCompanion } from '../lib/index.js'

test('ordered goals survive restart, replan retains budget, stopped goals never nudge again', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-goals-'))
  let now = 1000, suite = createCompanion({ dataDir: root, now: () => now })
  t.after(() => { suite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const project = suite.projects.create('owner', { name: '节目', goal: '周末节目', milestones: ['选题', '练习', '检查', '演出'],
    budget: { maxSteps: 3, maxAutonomousNudges: 2 } })
  suite.projects.checkin('owner', { project_id: project.id, note: '选好了', milestone_index_done: 1 })
  assert.throws(() => suite.projects.checkin('owner', { project_id: project.id, note: '越级', milestone_index_done: 3 }), /顺序/)
  suite.close(); now += 86_400_000
  suite = createCompanion({ dataDir: root, now: () => now })
  assert.equal(suite.projects.status('owner', project.id).control.steps, 1)
  suite.projects.replan('owner', project.id, ['先练片段', '再检查'])
  assert.equal(suite.projects.status('owner', project.id).control.steps, 1)
  suite.projects.checkin('owner', { project_id: project.id, note: '尝试一轮' })
  assert.equal(suite.projects.checkin('owner', { project_id: project.id, note: '再试' }).status, 'stopped')
  assert.throws(() => suite.projects.replan('owner', project.id, ['复活']), /已停止/)
  for (let i = 0; i < 10; i++) assert.equal(suite.projects.nudge('owner', project.id), null)
  const stopped = suite.projects.create('owner', { name: '停止', goal: 'test', milestones: ['one'] })
  suite.projects.stop('owner', stopped.id)
  assert.equal(suite.projects.active('owner').length, 0)
  assert.equal(suite.projects.nudge('owner', stopped.id), null)
  const conditional = suite.projects.create('owner', { name: '条件', goal: 'test', milestones: ['one'], budget: { stopCondition: 'too_tired' } })
  assert.equal(suite.projects.checkin('owner', { project_id: conditional.id, note: '外部反馈', observedCondition: 'too_tired' }).status, 'stopped')
  const nudged = suite.projects.create('owner', { name: '提醒', goal: 'test', milestones: ['one'], budget: { maxAutonomousNudges: 1 } })
  assert.ok(suite.projects.nudge('owner', nudged.id))
  assert.equal(suite.projects.nudge('owner', nudged.id), null)
  const expiry = suite.activities.start('owner', { type: 'story', title: '活动', budget: { deadlineAt: now + 100 } })
  now += 101
  assert.throws(() => suite.activities.change('owner', expiry.id, 'step', { action_summary: '迟到' }), /进行中/)
  assert.equal(suite.activities.get('owner', expiry.id).status, 'stopped')
})

test('legacy SQLite projects and activities migrate without losing rows', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-migration-'))
  const db = new DatabaseSync(path.join(root, 'activity.sqlite'))
  db.exec(`CREATE TABLE activities(id TEXT PRIMARY KEY,scope TEXT NOT NULL,type TEXT NOT NULL,title TEXT NOT NULL,
    status TEXT CHECK(status IN ('active','paused','completed','aborted')),state_json TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER);
    CREATE UNIQUE INDEX active_activity ON activities(scope) WHERE status='active';
    INSERT INTO activities VALUES ('old','owner','story','旧活动','active','{}',1,1,NULL);`)
  db.close()
  const suite = createCompanion({ dataDir: root })
  t.after(() => { suite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  assert.equal(suite.activities.get('owner', 'old').title, '旧活动')
  assert.equal(suite.activities.change('owner', 'old', 'stop').status, 'stopped')
  assert.throws(() => suite.activities.change('owner', 'old', 'resume'), /暂停/)
})

test('rule disturbance changes actual numeric policy and reduces repeated failures', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-strategy-'))
  const suite = createCompanion({ dataDir: root })
  t.after(() => { suite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const run = suite.strategies.start('owner')
  for (const cost of [1, 1, 4, 4, 4, 4, 4]) suite.strategies.step('owner', run.id, { stock: 10, cost })
  const result = suite.strategies.read('owner', run.id)
  assert.deepEqual(result.trace.map(row => row.observation.success), [true, true, false, true, true, true, true])
  assert.deepEqual(result.trace[2].revision, { estimatedCost: 4 })
  assert.equal(result.parameters.estimatedCost, 4)
  const frozenFailureRate = 1
  const adaptedFailureRate = result.trace.slice(3).filter(row => !row.observation.success).length / 4
  assert.ok(adaptedFailureRate < frozenFailureRate)
})
