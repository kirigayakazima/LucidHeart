import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { check } from '../db.js'

export function loadScenarios() {
  return JSON.parse(readFileSync(new URL('../../fixtures/scenario_cases.json', import.meta.url), 'utf8'))
}

function field(value, path) {
  return path.split('.').reduce((item, key) => item != null && Object.hasOwn(item, key) ? item[key] : undefined, value)
}

export function checkScenario(scenario, actual) {
  check(Array.isArray(scenario.assertions) && scenario.assertions.length, '场景必须声明断言')
  return scenario.assertions.map(rule => {
    const value = field(actual, rule.path)
    let passed
    if (rule.op === 'eq') passed = isDeepStrictEqual(value, rule.value)
    else if (rule.op === 'includes' || rule.op === 'excludes') {
      const comparable = typeof value === 'string' || Array.isArray(value)
      passed = comparable && (rule.op === 'includes' ? value.includes(rule.value) : !value.includes(rule.value))
    } else if (rule.op === 'lte') passed = Number.isFinite(value) && value <= rule.value
    else throw new Error('未知场景断言：' + rule.op)
    return { ...rule, passed }
  })
}

export async function runReplay(scenarios, adapters) {
  const ids = new Set()
  const results = []
  for (const scenario of scenarios) {
    check(typeof scenario.id === 'string' && !ids.has(scenario.id), '场景 ID 缺失或重复')
    check(Object.hasOwn(adapters, scenario.adapter) && typeof adapters[scenario.adapter] === 'function', '场景执行适配器未注册')
    ids.add(scenario.id)
    const actual = await adapters[scenario.adapter](scenario.input)
    const assertions = checkScenario(scenario, actual)
    results.push({ id: scenario.id, passed: assertions.every(rule => rule.passed), assertions })
  }
  return { total: results.length, passed: results.filter(item => item.passed).length, results }
}
