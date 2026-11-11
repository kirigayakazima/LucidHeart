import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply, MemoryService } from '../lib/index.js';
import { HeartService } from '../../heart/lib/service.js';
import { maybeTrigger, readTrigger } from '../../heart/lib/trigger.js';

function setup(t, heart) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commitments-'));
  const tools = new Map();
  const listeners = new Map();
  const disposers = [];
  let memory;
  let section;
  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: (def) => { section = def; } },
    on: (event, handler) => listeners.set(event, handler),
    effect: (fn) => disposers.push(fn()),
    provide: (_name, service) => { memory = service; },
    get: (name) => name === 'heart' ? heart : undefined,
  }, { dataDir, scope: 'xiaoman_private' });
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = { id: 'test', session: {} };
  const emit = (event, target = agent) => listeners.get('session/event')(target.session, event);
  const turn = (text, { target = agent, channel = 'direct', speaker = '小舟', prefix = '', time = Date.now() } = {}) => {
    const message = {
      id: randomUUID(), role: 'user', content: [{ type: 'text', text: prefix + text }],
      source: { kind: 'user', qq: { channel, speaker, start: prefix.length, length: text.length } },
    };
    listeners.get('agent/inbox/claimed')({ agent: target, message });
    emit({ type: 'user/message', data: message, time }, target);
  };
  return {
    dataDir, memory, tools, agent, emit, turn,
    claim: (message, target = agent) => listeners.get('agent/inbox/claimed')({ agent: target, message }),
    run: async (name, args, execution = { agent }) => {
      const result = await tools.get(name).execute(args, execution);
      assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
      return result;
    },
    prompt: (target = agent, signal) => section.text({ agent: target, signal }),
    journal: () => fs.readFileSync(memory.store.journalPath, 'utf8').trim().split('\n').map(JSON.parse),
  };
}

test('承诺共用 journal，履约和取消可重放，终态重试幂等', (t) => {
  const { memory, dataDir, journal } = setup(t);
  const at = Date.parse('2026-11-07T20:00:00+08:00');
  const request = { title: '一起看新番', targetTime: '2026-11-08T20:00:00', evidence: '明晚一起看新番', channel: 'group' };
  const first = memory.commitments.record(request, at);
  assert.match(first.id, /^cmt_/);
  assert.deepEqual(first, { ...request, id: first.id, initiator: 'user', createdAt: new Date(at).toISOString(), status: 'pending' });
  assert.equal(memory.commitments.record({ ...request, channel: 'direct' }, at).id, first.id);
  const second = memory.commitments.record({ title: '唱樱花草', evidence: '改天给我唱樱花草', channel: 'direct', initiator: 'xiaoman' }, at);
  const completed = memory.commitments.resolve(first.id, 'fulfilled', '一起看完了', at + 500);
  assert.equal(completed.fulfilledAt, new Date(at + 500).toISOString());
  assert.deepEqual(memory.commitments.resolve(first.id, 'fulfilled', '重试', at + 1000), completed);
  assert.equal(memory.commitments.resolve(first.id, 'cancelled', '已履约'), undefined);
  assert.equal(memory.commitments.resolve(second.id, 'cancelled', '改约').fulfilledAt, undefined);
  assert.equal(journal().length, 4);
  assert.equal(journal()[2].reason, '一起看完了');
  assert.ok(journal().every(({ action }) => action === 'commitment'));
  assert.ok(!fs.existsSync(path.join(dataDir, 'commitments.jsonl')));
  assert.deepEqual(memory.recall('新番').entries, []);
  assert.doesNotMatch(fs.readFileSync(memory.store.factsPath, 'utf8'), /新番|樱花草/);

  const rebuilt = new MemoryService({ dataDir, dbPath: ':memory:' });
  t.after(() => rebuilt.close());
  assert.deepEqual(rebuilt.commitments.get(first.id), completed);
  assert.equal(rebuilt.commitments.get(second.id).status, 'cancelled');
  assert.equal(rebuilt.commitments.project(at), '');
});

