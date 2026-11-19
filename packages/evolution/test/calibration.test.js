import { test } from 'node:test'
import assert from 'node:assert/strict'
import { capabilityProfile } from '../../heart/lib/runtime-diagnostics.js'
import { runReplay } from '../lib/benchmark/replay_runner.js'

test('calibration replay prevents claiming unverified and failed tools are available', async () => {
  const states = ['offline', 'degraded', 'unknown']
  const scenarios = states.map(status => ({ id: `calibration-${status}`, adapter: 'calibration', input: { status },
    assertions: [{ path: 'status', op: 'eq', value: status }, { path: 'inferred', op: 'eq', value: [] }] }))
  const result = await runReplay(scenarios, { calibration({ status }) {
    const profile = capabilityProfile()
    profile.record('pc_bridge', status)
    return profile.snapshot()[0]
  } })
  assert.equal(result.passed, 3)
})
