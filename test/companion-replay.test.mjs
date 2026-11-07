import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRuns, fixture } from './fixtures/companion-scenarios/compare.mjs';

test('paired evaluation reports a continuity regression on the exact scenario', () => {
  const controls = fixture.cases.map(item => ({
    id: item.id, reply: '', labels: item.required, latencyMs: 10, tokens: 5,
    ratings: { continuity: 2, empathy: 1, naturalness: 1 },
  }));
  const trial = structuredClone(controls);
  const index = fixture.cases.findIndex(item => item.id === 'memory-updated-fact');
  trial[index].labels = ['treats_superseded_fact_as_current'];
  trial[index].ratings.continuity = 0;
  const result = compareRuns(
    { model: 'control', scenarioVersion: fixture.version, rows: controls },
    { model: 'trial', scenarioVersion: fixture.version, rows: trial.reverse() },
  );
  assert.equal(result.baseline.passed, fixture.cases.length);
  assert.equal(result.candidate.passed, fixture.cases.length - 1);
  assert.deepEqual(result.regressions, [{
    id: 'memory-updated-fact', lowered: ['continuity'], missing: ['uses_active_fact'],
    forbidden: ['treats_superseded_fact_as_current'],
  }]);
});
