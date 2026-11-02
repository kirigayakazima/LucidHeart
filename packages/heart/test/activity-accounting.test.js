import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { ensureLayout, dateOf, writeHeartConfig } from '../lib/store.js'
import { writeTrigger, readTrigger } from '../lib/trigger.js'

test('heart_next preserves exhausted autonomous counts for human tasks and still blocks autonomous category use', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heart-accounting-'))
  ensureLayout(root)
  writeHeartConfig(root, { idleCategories: [{ id: 'study', label: '学习', dailyCap: 2 }] })
  const today = dateOf()
  writeTrigger(root, { idleDate: today, idleCount: 6, idleCategoryDate: today, idleCategoryCounts: { study: 2 } })
  const tools = new Map()
  apply({ effect: (fn) => fn(), tools: { register: (tool) => tools.set(tool.name, tool) } }, {
    root, injectPrompt: false, pulse: false, runtimeDiagnostics: false,
  })
  const tool = tools.get('heart_next')
  const exec = (kind) => ({ agent: { session: { events: [
    { type: 'user/message', data: { role: 'user', source: { kind } } },
  ] } } })
  const result = await tool.execute({ minutes: 30, category: 'study' }, exec('user'))
  assert.equal(result.origin, 'user_request')
  assert.equal(result.categoryQuotaRecorded, false)
  const state = readTrigger(root)
  assert.equal(state.idleCount, 6)
  assert.deepEqual(state.idleCategoryCounts, { study: 2 })
  assert.ok(state.nextIdleAt)
  const blocked = await tool.execute({ minutes: 30, category: 'study' }, exec('schedule'))
  assert.match(blocked.message, /类别今天用完/)
  const unknown = await tool.execute({ minutes: 30, category: 'study' })
  assert.match(unknown.message, /类别今天用完/)
})
