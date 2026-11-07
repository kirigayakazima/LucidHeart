import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryService } from '../lib/service.js';
import { IntakeWeights } from '../lib/schema.js';

test('a shared project and low-confidence conversation survive the same journal replay', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'memory-project-'));
  const open = () => new MemoryService({ dataDir, dbPath: ':memory:' });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const scope = 'xiaoman_private';
  const now = new Date('2026-11-07T14:50:00Z');
  const memory = open();
  const initial = memory.projects.start({ scope, title: '一起看动画', goal: 3, evidence: '我们一起看吧' }, now);
  assert.deepEqual(memory.projects.start({ scope, title: '一起看动画', goal: 3, evidence: '好呀' }, now), initial);
  const casual = memory.intake({
    content: '玩笑：以后改行开花店', scope, kind: 'episodic', confidence: IntakeWeights.casual_chat,
    provenance: { origin: 'casual_chat', speaker: '用户', channel: 'group', timestamp: now.toISOString() },
  });
  assert.equal(casual.status, 'candidate');
  assert.equal(memory.project('花店', { scope }), '');
  memory.close();

  const next = open();
  try {
    const date = new Date('2026-11-08T01:00:00Z');
    assert.deepEqual(next.projects.list(scope), [initial]);
    assert.deepEqual(next.projects.list('axing_private'), []);
    const args = { scope, id: initial.id, progress: 2, note: '看了两集', evidence: '已经看完第二集' };
    assert.equal(next.projects.update({ ...args, revision: 0 }, date).status, 'stale');
    const { project } = next.projects.update({ ...args, revision: 1 }, date);
    assert.equal(project.progress, 2);
    assert.equal(next.projects.update({ ...args, progress: 3, revision: 2 }, date).project.status, 'completed');
    assert.deepEqual(readFileSync(next.store.journalPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).action),
      ['project', 'create', 'project', 'project']);
    assert.equal(next.inspect(casual.id).confidence, 0.3);
  } finally {
    next.close();
  }
});
