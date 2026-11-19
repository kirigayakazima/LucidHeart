import { loadScenarios, runReplay } from './benchmark/replay_runner.js'
import { check, text } from './db.js'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export function normalizeSkill(value) {
  if (value?.kind === 'resource_policy') return normalizePolicy(value)
  check(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => ['trigger', 'reply', 'steps'].includes(key)), '技能配置只支持触发语、回复与展示步骤')
  const steps = value.steps ?? []
  check(Array.isArray(steps) && steps.length <= 6, '技能最多包含六个展示步骤')
  return { trigger: text(value.trigger, '触发语', 160), reply: text(value.reply, '回复', 600),
    steps: steps.map(step => text(step, '步骤', 200)) }
}

export function previewSkill(skill, { prompt, surface, userRequested, allowed }) {
  if (skill.kind === 'resource_policy') return null
  if (surface !== 'direct' || !userRequested || !allowed || prompt !== skill.trigger) return null
  return { text: skill.reply, steps: [...skill.steps], toolCalls: [] }
}

export async function evaluateSkill(skill) {
  if (skill.kind === 'resource_policy') return evaluateFrozenSkill(skill)
  const scenarios = loadScenarios()
  check(scenarios.length >= 40 && scenarios.some(s => s.adapter === 'model'), '技能回放场景不完整')
  // Model fixtures compare the candidate's actual output to the persona and
  // safety assertions. System fixtures verify the skill cannot intercept them.
  const replay = scenarios.map(scenario => {
    const model = scenario.adapter === 'model'
    return { ...scenario, adapter: model ? 'model' : 'isolation',
      input: { ...scenario.input },
      assertions: model && scenario.input.prompt === skill.trigger ? scenario.assertions : [{ path: 'override', op: 'eq', value: null }] }
  })
  return runReplay(replay, {
    model(input) {
      return previewSkill(skill, { ...input, userRequested: true, allowed: true }) ?? { override: null }
    },
    isolation(input) {
      return { override: previewSkill(skill, { prompt: input.prompt ?? skill.trigger, surface: 'direct',
        userRequested: false, allowed: true }) }
    },
  })
}

export function normalizePolicy(value) {
  check(value && Object.keys(value).every(key => ['kind', 'parameters', 'applicableWhen', 'avoidWhen', 'evidenceHash'].includes(key)), '策略字段无效')
  const parameters = value.parameters
  check(parameters && Object.keys(parameters).every(key => ['multiplier', 'fixedCost'].includes(key)) &&
    Number.isSafeInteger(parameters.multiplier) && parameters.multiplier >= 1 && parameters.multiplier <= 10 &&
    (parameters.fixedCost === undefined || Number.isSafeInteger(parameters.fixedCost) && parameters.fixedCost > 0), '策略参数无效')
  check(value.applicableWhen?.ruleFamily === 'reserve' && Object.keys(value.applicableWhen).length === 1 &&
    Array.isArray(value.avoidWhen) && value.avoidWhen.length === 3 &&
    ['blocked', 'unknown_cost', 'insufficient_budget'].every(key => value.avoidWhen.includes(key)), '策略适用条件无效')
  return { kind: 'resource_policy', parameters: { ...parameters }, applicableWhen: { ruleFamily: 'reserve' },
    avoidWhen: [...value.avoidWhen], ...(value.evidenceHash && { evidenceHash: text(value.evidenceHash, '示范哈希', 64) }) }
}

export function learnPolicy(examples) {
  check(Array.isArray(examples) && examples.length >= 1 && examples.length <= 3, '需要 1–3 条示范')
  const ratios = examples.map(({ input, action }) => {
    check(input?.ruleFamily === 'reserve' && Number.isSafeInteger(input.unitCost) && input.unitCost > 0 &&
      Number.isSafeInteger(action?.amount) && action.amount <= input.budget && !input.blocked, '示范缺少确定动作证据')
    return action.amount / input.unitCost
  })
  check(ratios.every(value => value === ratios[0]), '示范规则不一致，需要求助')
  return normalizePolicy({ kind: 'resource_policy', parameters: { multiplier: ratios[0] },
    applicableWhen: { ruleFamily: 'reserve' }, avoidWhen: ['blocked', 'unknown_cost', 'insufficient_budget'],
    evidenceHash: createHash('sha256').update(JSON.stringify(examples)).digest('hex') })
}

