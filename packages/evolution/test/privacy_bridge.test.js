import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply } from '../lib/index.js'
import { surfaceContext } from '../lib/surface/privacy_bridge.js'
import { chatArgs, direct, execution, group, sandbox } from './fixture.js'

test('runtime group identity and source slice override model-supplied visibility', async t => {
  const tools = new Map()
  const disposers = []
  const config = { dataDir: sandbox(t, 'evolution-', () => { for (const dispose of disposers) dispose?.() }),
    ownerDirectSessions: ['owner'], coreGroupSessions: ['session-group'] }
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => disposers.push(fn()) }, config)
  const run = (name, args, exec) => tools.get(name).execute(args, exec)
  const row = await run('growth_record_footprint', chatArgs, execution(direct))
  assert.equal(row.ok, true)
  const realGroup = execution(group, { prefix: '历史记录和私聊摘录\n' })
  assert.equal(surfaceContext(realGroup, config).utterance, group.utterance)
  const relabeled = [{ id: row.data.id, visibility: 'PUBLIC_FRIENDLY' }]
  assert.equal((await run('surface_bridge_filter', { memories: relabeled, target_surface: 'direct' }, realGroup)).ok, false)
  assert.deepEqual((await run('surface_bridge_filter', { memories: relabeled, target_surface: 'group' }, realGroup)).data, [])
  assert.equal((await run('sister_receive', {}, realGroup)).ok, false)
  assert.equal((await run('growth_generate_digest', { month: '2026-11' }, execution(direct, { kind: 'schedule' }))).ok, false)
})
