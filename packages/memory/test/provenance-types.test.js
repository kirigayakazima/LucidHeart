import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryService } from '../lib/service.js';
import { ClaimTypes, ProvenanceOrigins, RetentionClasses, validateMemoryEntry } from '../lib/types.js';

const observedAt = '2026-11-10T08:00:00.000Z';
const legacy = { id: 'fact_legacy', kind: 'fact', scope: 'xiaoman_private', content: '用户住在杭州',
  confidence: 0.95, confirmed: false, importance: 0.75, status: 'active', validFrom: observedAt,
  createdAt: observedAt, updatedAt: observedAt,
  source: { sessionId: 'legacy', channel: 'qq', evidenceText: '我住在杭州' },
  provenance: { origin: 'user_statement', speaker: '小舟', channel: 'direct', timestamp: observedAt } };
const source = { sessionId: 'current', channel: 'group', speaker: '小舟', messageId: 'msg-1',
  observedAt, evidenceText: '我住在上海' };
const provenance = { origin: 'user_request', claimType: 'user_statement', evidenceStatus: 'resolved' };

test('accepts legacy and optional provenance metadata and rejects invalid additions', () => {
  assert.deepEqual(ProvenanceOrigins, ['user_request', 'autonomous', 'external', 'unknown']);
  assert.deepEqual(ClaimTypes, ['user_statement', 'observation', 'model_inference', 'legacy_unknown']);
  assert.deepEqual(RetentionClasses, ['stable', 'episodic', 'pinned', 'unknown']);
  assert.equal(validateMemoryEntry(legacy), true);
  assert.equal(validateMemoryEntry({ ...legacy, source: undefined, provenance: undefined }), true);
  const entry = { ...legacy, source, provenance, salience: { importance: null }, retentionClass: 'pinned' };
  assert.equal(validateMemoryEntry(entry), true);
  for (const patch of [
    { source: { ...source, observedAt: 'yesterday' } },
    { source: { ...source, channel: 'qq' } },
    { source: { ...source, messageId: '' } },
    { source: undefined },
    { provenance: { ...provenance, origin: 'user_statement' } },
    { provenance: { ...provenance, claimType: 'assumed' } },
    { provenance: { ...provenance, evidenceStatus: 'invented' } },
    { salience: { importance: 1.1 } },
    { retentionClass: 'permanent' },
  ]) assert.equal(validateMemoryEntry({ ...entry, ...patch }), false);
});

test('legacy journal stays byte-identical on replay and new metadata survives a round trip', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-provenance-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const journal = path.join(dataDir, 'journal.jsonl');
  const before = Buffer.from(JSON.stringify({ action: 'create', timestamp: observedAt, entry: legacy }) + '\n');
  fs.writeFileSync(journal, before);
  let memory = new MemoryService({ dataDir, dbPath: ':memory:' });
  try {
    assert.deepEqual(memory.inspect(legacy.id), legacy);
    assert.deepEqual(fs.readFileSync(journal), before);
    const entry = memory.remember({ content: '用户住在上海', confidence: 0.95, confirmed: true,
      source, provenance, salience: { importance: 0.8, reason: 'user-evidence' }, retentionClass: 'stable' });
    const candidate = memory.remember({ content: '用户准备去青岛定居', confidence: 1, confirmed: true,
      source, provenance: { ...provenance, claimType: 'model_inference' } });
    assert.equal(candidate.confirmed, false);
    assert.equal(candidate.status, 'candidate');
    assert.equal(memory.recall('青岛定居').count, 0);
    const after = fs.readFileSync(journal);
    assert.deepEqual(after.subarray(0, before.length), before);
    memory.close();
    memory = new MemoryService({ dataDir, dbPath: ':memory:' });
    assert.deepEqual(memory.inspect(legacy.id), legacy);
    assert.deepEqual(memory.inspect(entry.id), entry);
    assert.deepEqual(memory.inspect(candidate.id), candidate);
    assert.deepEqual(fs.readFileSync(journal), after);
  } finally {
    memory.close();
  }
});
