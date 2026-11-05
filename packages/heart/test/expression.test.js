import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildExpressionPolicy } from '../lib/expression.js'
import { apply, Config } from '../lib/index.js'
import { writeHeartConfig } from '../lib/store.js'

test('policy is bounded, scene-aware, respects detailed work and has no persona/memory writes', () => {
  assert.equal(Config({}).expressionMode, 'auto')
  const auto = buildExpressionPolicy()
  assert.ok(auto.chars < 1100)
  for (const word of ['闲聊', '关怀', '办事', '深谈', '不编造', '权限']) assert.ok(auto.text.includes(word))
  const deep = buildExpressionPolicy({ expressionMode: 'deep', expressionExamples: false })
  assert.ok(deep.text.includes('充分展开')); assert.ok(!deep.text.includes('表达示例'))
  assert.equal(buildExpressionPolicy({ expressionEnabled: false }).text, '')
  assert.equal(buildExpressionPolicy({ expressionMode: 'injected-mode' }).mode, 'auto')
})

test('real Heart apply contributes a live, independently switchable section without editing Notebook', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-expression-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const sections = [], services = new Map()
  const notebook = path.join(root, 'notebook.md')
  fs.writeFileSync(notebook, '# 自己的本子\n- 不替我改原则\n')
  const before = fs.readFileSync(notebook, 'utf8')
  apply({ effect: fn => fn(), tools: { register() {} }, provide: (name, service) => services.set(name, service),
    systemPrompt: { section: section => sections.push(section) } }, {
    root, pulse: false, runtimeDiagnostics: false,
  })
  const section = sections.find(s => s.name === 'heart:expression')
  assert.ok(section.text().includes('本轮表达方式'))
  assert.equal(services.get('heart').getExpressionPolicy().mode, 'auto')
  writeHeartConfig(root, { expressionEnabled: false })
  assert.equal(section.text(), '')
  assert.equal(services.get('heart').getExpressionPolicy().enabled, false)
  assert.equal(fs.readFileSync(notebook, 'utf8'), before)
})