test('提醒按上海日期与 24 小时边界筛选，逾期仍可补记履约', (t) => {
  const { memory } = setup(t);
  const { commitments } = memory;
  const now = Date.parse('2026-11-07T20:00:00+08:00');
  const record = (title, targetTime) => commitments.record({ title, targetTime, evidence: title, channel: 'direct' }, now);
  record('较远的约定', '2026-11-08T20:00:01+08:00');
  record('未定时', '改天');
  record('无效日期', '2026-02-30');
  assert.equal(commitments.project(now), '');
  const tomorrow = record('看新番', '2026-11-08T12:00:00Z');
  assert.equal(commitments.project(now), '[待续接的约定: 11/8 20:00 看新番]');
  const today = record('今天交稿', '2026-11-07');
  assert.equal(commitments.get(today.id, now).status, 'pending');
  assert.equal(commitments.project(now), '[待续接的约定: 11-07 今天交稿]');
  commitments.resolve(tomorrow.id, 'cancelled', '档期有变', now);
  assert.equal(commitments.get(today.id, Date.parse('2026-11-08T00:00:00+08:00')).status, 'expired');
  assert.match(commitments.project(Date.parse('2026-11-09T20:00:00+08:00')), /逾期/);
  assert.equal(commitments.resolve(today.id, 'fulfilled', '已补交', now + 24 * 60 * 60 * 1000).status, 'fulfilled');
});

test('承诺登记刷盘结果不明时，重试复用已写入的事件', (t) => {
  const { memory, journal } = setup(t);
  const append = memory.store.appendJournal.bind(memory.store);
  const failure = t.mock.method(memory.store, 'appendJournal', (...args) => {
    append(...args);
    throw new Error('simulated flush failure');
  });
  const request = { title: '一起去公园', evidence: '约好去公园', channel: 'direct' };
  assert.throws(() => memory.commitments.record(request), /simulated flush failure/);
  const [{ entry }] = journal();
  failure.mock.restore();
  assert.equal(memory.commitments.record(request).id, entry.id);
  assert.equal(journal().length, 1);
});

test('关怀优先最近 24 小时内的待兑现项，再选最近逾期项，跳过已结算条目', (t) => {
  const { memory, journal } = setup(t);
  const ledger = memory.commitments;
  const now = new Date('2026-11-07T16:15:00Z'); // 上海已经是 11 月 8 日。
  const record = (title, targetTime) => ledger.record({ title, targetTime, evidence: title, channel: 'direct' }, +now);
  record('超过一天', '2026-11-09T00:15:00.001');
  record('未定日期', '改天');
  record('较早逾期', '2026-11-07T23:00:00');
  const overdue = record('刚刚逾期', '2026-11-07');
  const edge = record('刚好 24 小时', '2026-11-09T00:15:00');
  const nearest = record('今天喝水', '2026-11-07T16:25:00Z');
  const resolved = record('已完成', '2026-11-08T00:15:00');
  const cancelled = record('已取消', '2026-11-08T00:16:00');
  ledger.resolve(resolved.id, 'fulfilled', '', +now);
  ledger.resolve(cancelled.id, 'cancelled', '', +now);
  const select = () => ledger.getActiveCommitmentCare(now, 'Asia/Shanghai');
  const journalBefore = journal();
  assert.deepEqual(select(), nearest);
  assert.deepEqual(journal(), journalBefore);
  ledger.resolve(nearest.id, 'fulfilled', '', +now);
  assert.deepEqual(select(), edge);
  ledger.resolve(edge.id, 'cancelled', '', +now);
  assert.deepEqual(select(), { ...overdue, status: 'expired' });
  ledger.resolve(overdue.id, 'fulfilled', '', +now);
  assert.equal(select().title, '较早逾期');
  ledger.resolve(select().id, 'cancelled', '', +now);
  assert.equal(select(), null);
});

