import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply, MemoryService } from '../lib/index.js';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'natural-memory-'));
  const tools = new Map();
  const sections = [];
  const listeners = new Map();
  const disposers = [];
  let memory;
  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: (section) => sections.push(section) },
    on: (event, handler) => listeners.set(event, handler),
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
  const emit = (agent, event) => listeners.get('session/event')(agent.session, event);
  const claim = (agent, message) => listeners.get('agent/inbox/claimed')({ agent, message });
  return { dataDir, memory, tools, sections, journal, ftsIds, run, emit, claim };
}

const time = Date.parse('2026-11-06T08:00:00.000Z');

function userMessage(text, { channel = 'direct', speaker = 'user', prefix = '' } = {}) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prefix + text }],
    source: { kind: 'user', qq: { channel, speaker, start: prefix.length, length: text.length } },
  };
}

function enter(h, agent, text, options) {
  const message = userMessage(text, options);
  h.claim(agent, message);
  h.emit(agent, { type: 'user/message', time, data: message });
}

test('精选摄取从当前发言取证，来源、重要性和置信度随 journal 重建', async (t) => {
  const h = setup(t);
  const agent = { id: 'group-session', session: {} };
  const otherAgent = { id: 'direct-session', session: {} };
  const intake = h.tools.get('memory_intake');
  const accept = (args) => intake.execute(args, { agent });
  const preference = { content: '小舟不喜欢香菜', kind: 'preference', origin: 'user_statement', evidence: '我不喜欢香菜', importance: 0.6 };
  enter(h, agent, '早安！', { channel: 'group', speaker: '小舟', prefix: '群历史：我不喜欢香菜\n' });
  assert.deepEqual(await accept(preference), { stored: false });
  const message = userMessage('其实我不喜欢香菜。', { channel: 'group', speaker: '小舟' });
  h.claim(agent, message);
  assert.deepEqual(await accept(preference), { stored: false });
  h.emit(agent, { type: 'user/message', time, data: message });
  assert.deepEqual(await intake.execute(preference, { agent: otherAgent }), { stored: false });
  assert.deepEqual(await intake.execute(preference, { agent, signal: AbortSignal.abort() }), { stored: false });
  assert.deepEqual(await accept({ ...preference, evidence: '我最喜欢香菜' }), { stored: false });
  assert.deepEqual(await accept(preference), { stored: true });
  assert.deepEqual(await accept(preference), { stored: false });

  enter(h, agent, '我们说定以后每年一起种一棵桂花树。', { channel: 'group', speaker: '小舟' });
  const commitment = { content: '我们说定以后每年一起种一棵桂花树', kind: 'relationship',
    evidence: '每年一起种一棵桂花树', origin: 'shared_experience' };
  assert.deepEqual(await accept(commitment), { stored: true });

  enter(h, otherAgent, '我终于拿到潜水教练证了！');
  const milestone = { content: '用户终于拿到潜水教练证了', kind: 'episodic', origin: 'user_statement', evidence: '我终于拿到潜水教练证了' };
  const inference = { ...milestone, content: '用户可能想长期从事潜水教学', origin: 'model_inference', importance: 1 };
  assert.deepEqual(await intake.execute(milestone, { agent: otherAgent }), { stored: true });
  assert.deepEqual(await intake.execute(inference, { agent: otherAgent }), { stored: true });
  assert.deepEqual(await intake.execute(inference, { agent: otherAgent }), { stored: false });
  h.emit(otherAgent, { type: 'turn/end' });
  assert.deepEqual(await intake.execute({ ...milestone, content: '另一条' }, { agent: otherAgent }), { stored: false });
  assert.deepEqual(intake.output.render({}, { stored: true }), []);

  const [direct, shared, episode, candidate] = h.journal().map(({ entry }) => entry);
  assert.deepEqual(direct.provenance, { origin: 'user_request', claimType: 'user_statement', evidenceStatus: 'resolved' });
  assert.equal(direct.source.speaker, '小舟');
  assert.equal(direct.source.channel, 'group');
  assert.equal(direct.source.messageId, message.id);
  assert.equal(direct.source.observedAt, new Date(time).toISOString());
  assert.equal(direct.source.evidenceText, preference.evidence);
  assert.equal(direct.confidence, 0.95);
  assert.equal(direct.importance, 0.6);
  assert.equal(direct.confirmed, true);
  assert.equal(shared.provenance.claimType, 'observation');
  assert.equal(episode.source.channel, 'direct');
  assert.equal(episode.confirmed, true);
  assert.equal(candidate.provenance.claimType, 'model_inference');
  assert.equal(candidate.status, 'candidate');
  assert.equal(candidate.importance, 1);
  assert.ok(candidate.confidence < shared.confidence);
  h.memory.reindex();
  assert.deepEqual(h.memory.inspect(direct.id), direct);
  assert.deepEqual(h.memory.inspect(candidate.id), candidate);
  assert.equal(h.memory.recall('潜水教学').entries.some(({ id }) => id === candidate.id), false);
});

