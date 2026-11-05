import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

test('model recall and inspect obey the configured scope and hide revoked/candidate/superseded content', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-scope-'));
  const tools = new Map(), disposers = [];
  let memory;
  t.after(() => { disposers.reverse().forEach(fn => fn?.()); fs.rmSync(dataDir, { recursive: true, force: true }); });
  apply({ tools: { register(tool) { tools.set(tool.name, tool); } }, effect(fn) { disposers.push(fn()); },
    provide(_name, service) { memory = service; } }, { dataDir, scope: 'xiaoman_private' });
  const own = memory.remember({ content: '测试偏好清淡茶', scope: 'xiaoman_private' });
  const sister = memory.remember({ content: '测试偏好私人标记 AXING_PRIVATE', scope: 'axing_private' });
  const shared = memory.remember({ content: '测试偏好共享茶', scope: 'shared' });
  const revoked = memory.remember({ content: '测试偏好 REVOKED' }); memory.revoke(revoked.id);
  const candidate = memory.remember({ content: '测试偏好 CANDIDATE', confidence: .1 });
  const old = memory.remember({ content: '测试偏好 OLD' }); memory.correct(old.id, '测试偏好 NEW');
  const recall = await tools.get('memory_recall').execute({ query: '测试偏好', limit: 20 });
  assert.ok(!recall.message.includes('AXING_PRIVATE')); assert.ok(!recall.message.includes('REVOKED'));
  for (const item of [sister, revoked, candidate, old]) {
    const result = await tools.get('memory_inspect').execute({ id: item.id });
    assert.equal(result.message, '未找到当前范围内可用的记忆条目。');
  }
  for (const item of [own, shared]) assert.ok((await tools.get('memory_inspect').execute({ id: item.id })).message.includes(item.content));
  // Core inspect remains an administrative audit API; only the model-facing surface changes.
  assert.equal(memory.inspect(revoked.id).status, 'revoked');
});
