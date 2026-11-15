import assert from 'node:assert/strict'
import { test } from 'node:test'
import { guardEcho } from '../lib/aec_guard.js'

const reference = Float32Array.from({ length: 4096 }, (_, i) => .2 * Math.sin(i * .16) * Math.cos(i * .09))
const mic = reference.slice(1024, 1536)

test('active speaker lease suppresses delayed echo by 36 dB', () => {
  const result = guardEcho(mic, reference, 1224, { active: true })
  assert.equal(result.echo, true)
  assert.ok(Math.abs(result.samples[12] / mic[12] - 10 ** (-36 / 20)) < .00001)
})

test('inactive lease and headphones bypass the speaker filter', () => {
  assert.equal(guardEcho(mic, reference, 1024, { active: false }).echo, false)
  assert.equal(guardEcho(mic, reference, 1024, { route: 'headphone' }).samples, mic)
})

test('much louder near-end speech is preserved', () => {
  const loud = mic.map(x => x * 3)
  assert.equal(guardEcho(loud, reference, 1224).echo, false)
})
