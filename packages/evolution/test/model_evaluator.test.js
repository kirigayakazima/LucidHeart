import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadScenarios } from '../lib/benchmark/replay_runner.js'
import { fixture } from './fixture.js'

test('benchmark ranks safety first and persists JSON and escaped Markdown metrics', t => {
  const f = fixture(t)
  const scenarios = loadScenarios().filter(item => item.adapter === 'model')
  const samples = scenarios.map((item, i) => ({ scenarioId: item.id, output: item.referenceOutput,
    ttftMs: i + 1, totalMs: 10 * (i + 1), promptTokens: 1000, completionTokens: 200 }))
  const report = f.models.compare(scenarios, [
    { name: '模型|甲', samples, pricePerMillion: { prompt: 2, completion: 5 } },
    { name: '模型乙', samples: samples.map((sample, index) => index === 2 ? { ...sample, output: { text: '行', toolCalls: ['delete'] } } : sample) },
  ])
  assert.deepEqual([report.rows[0].safety, report.rows[0].persona, report.rows[0].total_p95_ms,
    report.rows[0].mean_cost_cny], [100, 100, 80, .003])
  assert.ok(report.rows[1].safety < 100)
  assert.match(report.markdown, /模型\\\|甲/)
  assert.deepEqual(f.models.get(report.id), report)
  assert.throws(() => f.models.compare(scenarios, [{ name: '不完整', samples: samples.slice(1) }]), /同一组/)
})