test('提示词只投影当前发言相关的生效记忆，私聊可接续群聊，回合结束清空', async (t) => {
  const h = setup(t);
  const group = { id: 'group', session: {} };
  const direct = { id: 'direct', session: {} };
  const prompt = (agent) => h.sections[0].text({ agent }).split('\n').find((line) => line.startsWith('[小满的回忆:')) || '';
  enter(h, group, '我最喜欢的动漫是EVA。', { channel: 'group', speaker: '小舟' });
  await h.tools.get('memory_intake').execute({
    content: '小舟最喜欢的动漫是EVA', kind: 'preference', origin: 'user_statement', evidence: '我最喜欢的动漫是EVA',
  }, { agent: group });
  h.memory.remember({ content: 'EVA 首映那天一起喝了汽水' });
  h.memory.remember({ content: 'EVA 私有', scope: 'axing_private' });
  h.memory.remember({ content: 'EVA 推断', confidence: 0.2 });
  const old = h.memory.remember({ content: 'EVA 已作废' });
  h.memory.revoke(old.id);
  h.memory.remember({ content: '只在引用里出现的香菜' });

  // The host assembles the prompt before it logs the accepted user message.
  h.claim(direct, userMessage('最近想重看EVA', { prefix: '引用：香菜\n' }));
  assert.match(prompt(direct), /小舟最喜欢的动漫是EVA/);
  assert.match(prompt(direct), /一起喝了汽水/);
  assert.doesNotMatch(prompt(direct), /私有|推断|作废|香菜/);
  assert.equal(prompt({ session: {} }), '');
  h.emit(direct, { type: 'turn/end' });
  assert.equal(prompt(direct), '');
  enter(h, direct, '晚安。', { prefix: '群历史：EVA\n' });
  assert.equal(prompt(direct), '');
  enter(h, direct, '明天有空吗');
  assert.equal(prompt(direct), '');
});

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
  const h = setup(t);
  const { journal, run, ftsIds } = h;
  const group = { id: 'group', session: {} };
  const direct = { channel: 'direct' };
  enter(h, group, '我周三在公园散步。', { channel: 'group', speaker: '小舟' });
  await h.tools.get('memory_remember').execute({ content: '小舟周三在公园散步' }, { agent: group });
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
  const { action, timestamp, entry } = events[1];
  events[1] = { action, timestamp, entry };
  events.splice(1, 0, { action: 'update', timestamp, entry: memory.inspect(old.id) });
  fs.writeFileSync(memory.store.journalPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  memory.reindex();
  assert.equal(memory.inspect(old.id).status, 'superseded');
  assert.deepEqual(ftsIds(), [replacement.id]);

  fs.writeFileSync(memory.store.journalPath, '');
  memory.initFromStore();
  assert.deepEqual(ftsIds(), []);
  assert.ok(!fs.readFileSync(memory.store.factsPath, 'utf8').includes(replacement.id));
});
