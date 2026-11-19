import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { compareFrozenSkills, decidePolicy, evaluateFrozenSkill, learnPolicy, learningPlan, loadEvaluationSplit } from '../lib/skill_eval.js'
import { resourceRound } from '../../companion/lib/strategy_loop.js'
import { fixture, direct, group } from './fixture.js'

const examples = [{ input: { ruleFamily: 'reserve', unitCost: 2, budget: 8, task: 'energy' }, action: { amount: 2 } }]
const learned = learnPolicy(examples)
const before = { ...learned, parameters: { multiplier: 1, fixedCost: 1 } }

test('one demonstration learns a rule, not map answers; evaluation splits are frozen and separate', () => {
  const dev = loadEvaluationSplit('dev'), heldout = loadEvaluationSplit('heldout')
  assert.equal(dev.cases.length, 6)
  assert.equal(heldout.cases.length, 48)
  assert.notEqual(dev.hash, heldout.hash)
  assert.ok(!dev.cases.some(row => heldout.cases.some(other => row.id === other.id)))
  const bytes = readFileSync(new URL('../fixtures/skills/heldout.json', import.meta.url))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), heldout.hash)
  const comparison = compareFrozenSkills(before, learned)
  assert.equal(comparison.candidate.passed, 48)
  assert.equal(comparison.improved, true)
  assert.deepEqual(comparison.regressions, [])
  assert.deepEqual(comparison.candidate.scores, { naturalness: 1, reliability: 1, generalization: 1 })
  assert.match(comparison.candidate.naturalnessEvidence, /human.*not measured/)
  assert.throws(() => learnPolicy([]), /1–3/)
  assert.throws(() => learnPolicy([...examples, { ...examples[0], action: { amount: 4 } }]), /不一致/)
  assert.throws(() => decidePolicy({ ...learned, answers: heldout.cases }, {}), /字段/)
  assert.equal(decidePolicy(learned, { ruleFamily: 'unfamiliar', budget: 10, unitCost: 1 }).action, 'help')
  assert.equal(decidePolicy(learned, { ruleFamily: 'reserve', budget: 2 }).action, 'help')
})

for (const row of loadEvaluationSplit('heldout').cases) {
  test(`frozen transfer ${row.id}: ${row.dimension}`, () => {
    const actual = decidePolicy(learned, structuredClone(row.input))
    if (row.dimension !== 'naturalness') assert.deepEqual({ action: actual.action, ...(actual.amount !== undefined && { amount: actual.amount }) }, row.expected)
    if (actual.action === 'reserve') {
      // Independent Companion environment, not the evaluator's expected-answer table.
      assert.equal(resourceRound({ stock: row.input.budget, cost: row.input.unitCost }, actual.amount).success, true)
    } else assert.match(actual.text, /示范/)
  })
}

test('only measured zero-regression improvements appear in monthly footprint and revert removes them', async t => {
  const suite = fixture(t)
  const candidate = suite.skills.fromExamples('资源迁移', examples)
  const assessed = await suite.skills.evaluate('资源迁移', candidate.revision)
  assert.equal(assessed.assessment.improved, true)
  suite.skills.commit('资源迁移', candidate.revision)
  const digest = suite.footprint.digest('2026-11', direct)
  assert.equal(digest.skill_improvements[0].improvementType, 'strategy_parameters')
  assert.equal(suite.footprint.digest('2026-11', group).skill_improvements.length, 0)
  suite.skills.revert('资源迁移')
  assert.equal(suite.footprint.digest('2026-11', direct).skill_improvements.length, 0)
})

test('learning plans require observed capability gaps and enforce zero-action budgets', () => {
  const plan = learningPlan({ name: 'pc_bridge', status: 'offline' })
  assert.equal(plan.budget.externalActions, 0)
  assert.ok(plan.stopCondition.includes('provider_offline'))
  assert.throws(() => learningPlan({ name: 'pc_bridge', status: 'available' }), /缺口/)
  assert.throws(() => learningPlan({ name: 'pc_bridge', status: 'unknown' }, { maxTrials: 100 }), /预算/)
})
