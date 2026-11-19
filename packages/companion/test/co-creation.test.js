import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCompanion, apply } from '../lib/index.js'

test('co-created artifacts retain every version; invitation is one-shot and refusal cools other programs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'co-creation-'))
  let now = 1000, suite = createCompanion({ dataDir: root, now: () => now })
  t.after(() => { suite.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const first = suite.creations.draft('owner', { content: '故事草稿' })
  const second = suite.creations.revise('owner', { id: first.id, expectedVersion: 1, content: '哥哥修改了开头' })
  assert.throws(() => suite.creations.revise('owner', { id: first.id, expectedVersion: 1, content: '过期写入' }), /冲突/)
  const final = suite.creations.revise('owner', { id: first.id, expectedVersion: 2, content: '共同定稿', finalized: true })
  assert.deepEqual(final.history.map(row => row.content), ['故事草稿', '哥哥修改了开头', '共同定稿'])
  assert.equal(second.history[1].parent, 1)
  assert.throws(() => suite.creations.revise('owner', { id: first.id, expectedVersion: 3, content: '改定稿' }), /定稿/)
  const prepared = suite.creations.prepare('owner', first.id)
  assert.equal(suite.creations.offer('owner', prepared.id).executionAllowed, false)
  assert.equal(suite.creations.respond('owner', prepared.id, { id: 'user-1', text: '下次吧，我先忙' }).status, 'declined')
  assert.equal(suite.creations.prepare('owner', first.id).id, prepared.id)
  suite.close(); now += 1000
  suite = createCompanion({ dataDir: root, now: () => now })
  assert.throws(() => suite.creations.offer('owner', prepared.id), /邀请已使用/)
  const draft2 = suite.creations.draft('owner', { content: '第二个节目' })
  suite.creations.revise('owner', { id: draft2.id, expectedVersion: 1, content: '第二个定稿', finalized: true })
  const next = suite.creations.prepare('owner', draft2.id)
  assert.throws(() => suite.creations.offer('owner', next.id), /冷却/)
  now += 86_400_001
  suite.creations.offer('owner', next.id)
  assert.equal(suite.creations.respond('owner', next.id, { id: 'user-2', text: '好呀，一起看' }).executionAllowed, true)
  assert.throws(() => suite.creations.get('other', first.id), /找不到/)
  assert.equal(fs.existsSync(path.join(root, 'journal.jsonl')), false)
})

test('program invitations respect autonomous Heart denial before consuming opportunity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'program-gate-'))
  const tools = new Map(), services = new Map(), disposers = []
  apply({ tools: { register(tool) { tools.set(tool.name, tool) } }, get: name => services.get(name),
    provide(name, value) { services.set(name, value) }, effect(fn) { disposers.push(fn()) } }, { dataDir: root })
  t.after(() => { disposers.reverse().forEach(fn => fn?.()); fs.rmSync(root, { recursive: true, force: true }) })
  const creations = services.get('companion').creations
  const draft = creations.draft('owner', { content: '小节目' })
  creations.revise('owner', { id: draft.id, expectedVersion: 1, content: '准备完成', finalized: true })
  const program = creations.prepare('owner', draft.id)
  services.set('heart', { evaluateActivity(_request, context) { assert.deepEqual(context, {}); return { suitable: false } } })
  const result = await tools.get('companion_program_invite').execute({ id: program.id }, { agent: { id: 'owner' } })
  assert.equal(result.ok, false)
  assert.equal(creations.offer('owner', program.id).status, 'offered')
})
