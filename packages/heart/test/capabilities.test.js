import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITIES, capabilityProfile, refreshCapabilities } from '../lib/runtime-diagnostics.js'

test('capability evidence transitions, expires and never turns unknown into available', async () => {
  let now = 1000
  const profile = capabilityProfile({ now: () => now })
  for (const name of CAPABILITIES) {
    assert.equal(profile.snapshot().find(row => row.name === name).status, 'unknown')
    for (const status of ['available', 'degraded', 'offline', 'unknown']) {
      profile.record(name, status)
      assert.equal(profile.snapshot().find(row => row.name === name).status, status)
    }
    profile.failure(name)
    assert.equal(profile.snapshot().find(row => row.name === name).status, 'degraded')
  }
  await refreshCapabilities({ get: () => null }, profile)
  assert.equal(profile.snapshot()[0].status, 'offline')
  await refreshCapabilities({ get: key => key === 'pcBridge' ? {
    checkNow: () => ({ online: true }), isPetVoiceReady: () => false } : null }, profile)
  assert.equal(profile.snapshot()[0].status, 'available')
  assert.equal(profile.snapshot()[1].status, 'degraded')
  now += 60_001
  assert.ok(profile.snapshot().every(row => row.status === 'unknown' && row.known.length === 0))
  assert.throws(() => profile.record('invented', 'available'), /Invalid/)
})
