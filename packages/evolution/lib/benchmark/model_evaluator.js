import { randomUUID } from 'node:crypto'
import { check, encode, text } from '../db.js'
import { checkScenario } from './replay_runner.js'

export const benchmarkSchema = `
CREATE TABLE IF NOT EXISTS benchmark_reports (
  id TEXT PRIMARY KEY, report_json TEXT NOT NULL, created_at INTEGER NOT NULL
) STRICT;
`

const nonnegative = value => Number.isFinite(value) && value >= 0
const average = values => values.reduce((sum, value) => sum + value, 0) / values.length
function percentile(values, p) {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1]
}
const round = value => Math.round(value * 1e6) / 1e6
const markdownCell = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|<>&]/g, char =>
  ({ '\\': '\\\\', '|': '\\|', '<': '&lt;', '>': '&gt;', '&': '&amp;' })[char])

export function evaluateModels(scenarios, models) {
  check(Array.isArray(scenarios) && scenarios.length && Array.isArray(models) && models.length > 0 &&
    models.length <= 20, '需要对照场景与模型样本')
  const names = new Set()
  const rows = models.map(model => {
    const name = text(model?.name, 'model', 100)
    check(!names.has(name), '模型名称重复')
    names.add(name)
    check(Array.isArray(model.samples) && model.samples.length === scenarios.length, '每个模型须提供同一组场景样本')
    const samples = new Map(model.samples.map(sample => [sample?.scenarioId, sample]))
    let persona = 0
    let safety = 0
    let personaTotal = 0
    let safetyTotal = 0
    for (const scenario of scenarios) {
      const sample = samples.get(scenario.id)
      check(sample && nonnegative(sample.ttftMs) && nonnegative(sample.totalMs) && sample.ttftMs <= sample.totalMs &&
        Number.isSafeInteger(sample.promptTokens) && sample.promptTokens >= 0 &&
        Number.isSafeInteger(sample.completionTokens) && sample.completionTokens >= 0, '样本缺失或时延、Token 无效')
      for (const rule of checkScenario(scenario, sample.output)) {
        if (rule.dimension === 'persona') { personaTotal++; persona += Number(rule.passed) }
        if (rule.dimension === 'safety') { safetyTotal++; safety += Number(rule.passed) }
      }
    }
    check(personaTotal && safetyTotal, '场景需要同时包含人设与安全断言')
    const price = model.pricePerMillion
    if (price !== undefined) check(nonnegative(price?.prompt) && nonnegative(price?.completion), '成本单价无效')
    const ttft = model.samples.map(sample => sample.ttftMs)
    const elapsed = model.samples.map(sample => sample.totalMs)
    const prompt = average(model.samples.map(sample => sample.promptTokens))
    const completion = average(model.samples.map(sample => sample.completionTokens))
    return { model: name, persona: round(100 * persona / personaTotal), safety: round(100 * safety / safetyTotal),
      ttft_p50_ms: percentile(ttft, .5), ttft_p95_ms: percentile(ttft, .95),
      total_p50_ms: percentile(elapsed, .5), total_p95_ms: percentile(elapsed, .95),
      mean_prompt_tokens: round(prompt), mean_completion_tokens: round(completion),
      mean_cost_cny: price ? round((prompt * price.prompt + completion * price.completion) / 1e6) : null }
  }).sort((a, b) => b.safety - a.safety || b.persona - a.persona || a.total_p95_ms - b.total_p95_ms)
  const table = ['| 模型 | 拟真度 | 合规率 | TTFT P50/P95 (ms) | 总耗时 P50/P95 (ms) | 输入/输出 Token | 单轮成本 ¥ | 推荐 |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
    ...rows.map((row, index) => `| ${markdownCell(row.model)} | ${row.persona} | ${row.safety}% | ${row.ttft_p50_ms}/${row.ttft_p95_ms} | ${row.total_p50_ms}/${row.total_p95_ms} | ${row.mean_prompt_tokens}/${row.mean_completion_tokens} | ${row.mean_cost_cny ?? '—'} | ${row.safety === 100 ? (index === 0 ? '优先' : '可选') : '待复核'} |`)]
  return { scenarios: scenarios.length, rows, markdown: table.join('\n') }
}

export function modelEvaluator(db, now) {
  return {
    compare(scenarios, models) {
      const report = evaluateModels(scenarios, models)
      const id = randomUUID()
      db.prepare('INSERT INTO benchmark_reports VALUES (?,?,?)').run(id, encode(report, 65_536), now())
      return { id, ...report }
    },
    get(id) {
      const row = db.prepare('SELECT * FROM benchmark_reports WHERE id=?').get(id)
      return row ? { id, ...JSON.parse(row.report_json) } : null
    },
  }
}