// The executable surface is this declarative interpreter. No generated code, file handles,
// expected outputs or fixture collection is passed to a candidate.
export function decidePolicy(policy, input) {
  policy = normalizePolicy(policy)
  const help = { action: 'help', text: '还没确认规则，可以先示范一个小步骤吗？' }
  if (input.ruleFamily !== policy.applicableWhen.ruleFamily || input.blocked ||
    !Number.isSafeInteger(input.unitCost) || input.unitCost <= 0 || !Number.isSafeInteger(input.budget)) return help
  const amount = policy.parameters.fixedCost ?? input.unitCost * policy.parameters.multiplier
  if (amount > input.budget) return help
  return { action: 'reserve', amount, text: '先留好需要的资源，我们再试这一步。' }
}

export function loadEvaluationSplit(split = 'heldout') {
  check(['dev', 'heldout'].includes(split), '评测分区无效')
  const root = new URL('../fixtures/skills/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('freeze.json', root), 'utf8'))
  const bytes = readFileSync(new URL(split + '.json', root))
  check(createHash('sha256').update(bytes).digest('hex') === manifest[split], '冻结评测集 SHA-256 不匹配')
  return { hash: manifest[split], cases: JSON.parse(bytes) }
}

export function evaluateFrozenSkill(policy, { split = 'heldout' } = {}) {
  const fixture = loadEvaluationSplit(split)
  const dimensions = ['naturalness', 'reliability', 'generalization']
  const totals = Object.fromEntries(dimensions.map(key => [key, 0]))
  const passes = { ...totals }
  const results = fixture.cases.map(row => {
    const actual = decidePolicy(policy, structuredClone(row.input))
    const passed = row.dimension === 'naturalness' ?
      typeof actual.text === 'string' && actual.text.length > 0 && actual.text.length <= 60 && !/作为.*模型/.test(actual.text) :
      isDeepStrictEqual({ action: actual.action, ...(actual.amount !== undefined && { amount: actual.amount }) }, row.expected)
    totals[row.dimension]++
    passes[row.dimension] += Number(passed)
    return { id: row.id, dimension: row.dimension, passed }
  })
  return { split, fixtureHash: fixture.hash, total: results.length, passed: results.filter(row => row.passed).length, results,
    scores: Object.fromEntries(dimensions.map(key => [key, totals[key] ? passes[key] / totals[key] : null])),
    naturalnessEvidence: 'bounded-text rubric proxy; human listening not measured', improvementType: 'strategy_parameters' }
}

export function compareFrozenSkills(before, after) {
  const baseline = evaluateFrozenSkill(before), candidate = evaluateFrozenSkill(after)
  const regressions = candidate.results.filter((row, index) => !row.passed && baseline.results[index].passed).map(row => row.id)
  const improved = Object.keys(candidate.scores).some(key => candidate.scores[key] > baseline.scores[key])
  return { baseline, candidate, regressions, improved: improved && regressions.length === 0 }
}

export function learningPlan(gap, { maxSteps = 3, maxTrials = 3 } = {}) {
  check(gap && ['offline', 'degraded', 'unknown'].includes(gap.status), '需要真实能力缺口')
  check(Number.isInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 3 && Number.isInteger(maxTrials) && maxTrials >= 1 && maxTrials <= 3, '学习预算无效')
  return { capability: text(gap.name, '能力'), steps: ['核验前置条件', '请求 1–3 条示范', '离线回测并复核'].slice(0, maxSteps),
    budget: { maxSteps, maxTrials, llmTokens: 0, externalActions: 0 },
    stopCondition: ['user_stop', 'budget_exhausted', 'provider_offline', 'heldout_regression'], status: 'proposed' }
}
