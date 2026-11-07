import test from 'node:test';
import assert from 'node:assert/strict';
import { motionState, PlaybackMotion } from '../lib/motion.js';

test('sleep follows presence and mouth follows audio RMS, resetting between utterances', () => {
  assert.deepEqual(motionState({ presence: { status: 'asleep' }, mood: { energy: .25 } }), { mode: 'resting', energy: .25 });
  const clock = new PlaybackMotion();
  const loud = new Float32Array(512).fill(.3);
  const soft = new Float32Array(512).fill(.04);
  const quiet = new Float32Array(512);
  assert.deepEqual(clock.update('voice-1', 42.5, loud), { mode: 'speaking', utteranceId: 'voice-1', positionMs: 43, mouth: 2 });
  assert.equal(clock.update('voice-2', 0, soft).mouth, 1);
  for (let i = 1; i < 20; i++) clock.update('voice-2', i * 33, quiet);
  assert.equal(clock.update('voice-2', 660, quiet).mouth, 0);
  clock.update('voice-2', 680, loud);
  assert.equal(clock.update('voice-2', 5, quiet).mouth, 0);
});
