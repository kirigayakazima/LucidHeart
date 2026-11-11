import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { apply } from '../lib/index.js';
import { CONVERSATION_TOKEN_BUDGET, formatConversationProjection } from '../lib/budget.js';
import { MemoryService } from '../lib/service.js';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-shadow-'));
  const opened = [];
  const open = options => {
    const memory = new MemoryService({ dataDir, dbPath: ':memory:', ...options });
    opened.push(memory);
    return memory;
  };
  t.after(() => {
    for (const memory of opened) memory.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, open };
}

test('200-token conversation ceiling counts the wrapper and selects complete ranked entries', () => {
  const label = '小满的回忆';
  const prefix = `[${label}: 1. ]`;
  const exact = 'a'.repeat(CONVERSATION_TOKEN_BUDGET - Buffer.byteLength(prefix));
  assert.equal(Buffer.byteLength(formatConversationProjection([{ content: exact }], label)), 200);
  const oversized = [{ content: exact + 'b' }, { content: '🌙'.repeat(60) }];
  assert.equal(formatConversationProjection(oversized, label, { maxTokens: 999 }), '');
  assert.equal(formatConversationProjection([...oversized, { content: '星星{{代号}}' }], label),
    '[小满的回忆: 1. 星星｛｛代号｝｝]');
  assert.equal(formatConversationProjection([{ content: '星星' }], label, { maxTokens: 10 }), '');
});

test('shadow audits a real reorder after returning identical FTS results and keeps evidence out of logs', async t => {
  const { dataDir, open } = fixture(t);
  const baseline = open();
  assert.equal(baseline.indexer.retrievalPolicy, 'fts');
  const content = '乌龙茶';
  const first = baseline.remember({ content, confidence: 0.99, salience: { importance: 0 } });
  const pinned = baseline.remember({ content, confidence: 0.85, salience: { importance: 1 }, retentionClass: 'pinned' });
  const foreign = baseline.remember({ content, scope: 'axing_private', importance: 1 });
  const revoked = baseline.remember({ content, importance: 1 });
  baseline.revoke(revoked.id);
  const candidate = baseline.remember({ content, confidence: 0.1 });
  const journal = path.join(dataDir, 'journal.jsonl');
  const before = fs.readFileSync(journal);
  const audit = path.join(dataDir, 'shadow-retrieval.jsonl');
  const opts = { scope: 'xiaoman_private', limit: 2 };
  const expected = baseline.recall(content, opts);
  assert.deepEqual(expected.entries.map(({ id }) => id), [first.id, pinned.id]);
  await nextTurn();
  assert.equal(fs.existsSync(audit), false);

  const shadow = open({ retrievalPolicy: 'shadow' });
  assert.deepEqual(shadow.recall(content, opts), expected);
  assert.equal(shadow.project(content, opts), baseline.project(content, opts));
  assert.equal(fs.existsSync(audit), false);
  await nextTurn();
  const lines = fs.readFileSync(audit, 'utf8');
  const reports = lines.trim().split('\n').map(JSON.parse);
  assert.equal(reports.length, 2);
  assert.deepEqual(reports[0].baselineIds, [first.id, pinned.id]);
  assert.deepEqual(reports[0].shadowIds, [pinned.id, first.id]);
  assert.equal(reports[1].surface, 'conversation');
  assert(reports.every(report => report.elapsedMs >= 0 && report.scores.every(row => Number.isFinite(row.score))));
  assert(!lines.includes(content));
  for (const entry of [foreign, revoked, candidate]) assert(!lines.includes(entry.id));
  assert.deepEqual(fs.readFileSync(journal), before);
});

test('host prompt section produces byte-identical output in FTS and shadow modes', async t => {
  const { dataDir, open } = fixture(t);
  const seed = open();
  seed.remember({ content: '小舟喜欢乌龙茶' });
  seed.close();
  const text = '最近想喝乌龙茶';
  const agent = { id: 'watch-session', session: {} };
  const message = { role: 'user', content: [{ type: 'text', text }], source: {
    kind: 'user', qq: { channel: 'group', speaker: '小舟', start: 0, length: text.length },
  } };
  function prompt(retrievalPolicy) {
    const listeners = new Map();
    let section, memory;
    apply({
      on: (name, handler) => listeners.set(name, handler),
      tools: { register() {} },
      systemPrompt: { section: definition => { section = definition; } },
      provide: (_name, service) => { memory = service; },
    }, { dataDir, scope: 'xiaoman_private', retrievalPolicy });
    listeners.get('agent/inbox/claimed')({ agent, message });
    return { memory, text: section.text({ agent }) };
  }
  const fts = prompt(undefined);
  fts.memory.close();
  const shadow = prompt('shadow');
  try {
    assert.match(fts.text, /小舟喜欢乌龙茶/);
    assert.equal(shadow.text, fts.text);
    await nextTurn();
    assert.match(fs.readFileSync(path.join(dataDir, 'shadow-retrieval.jsonl'), 'utf8'), /"surface":"conversation"/);
  } finally {
    shadow.memory.close();
  }
});

test('queued comparison is discarded after a journal mutation or index close', async t => {
  const { open } = fixture(t);
  const reports = [];
  const memory = open({ retrievalPolicy: 'shadow', onShadowEvaluation: report => reports.push(report) });
  const old = memory.remember({ content: '喜欢乌龙茶' });
  assert.equal(memory.recall('乌龙茶').count, 1);
  memory.correct(old.id, '喜欢冰红茶');
  await nextTurn();
  assert.deepEqual(reports, []);
  assert.equal(memory.recall('冰红茶').count, 1);
  memory.close();
  await nextTurn();
  assert.deepEqual(reports, []);
});
