import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply, MemoryService } from '../lib/index.js';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-memory-'));
  const tools = new Map();
  const sections = [];
  const disposers = [];
  let memory;
  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: (section) => sections.push(section) },
    effect: (fn) => disposers.push(fn()),
    provide: (_name, service) => { memory = service; },
  }, { dataDir, scope: 'xiaoman_private' });
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const journal = () => fs.readFileSync(memory.store.journalPath, 'utf8').trim().split('\n').map(JSON.parse);
  const ftsIds = () => memory.indexer.db.prepare('SELECT id FROM fts_memories').all().map(({ id }) => id);
  const run = (name, args, source) => tools.get(name).execute(args, { source });
  return { dataDir, memory, tools, sections, journal, ftsIds, run };
}

test('自然对话更新偏好，通过一条事件覆盖并重放', async (t) => {
  const { dataDir, memory, journal, ftsIds, run } = setup(t);
  const old = memory.remember({ kind: 'preference', content: '用户最喜欢的咖啡是冰美式', tags: ['咖啡'] });
  const newContent = '用户现在主要喝乌龙茶，不再喝冰美式';
  assert.ok((await run('memory_recall', { query: '咖啡' })).message.includes(old.id));
  assert.match((await run('memory_correct', { targetId: old.id, newContent })).message, /已用新事实覆盖/);

  const [event] = journal().filter(({ action }) => action === 'supersede');
  assert.equal(journal().length, 2);
  const replacement = event.entry;
  assert.equal(replacement.supersedesId, old.id);
  assert.equal(replacement.kind, 'preference');
  assert.equal(replacement.source.evidenceText, newContent);
  const recall = await run('memory_recall', { query: '咖啡' });
  assert.ok(recall.message.includes(replacement.id));
  assert.ok(!recall.message.includes(old.id));
  assert.deepEqual(ftsIds(), [replacement.id]);
  const edge = memory.indexer.db.prepare('SELECT target_id FROM edges WHERE source_id = ? AND edge_type = ?')
    .get(replacement.id, 'supersedes');
  assert.equal(edge.target_id, old.id);
  assert.equal(memory.inspect(old.id).status, 'superseded');
  assert.equal(memory.inspect(old.id).validTo, event.timestamp);
  assert.ok(!fs.readFileSync(memory.store.factsPath, 'utf8').includes(old.id));

  // 从真源重建一个全新的索引，比较投影前后的完整旧条目。
  const rebuilt = new MemoryService({ dataDir, dbPath: ':memory:' });
  t.after(() => rebuilt.close());
  assert.deepEqual(rebuilt.inspect(old.id), memory.inspect(old.id));
  assert.deepEqual(rebuilt.recall('冰美式').entries.map(({ id }) => id), [replacement.id]);
});

test('自然遗忘移除 FTS 行和 Markdown，重建后仍不可召回', async (t) => {
  const { memory, journal, ftsIds, run } = setup(t);
  const old = memory.remember({ content: '周四的陶艺约定', kind: 'relationship' });
  assert.match((await run('memory_recall', { query: '陶艺' })).message, /陶艺约定/);
  assert.match((await run('memory_forget', { targetId: old.id, reason: '约定已经取消' })).message, /已注销/);

  assert.equal(journal().at(-1).action, 'revoke');
  assert.equal(journal().at(-1).reason, '约定已经取消');
  assert.equal(memory.inspect(old.id).status, 'revoked');
  assert.deepEqual(ftsIds(), []);
  assert.ok(!fs.readFileSync(memory.store.factsPath, 'utf8').includes(old.id));
  memory.reindex();
  assert.equal(memory.inspect(old.id).status, 'revoked');
  for (const query of ['陶艺', '周四', '约定']) {
    assert.match((await run('memory_recall', { query })).message, /未找到/);
  }
  assert.match((await run('memory_correct', { targetId: old.id, newContent: '旧事实复活' })).message, /未找到/);
  assert.equal(journal().length, 2);
});