test('Heart 返回和空闲回合各注入一条关怀，人工消息与其他会话不继承背景', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commitment-care-heart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessionsRoot = path.join(root, 'sessions');
  const sessionDir = path.join(sessionsRoot, 'workspace', 'session-test');
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl'), '');
  const config = { sessionsRoot, triggerCooldownMinutes: 60, timeZone: 'Asia/Shanghai' };
  const heart = new HeartService(null, root, config);
  const h = setup(t, heart);
  const start = Date.parse('2026-11-07T22:00:00Z'); // 上海 06:00，先登记后等待早晨。
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const title = '早上记得给猫喂食';
  h.turn(`好，${title}。`);
  const { id } = await h.run('commitment_record', { title, targetTime: '2026-11-08T10:30:00', evidence: title });
  h.memory.commitments.record({ title: '下午看新番', targetTime: '2026-11-08T15:00:00', evidence: '约好看新番', channel: 'direct' });
  const originalJournal = h.journal();
  const messages = [];
  h.agent.followup = (message) => messages.push(message);
  const ctx = { agents: { list: () => [h.agent] }, get: (name) => name === 'memory' ? h.memory : undefined };
  const next = { presence: 'present', sinceMsgMin: 90 };
  const other = { id: 'other', session: {} };

  for (const [iso, presence, cue] of [
    ['2026-11-08T01:00:00Z', 'away', '对方刚回来'],
    ['2026-11-08T04:00:00Z', 'present', '对方有一阵没说话了'],
  ]) {
    const now = new Date(iso);
    t.mock.timers.setTime(+now);
    const prev = { presence, at: new Date(+now - 60_000).toISOString(), awaySince: new Date(+now - 3_600_000).toISOString() };
    assert.equal(await maybeTrigger(ctx, root, prev, next, config, now, heart), true);
    const [message] = messages.splice(0);
    assert.ok(message.content[0].text.includes(cue));
    assert.doesNotMatch(message.content[0].text, /喂食/);
    h.claim(message, other);
    assert.doesNotMatch(h.prompt(other), /主动生活关怀背景:/);
    h.claim(message);
    const expected = '[主动生活关怀背景: 你之前与对方约定了「早上记得给猫喂食」（时间: 2026-11-08T10:30:00）。打招呼时请自然问起进展，语气亲昵贴心，不要像系统通知。]';
    const prompt = h.prompt();
    if (presence === 'away') {
      assert.deepEqual(prompt.split('\n').filter((line) => line.startsWith('[主动生活关怀背景:')), [expected]);
      assert.doesNotMatch(prompt, /下午看新番/);
    } else {
      assert.match(prompt, /主动生活关怀背景: .*下午看新番/); // 临近履约优先于逾期。
      assert.doesNotMatch(prompt, /喂食/);
    }
    assert.doesNotMatch(h.prompt(h.agent, AbortSignal.abort()), /主动生活关怀背景:/);
    h.emit({ type: 'turn/end' });
    assert.doesNotMatch(h.prompt(), /主动生活关怀背景:/);
    h.claim(message);
    assert.doesNotMatch(h.prompt(), /主动生活关怀背景:/);
  }
  assert.equal(readTrigger(root).idleCount, 2);
  assert.deepEqual(h.journal(), originalJournal);
  assert.doesNotMatch(fs.readFileSync(h.memory.store.factsPath, 'utf8'), /喂食|新番/);
  h.claim({ source: { kind: 'schedule' }, id: 'another-schedule' });
  assert.doesNotMatch(h.prompt(), /主动生活关怀背景:/);
  h.turn('刚刚已经喂过猫了。');
  assert.doesNotMatch(h.prompt(), /主动生活关怀背景:/);
  assert.deepEqual(await h.run('commitment_resolve', { id, status: 'fulfilled' }), { id, status: 'fulfilled' });
});

