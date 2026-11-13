import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyEvidence } from '../lib/footprint/growth_footprint.js'
import { chatArgs, direct, fixture, group } from './fixture.js'

test('resonance uses verified keywords, durable cooldown, and group privacy', t => {
  const f = fixture(t)
  f.footprint.record(chatArgs, direct, (args, surface) => verifyEvidence(args, surface, {}, f.now))
  const next = { ...direct, messageId: 'm2' }
  assert.throws(() => f.resonance.find({ topic: '没说过' }, next), /关键词/)
  assert.equal(f.resonance.find({ topic: '桂花糕' }, { ...group, messageId: 'g2' }).has_resonance, false)
  assert.equal(f.resonance.find({ topic: '桂花糕' }, next).has_resonance, true)
  f.advance(3_599_999)
  assert.equal(f.resonance.find({ topic: '桂花糕' }, { ...next, messageId: 'm3' }).reason, 'cooldown')
  f.advance(1)
  assert.equal(f.resonance.find({ topic: '桂花糕' }, { ...next, messageId: 'm3' }).has_resonance, true)
})
