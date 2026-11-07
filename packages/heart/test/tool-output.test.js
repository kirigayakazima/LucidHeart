import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { apply } from '../lib/index.js'
import { writeHeartConfig, dateOf } from '../lib/store.js'
import { writeTrigger, readTrigger } from '../lib/trigger.js'

function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-output-contract-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tools = new Map()
  apply({ effect: fn => fn(), tools: { register: tool => tools.set(tool.name, tool) } }, {
    root, injectPrompt: false, pulse: false, runtimeDiagnostics: false,
  })
  const execution = kind => ({ agent: { session: { events: [
    { type: 'user/message', data: { role: 'user', source: { kind } } },
  ] } } })
  async function execute(name, args = {}, exec) {
    const tool = tools.get(name)
    const value = await tool.execute(args, exec)
    // This is the same exported validator used by ToolRuntime.createSuccessResult.
    assert.deepEqual(value, JSON.parse(JSON.stringify(value)), `${name} output must round-trip as lossless JSON`)
    const violations = validateJsonSchemaValue(tool.output.schema, value, 'value')
    assert.deepEqual(violations, [], `${name} output contract: ${violations.join('; ')}`)
    const rendered = tool.output.render(args, value)
    assert.equal(rendered[0].type, 'text')
    assert.equal(typeof rendered[0].text, 'string')
    return value
  }
  return { root, tools, execute, execution }
}

test('heart_next user request passes actual host output validation without spending exhausted quotas', async t => {
  const h = harness(t)
  writeHeartConfig(h.root, { idleCategories: [{ id: 'study', label: '学习', dailyCap: 2 }] })
  const date = dateOf()
  writeTrigger(h.root, { idleDate: date, idleCount: 6, idleCategoryDate: date, idleCategoryCounts: { study: 2 } })
  const result = await h.execute('heart_next', { minutes: 30, category: 'study' }, h.execution('user'))
  assert.equal(result.origin, 'user_request')
  assert.equal(result.categoryQuotaRecorded, false)
  const state = readTrigger(h.root)
  assert.equal(state.idleCount, 6)
  assert.equal(state.idleCategoryCounts.study, 2)
  assert.ok(state.nextIdleAt)
  const schema = h.tools.get('heart_next').output.schema
  assert.equal(schema.additionalProperties, false)
  assert.ok(validateJsonSchemaValue(schema, { ...result, unexpected: true }, 'value').length > 0)
})

test('heart_next autonomous success and blocked/unknown branches satisfy the same strict output schema', async t => {
  const h = harness(t)
  writeHeartConfig(h.root, { idleCategories: [{ id: 'study', label: '学习', dailyCap: 1 }] })
  const success = await h.execute('heart_next', { minutes: 10, category: 'study' }, h.execution('schedule'))
  assert.equal(success.origin, 'autonomous')
  assert.equal(success.categoryQuotaRecorded, true)
  const scheduled = readTrigger(h.root).nextIdleAt
  const blocked = await h.execute('heart_next', { minutes: 60, category: 'study' }, h.execution('schedule'))
  assert.match(blocked.message, /今天用完/)
  assert.equal(readTrigger(h.root).nextIdleAt, scheduled)
  const unknown = await h.execute('heart_next', { minutes: 60, category: 'study' })
  assert.match(unknown.message, /今天用完/)
  const noCategory = await h.execute('heart_next', { minutes: 12 })
  assert.equal(noCategory.origin, 'unknown')
  assert.equal(noCategory.categoryQuotaRecorded, false)
})

test('all registered Heart tools validate their safe/default output through the actual SDK validator', async t => {
  const h = harness(t)
  for (const name of h.tools.keys()) await h.execute(name, {}, h.execution('user'))
  assert.ok(h.tools.size >= 18)
})