test('群聊登记、私聊问候触发一条提醒，取证、Heart 门控与工具核销沿用真实回合', async (t) => {
  let asleep = false;
  let quiet = false;
  const h = setup(t, {
    getSnapshot: () => ({ presence: { status: asleep ? 'asleep' : 'present' } }),
    evaluateActivity(_intent, { execution }) {
      assert.equal(execution.agent.session.messages[0].source.kind, 'user');
      return { suitable: !quiet };
    },
  });
  const direct = { id: 'direct', session: {} };
  const title = '一起看{{新番}}\n' + '🌙'.repeat(20);
  const args = { title, targetTime: new Date(Date.now() + 600_000).toISOString(), evidence: '一起看新番' };
  h.turn('有空吗？', { channel: 'group', prefix: '引用：一起看新番\n' });
  assert.deepEqual(await h.run('commitment_record', args), {});
  h.turn('好，今晚一起看新番。', { channel: 'group' });
  const recorded = await h.run('commitment_record', args);
  assert.equal(recorded.status, 'pending');
  assert.equal(h.memory.commitments.get(recorded.id).channel, 'group');
  assert.deepEqual(h.tools.get('commitment_record').output.render({}, recorded), []);
  assert.doesNotMatch(h.prompt(direct), /待续接的约定:/);
  h.turn('你好！', { target: direct });
  const lines = h.prompt(direct).split('\n').filter((line) => line.startsWith('[待续接的约定:'));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 40);
  assert.match(lines[0], /｛｛新番｝｝/);
  assert.doesNotMatch(h.prompt(direct, AbortSignal.abort()), /待续接的约定:/);
  asleep = true;
  assert.doesNotMatch(h.prompt(direct), /待续接的约定:/);
  asleep = false;
  quiet = true;
  assert.doesNotMatch(h.prompt(direct), /待续接的约定:/);
  quiet = false;

  h.turn('刚刚已经一起看完新番了。', { target: direct });
  const found = await h.run('memory_recall', { query: '新番' }, { agent: direct });
  assert.ok(found.message.includes(recorded.id));
  const resolved = await h.run('commitment_resolve', { id: recorded.id, status: 'fulfilled', note: '一起看完了' }, { agent: direct });
  assert.deepEqual(resolved, { id: recorded.id, status: 'fulfilled' });
  assert.doesNotMatch(h.prompt(direct), /待续接的约定:/);
  h.emit({ type: 'turn/end' }, direct);
  assert.deepEqual(await h.run('commitment_resolve', { id: recorded.id, status: 'cancelled' }, { agent: direct }), {});
});

test('摄取戒辣偏好用一条事件覆盖多条旧偏好，更新 FTS、Markdown 并从 journal 重建', async (t) => {
  const h = setup(t);
  const legacy = h.memory.remember({ kind: 'preference', content: '用户喜欢吃微辣' });
  const also = h.memory.remember({ kind: 'fact', content: '我偏好微辣' });
  const otherScope = h.memory.remember({ kind: 'preference', content: legacy.content, scope: 'shared' });
  h.turn('我最近戒辣了，一点辣都不能吃。');
  const args = { kind: 'preference', origin: 'user_statement', content: '用户最近戒辣了，一点辣都不能吃', evidence: '我最近戒辣了，一点辣都不能吃' };
  assert.deepEqual(await h.run('memory_intake', args), { stored: true });
  assert.deepEqual(await h.run('memory_intake', args), { stored: false });
  const events = h.journal();
  assert.equal(events.length, 4);
  const { action, entry: replacement } = events.at(-1);
  assert.equal(action, 'supersede');
  assert.deepEqual(new Set(replacement.supersedesIds), new Set([legacy.id, also.id]));
  for (const old of [legacy, also]) {
    assert.equal(h.memory.inspect(old.id).status, 'superseded');
    assert.equal(h.memory.inspect(old.id).supersededBy, replacement.id);
  }
  assert.deepEqual(h.memory.indexer.search('辣').map(({ id }) => id).sort(), [replacement.id, otherScope.id].sort());
  const markdown = fs.readFileSync(h.memory.store.factsPath, 'utf8');
  assert.ok(markdown.includes(replacement.id) && !markdown.includes(legacy.id) && !markdown.includes(also.id));
  const rebuilt = new MemoryService({ dataDir: h.dataDir, dbPath: ':memory:' });
  t.after(() => rebuilt.close());
  assert.deepEqual(rebuilt.inspect(legacy.id), h.memory.inspect(legacy.id));
  assert.deepEqual(rebuilt.inspect(also.id), h.memory.inspect(also.id));
  assert.deepEqual(rebuilt.indexer.search('辣').map(({ id }) => id).sort(), [replacement.id, otherScope.id].sort());
});

