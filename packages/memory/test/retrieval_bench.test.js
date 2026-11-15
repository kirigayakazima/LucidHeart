import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { MemoryIndexer } from '../lib/indexer.js';
import { benchmarkRetrieval, compareRankings, rankShadow } from '../lib/retrieval_bench.js';

test('Top-3 Jaccard and reciprocal ranks measure independent properties', () => {
  assert.deepEqual(compareRankings(['a', 'b', 'c', 'd'], ['b', 'd', 'a', 'c'], ['d']),
    { jaccardAt3: .5, mrrAt3: { fts: 0, shadow: .5, delta: .5 }, mrrReference: 'gold' });
});

test('unlabeled online metrics identify the FTS baseline proxy', () => {
  const result = compareRankings(['a', 'b'], ['b', 'a']);
  assert.equal(result.jaccardAt3, 1);
  assert.equal(result.mrrAt3.delta, -.5);
  assert.equal(result.mrrReference, 'fts_top1_proxy');
  assert.equal(compareRankings([], []).mrrReference, 'unlabeled');
});

test('offline mean reciprocal rank requires controlled gold judgments', () => {
  const positive = { baselineIds: ['a', 'b'], shadowIds: ['b', 'a'], relevantIds: ['b'] };
  const miss = { baselineIds: ['b'], shadowIds: [], relevantIds: ['b'] };
  assert.deepEqual(benchmarkRetrieval([positive, miss]), { count: 2, meanJaccardAt3: .5,
    mrrAt3: { fts: .75, shadow: .5, delta: -.25 } });
  assert.throws(() => benchmarkRetrieval([{ baselineIds: [], shadowIds: [] }]), /relevant/);
});

test('explicit mood tags, date decay and equal-BM25 reorder only the shadow list', () => {
  const at = Date.UTC(2026, 10, 15);
  const rows = [
    { rank: -1, raw_json: JSON.stringify({ id: 'old', updatedAt: '2025-01-01' }) },
    { rank: -1, raw_json: JSON.stringify({ id: 'new', updatedAt: '2026-11-15', tags: ['mood:calm'] }) },
  ];
  const ranked = rankShadow(rows, at, 'calm');
  assert.deepEqual(ranked.map(row => row.id), ['new', 'old']);
  assert.equal(ranked[0].emotion, 1);
  assert.equal(rankShadow(rows, at, 'engaged')[0].emotion, 0);
});

test('public indexer returns baseline before logging comparative metrics', async t => {
  const reports = [];
  const index = new MemoryIndexer(':memory:', { retrievalPolicy: 'shadow', onShadowEvaluation: report => reports.push(report) });
  t.after(() => index.close());
  for (const [id, confidence, tags, updatedAt] of [['a', 1, [], '2025-01-01'], ['b', .95, ['mood:calm'], '2026-11-15']]) {
    index.upsert({ id, kind: 'preference', scope: 'shared', content: '绿茶', confidence, tags,
      createdAt: updatedAt, updatedAt, status: 'active' });
  }
  const actual = index.search('绿茶', { mood: 'calm', projection: true });
  assert.equal(actual[0].id, 'a');
  assert.equal(reports.length, 0);
  await nextTurn();
  assert.equal(reports[0].mrrReference, 'fts_top1_proxy');
  assert(reports[0].jaccardAt3 >= 0);
  assert(!JSON.stringify(reports[0]).includes('绿茶'));
});