test('群聊和私聊共享单库，可双向检索、覆盖和遗忘', async (t) => {
  const { journal, run, ftsIds } = setup(t);
  const group = { channel: 'group' };
  const direct = { channel: 'direct' };
  await run('memory_remember', { content: '周三在公园散步' }, group);
  const [first] = journal().map(({ entry }) => entry);
  assert.ok((await run('memory_recall', { query: '散步' }, direct)).message.includes(first.id));
  await run('memory_correct', { targetId: first.id, newContent: '周五在公园散步' }, direct);
  const second = journal().at(-1).entry;
  assert.ok((await run('memory_recall', { query: '散步' }, group)).message.includes(second.id));
  await run('memory_correct', { targetId: second.id, newContent: '周六在公园散步', kind: 'relationship' }, group);
  const third = journal().at(-1).entry;
  assert.ok((await run('memory_recall', { query: '散步' }, direct)).message.includes(third.id));
  assert.equal(third.kind, 'relationship');
  assert.ok(journal().every(({ entry }) => entry.scope === 'xiaoman_private'));
  assert.deepEqual(ftsIds(), [third.id]);
  await run('memory_forget', { targetId: third.id }, direct);
  assert.match((await run('memory_recall', { query: '散步' }, group)).message, /未找到/);
});

test('模型参数契约与提示词沿用宿主接口，写入沿用角色范围', async (t) => {
  const { memory, tools, sections, journal, run } = setup(t);
  assert.deepEqual(tools.get('memory_correct').parameters.required, ['targetId', 'newContent']);
  assert.deepEqual(tools.get('memory_forget').parameters.required, ['targetId']);
  assert.equal(sections.length, 1);
  for (const name of tools.keys()) {
    if (name !== 'memory_inspect') assert.ok(sections[0].text().includes(name));
  }
  const sister = memory.remember({ content: '阿醒的偏好', scope: 'axing_private' });
  const candidate = memory.remember({ content: '未确认偏好', confidence: 0.2 });
  for (const { id } of [sister, candidate]) {
    assert.match((await run('memory_correct', { targetId: id, newContent: '覆盖' })).message, /未找到/);
    assert.match((await run('memory_forget', { targetId: id })).message, /未找到/);
  }
  assert.equal(journal().length, 2);
});

test('投影更新中途失败后，重放完整事件，旧事实不会复活', async (t) => {
  const { memory, journal, ftsIds, run } = setup(t);
  const old = memory.remember({ content: '书桌原本放在客厅' });
  const upsert = memory.indexer.upsert.bind(memory.indexer);
  const mock = t.mock.method(memory.indexer, 'upsert', (entry) => {
    if (entry.supersedesId) throw new Error('simulated SQLite failure');
    upsert(entry);
  });
  await assert.rejects(run('memory_correct', { targetId: old.id, newContent: '书桌搬到了阳台' }), /simulated SQLite failure/);
  const replacement = journal().at(-1).entry;
  assert.deepEqual(ftsIds(), [old.id]); // 未提交的部分索引更新已回滚
  mock.mock.restore();
  assert.match((await run('memory_recall', { query: '书桌' })).message, /阳台/);
  assert.deepEqual(ftsIds(), [replacement.id]);
});

test('兼容旧版双行覆盖记录，空日志重放清除派生残留', (t) => {
  const { memory, journal, ftsIds } = setup(t);
  const old = memory.remember({ content: '之前常去北门' });
  const replacement = memory.correct(old.id, '现在常去南门');
  const events = journal();
  events.splice(1, 0, { ...events[1], entry: memory.inspect(old.id) });
  fs.writeFileSync(memory.store.journalPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  memory.reindex();
  assert.equal(memory.inspect(old.id).status, 'superseded');
  assert.deepEqual(ftsIds(), [replacement.id]);

  fs.writeFileSync(memory.store.journalPath, '');
  memory.initFromStore();
  assert.deepEqual(ftsIds(), []);
  assert.ok(!fs.readFileSync(memory.store.factsPath, 'utf8').includes(replacement.id));
});
