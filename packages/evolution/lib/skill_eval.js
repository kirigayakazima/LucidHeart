import { loadScenarios, runReplay } from './benchmark/replay_runner.js'
import { check, text } from './db.js'

export function normalizeSkill(value) {
  check(value && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).every(key => ['trigger', 'reply', 'steps'].includes(key)), '技能配置只支持触发语、回复与展示步骤')
  const steps = value.steps ?? []
  check(Array.isArray(steps) && steps.length <= 6, '技能最多包含六个展示步骤')
  return { trigger: text(value.trigger, '触发语', 160), reply: text(value.reply, '回复', 600),
    steps: steps.map(step => text(step, '步骤', 200)) }
}

export function previewSkill(skill, { prompt, surface, userRequested, allowed }) {
  if (surface !== 'direct' || !userRequested || !allowed || prompt !== skill.trigger) return null
  return { text: skill.reply, steps: [...skill.steps], toolCalls: [] }
}

export async function evaluateSkill(skill) {
  const scenarios = loadScenarios()
  check(scenarios.length >= 40 && scenarios.some(s => s.adapter === 'model'), '技能回放场景不完整')
  // Model fixtures compare the candidate's actual output to the persona and
  // safety assertions. System fixtures verify the skill cannot intercept them.
  const replay = scenarios.map(scenario => {
    const model = scenario.adapter === 'model'
    return { ...scenario, adapter: model ? 'model' : 'isolation',
      input: { ...scenario.input, referenceOutput: scenario.referenceOutput },
      assertions: model ? scenario.assertions : [{ path: 'override', op: 'eq', value: null }] }
  })
  return runReplay(replay, {
    model(input) {
      return previewSkill(skill, { ...input, userRequested: true, allowed: true }) ?? input.referenceOutput
    },
    isolation(input) {
      return { override: previewSkill(skill, { prompt: input.prompt ?? skill.trigger, surface: 'direct',
        userRequested: false, allowed: true }) }
    },
  })
}