test('住址和作息可在群聊与私聊间更新，兼容偏好、其他发言者、旧回合和推断受到约束', async (t) => {
  const h = setup(t);
  const put = async (content, options, kind = 'fact', origin = 'user_statement') => {
    h.turn(content, options);
    return h.run('memory_intake', { content, evidence: content, kind, origin });
  };
  await put('小舟住在杭州', { channel: 'group', time: 1000 });
  const oldAddress = h.journal().at(-1).entry;
  await put('我已经搬到上海了', { time: 3000 });
  const newAddress = h.journal().at(-1).entry;
  assert.equal(h.memory.inspect(oldAddress.id).supersededBy, newAddress.id);
  assert.deepEqual(await put('我住在苏州', { time: 2000 }), { stored: false });
  await put('我住在北京', { channel: 'group', speaker: '小陆', time: 4000 });
  await put('我住在广州', { time: 5000 }, 'fact', 'model_inference');
  assert.equal(h.journal().at(-1).entry.status, 'candidate');
  assert.equal(h.memory.inspect(newAddress.id).status, 'active');

  await put('我每天晚上十点睡觉');
  const oldBedtime = h.journal().at(-1).entry;
  await put('我每天晚上十一点睡觉', { channel: 'group' });
  assert.equal(h.memory.inspect(oldBedtime.id).status, 'superseded');
  await put('我喜欢喝乌龙茶', {}, 'preference');
  const tea = h.journal().at(-1).entry;
  await put('我喜欢喝冰红茶', {}, 'preference');
  assert.equal(h.memory.inspect(tea.id).status, 'active');
  await put('我不再喜欢喝乌龙茶', {}, 'preference');
  assert.equal(h.memory.inspect(tea.id).status, 'superseded');
});

test('自动覆盖的 FTS 事务失败后可重放，重试不会多写一条', async (t) => {
  const h = setup(t);
  const old = h.memory.remember({ content: '用户住在杭州' });
  const write = h.memory.indexer.upsert.bind(h.memory.indexer);
  const fail = t.mock.method(h.memory.indexer, 'upsert', (entry) => {
    if (entry.supersedesId === old.id) throw new Error('simulated FTS failure');
    write(entry);
  });
  const content = '用户住在上海';
  h.turn('我住在上海');
  const args = { content, evidence: '我住在上海', kind: 'fact', origin: 'user_statement' };
  await assert.rejects(h.run('memory_intake', args), /simulated FTS failure/);
  const replacement = h.journal().at(-1).entry;
  assert.throws(() => h.memory.indexer.search('住在'), { code: 'MEMORY_PROJECTION_UNAVAILABLE' });
  assert.deepEqual(h.memory.indexer.db.prepare('SELECT id FROM fts_memories').all().map(({ id }) => id), [old.id]);
  fail.mock.restore();
  assert.deepEqual(await h.run('memory_intake', args), { stored: false });
  assert.equal(h.journal().length, 2);
  assert.equal(h.memory.inspect(old.id).supersededBy, replacement.id);
  assert.deepEqual(h.memory.indexer.search('住在').map(({ id }) => id), [replacement.id]);
});
