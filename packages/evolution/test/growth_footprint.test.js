import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyEvidence } from '../lib/footprint/growth_footprint.js'
import { chatArgs, direct, fixture, group, noon } from './fixture.js'

test('digest counts unique observed songs and actual check-in days in Shanghai', t => {
  const f = fixture(t)
  const companion = {
    tasks: { get: id => ({ kind: 'singing', target: direct.storageScope, status: 'delivered', updated_at: noon - 1,
      payload: { title: '桂花糕' }, result: { output_path: 'song.mp3' } }) },
    projects: { status: () => ({ logs: [{ id: 'log', note: '桂花糕', created_at: noon - 2 }] }) },
  }
  const verify = (args, surface) => verifyEvidence(args, surface, { companion }, f.now)
  for (const dimension of ['music_habit', 'shared_joke']) {
    f.footprint.record({ ...chatArgs, dimension, evidence_type: 'song_play', evidence_id: 'song' },
      { ...direct, utterance: '桂花糕听完了' }, verify)
  }
  f.footprint.record({ ...chatArgs, dimension: 'companion_milestone', evidence_type: 'project_checkin', evidence_id: 'project' }, direct, verify)
  const digest = f.footprint.digest('2026-11', direct)
  assert.deepEqual([digest.songs, digest.checkin_days, digest.habits, digest.entries.length], [1, 1, ['桂花糕'], 3])
  assert.equal(f.footprint.digest('2026-11', group).entries.length, 0)
})

test('unplayed synthesis and unknown commitment cannot become evidence', t => {
  const f = fixture(t)
  const companion = { tasks: { get: () => ({ target: 'owner', kind: 'singing', status: 'completed',
    result: { output_path: 'song.mp3' }, payload: { title: '桂花糕' } }) } }
  assert.throws(() => verifyEvidence({ ...chatArgs, evidence_type: 'song_play' }, direct, { companion }, f.now), /确认/)
  assert.throws(() => verifyEvidence({ ...chatArgs, evidence_type: 'commitment_done' }, direct, {}, f.now), /证据/)
})
