import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { apply, createEvolution } from '../lib/index.js'
import { skillSandbox, skillSchema } from '../lib/skill_sandbox.js'
import { direct, execution, fixture, group, sandbox } from './fixture.js'

const draft = { trigger: '今天整理桌面', reply: '先把手边的文件收好。', steps: ['整理文件', '清理桌面'] }
const context = { prompt: draft.trigger, surface: 'direct', userRequested: true, allowed: true }

test('candidate previews are isolated until all 40 offline cases pass and the version is committed', async t => {
  const { skills } = fixture(t)
  const candidate = skills.propose('整理', draft)
  assert.equal(candidate.status, 'candidate')
  assert.equal(skills.active('整理'), null)
  assert.equal(skills.preview('整理', context), null)
  assert.equal(skills.preview('整理', context, { trial: true }).text, draft.reply)
  assert.throws(() => skills.commit('整理', candidate.revision), /完整回测/)
  const report = await skills.evaluate('整理', candidate.revision)
  assert.deepEqual(report.assessment, { total: 40, passed: 40, failed: [] })
  assert.equal(skills.commit('整理', candidate.revision).status, 'committed')
  assert.equal(skills.preview('整理', context).text, draft.reply)
})

test('a candidate that breaks an original persona assertion cannot commit', async t => {
  const { skills } = fixture(t)
  const { revision } = skills.propose('介绍', { trigger: '小满，介绍一下你自己。', reply: '作为通用大语言模型' })
  const result = await skills.evaluate('介绍', revision)
  assert.deepEqual(result.assessment, { total: 40, passed: 39, failed: ['model-phone-introduction'] })
  assert.throws(() => skills.commit('介绍', revision), /完整回测/)
  assert.equal(skills.active('介绍'), null)
})

test('atomic revert restores the previous definition and survives SQLite reopen', async t => {
  const root = sandbox(t)
  let suite = createEvolution({ dataDir: root })
  try {
    const first = suite.skills.propose('整理', draft)
    await suite.skills.evaluate('整理', first.revision)
    suite.skills.commit('整理', first.revision)
    const next = suite.skills.propose('整理', { ...draft, reply: '这是试用回复。' })
    await suite.skills.evaluate('整理', next.revision)
    suite.skills.commit('整理', next.revision)
    assert.deepEqual(suite.skills.revert('整理'), { reverted: 2, active: 1 })
    suite.close()
    suite = createEvolution({ dataDir: root })
    assert.deepEqual(suite.skills.active('整理').definition, draft)
    assert.equal(suite.skills.propose('整理', draft).revision, 3)
  } finally { suite.close() }
})

test('failed head update rolls back both writes in the transaction', async t => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(skillSchema)
  const skills = skillSandbox(db)
  for (const reply of ['第一版', '第二版']) {
    const { revision } = skills.propose('整理', { ...draft, reply })
    await skills.evaluate('整理', revision)
    skills.commit('整理', revision)
  }
  db.exec(`CREATE TRIGGER fail_head BEFORE UPDATE ON skill_heads BEGIN SELECT RAISE(ABORT, 'fixture'); END;`)
  assert.throws(() => skills.revert('整理'), /fixture/)
  assert.equal(skills.active('整理').revision, 2)
  assert.equal(skills.active('整理').status, 'committed')
})

test('an in-flight assessment cannot revive a reverted revision', async t => {
  const { skills } = fixture(t)
  const { revision } = skills.propose('整理', draft)
  const evaluation = skills.evaluate('整理', revision)
  assert.equal(skills.trial('整理').status, 'evaluating')
  skills.revert('整理', revision)
  await assert.rejects(evaluation, /已结束/)
  assert.equal(skills.trial('整理'), null)
})

test('runtime preview obeys scope, exact trigger and activity authorization', t => {
  const { skills } = fixture(t)
  skills.propose('整理', draft)
  for (const override of [{ surface: 'group' }, { prompt: '无关' }, { allowed: false }, { userRequested: false }]) {
    assert.equal(skills.preview('整理', { ...context, ...override }, { trial: true }), null)
  }
  assert.throws(() => skills.propose('程序', { ...draft, command: 'never allow code' }), /技能配置/)
})

test('Cordis skill commit requires confirmation of the exact revision from owner direct chat', async t => {
  const tools = new Map()
  const dispose = []
  t.after(() => dispose.forEach(fn => fn()))
  apply({ tools: { register(tool) { tools.set(tool.name, tool) } }, effect(fn) { dispose.push(fn()) } },
    { dataDir: sandbox(t), ownerDirectSessions: ['owner'], role: 'xiaoman' })
  const proposed = await tools.get('skill_propose').execute({ skill_id: '整理', definition: draft }, execution())
  assert.equal(proposed.ok, true)
  const args = { skill_id: '整理', revision: proposed.data.revision }
  assert.equal((await tools.get('skill_evaluate').execute(args, execution())).ok, true)
  const commit = tools.get('skill_commit')
  assert.equal((await commit.execute(args, execution({ ...group, utterance: '确认启用技能 整理 第 1 版' }))).ok, false)
  assert.equal((await commit.execute(args, execution({ ...direct, utterance: '确认启用技能 整理 第 2 版' }))).ok, false)
  assert.equal((await commit.execute(args, execution({ ...direct, utterance: '确认启用技能 整理 第 1 版' }))).ok, true)
})
