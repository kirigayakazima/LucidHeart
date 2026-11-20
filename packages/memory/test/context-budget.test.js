import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { apply } from '../lib/index.js';
import { estimateTokens, formatCompactOutline, pruneToolOutput } from '../lib/budget.js';
import { retainCheckpointFact } from '../lib/intake.js';
import { ContextHygiene, measureContext } from '../lib/context_hygiene.js';
import { continuityIdentity, WorkingMemory, renderWorkingMemory } from '../lib/working_memory.js';

const scope = 'xiaoman_private';
const line = text => ({ type: 'text', text });
const image = { type: 'image', attachment: { id: 'fixture-image' } };
const qq = (id, text, targetId = 'owner', speakerId = targetId, channel = 'direct') => ({
  id, role: 'user', content: [line(text)], source: { kind: 'user', qq: {
    targetId, speakerId, channel, speaker: 'same display name', start: 0, length: text.length,
  } },
});

function addTurn(events, messages, number, user, answer = [line('好的')], result) {
  const assistant = { id: 'a' + number, role: 'assistant', content: answer };
  events.push({ type: 'turn/start', data: { turn: number } }, { type: 'user/message', data: user },
    { type: 'assistant/message', data: { turn: number, message: assistant } });
  messages.push(user, assistant);
  if (result) {
    const id = 'call' + number;
    assistant.content = [...answer, { type: 'tool-call', id, name: result.name, arguments: '{}' }];
    events.push({ type: 'tool/call', data: { callId: id, name: result.name } });
    const receipt = { id: 'receipt' + number, role: 'user', source: { kind: 'tool', callId: id },
      content: [{ type: 'tool-result', toolCallId: id, content: result.blocks }] };
    events.push({ type: 'tool/result', data: { message: receipt }, time: Date.parse('2026-11-20T10:08:00+08:00') });
    messages.push(receipt);
  }
  events.push({ type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } });
}

test('25 turns batch-fold old window receipts and images, preserving call IDs and the last two turns', () => {
  const events = [], messages = [];
  const hygiene = new ContextHygiene();
  for (let turn = 1; turn <= 25; turn++) {
    const snapshot = [2, 4, 6, 8, 24].includes(turn);
    const windows = [3, 5, 7, 9, 11, 25].includes(turn);
    addTurn(events, messages, turn, qq('u' + turn, '看看当前情况'), undefined, snapshot
      ? { name: 'pc_snapshot', blocks: [image] }
      : windows ? { name: 'pc_list_windows', blocks: [line('窗口列表：' + '旧网关窗口信息'.repeat(750))] } : null);
    if (turn === 8) assert.strictEqual(hygiene.project(messages, events), messages);
  }
  const raw = JSON.stringify(messages);
  const view = hygiene.project(messages, events);
  const recent = messages.slice(messages.findIndex(message => message.id === 'u24'));
  assert.ok(1 - measureContext(view).tokens / measureContext(messages).tokens >= 0.55);
  assert.deepEqual(view.slice(-recent.length), recent);
  assert.equal(view.find(item => item.id === 'receipt2').content[0].toolCallId, 'call2');
  assert.match(view.find(item => item.id === 'receipt2').content[0].content[0].text, /pc_snapshot @ 10:08/u);
  assert.equal(JSON.stringify(messages), raw);
  assert.equal(JSON.stringify(hygiene.project(messages, events)), JSON.stringify(view));
  addTurn(events, messages, 26, qq('u26', '再来一轮'));
  assert.equal(JSON.stringify(hygiene.project(messages, events).slice(0, view.length)), JSON.stringify(view));
});

test('28K can fold fewer receipts and compact recall obeys its configured hard ceiling', () => {
  const events = [], messages = [];
  for (let turn = 1; turn < 4; turn++) addTurn(events, messages, turn, qq('u' + turn, '好'), undefined,
    turn === 1 ? { name: 'pc_list_windows', blocks: [line('窗口'.repeat(25_000))] } : null);
  assert.ok(measureContext(new ContextHygiene().project(messages, events)).tokens < 300);
  assert.equal(pruneToolOutput('a'.repeat(500), 10).length, 10);
  assert.ok(pruneToolOutput('人'.repeat(500), 240).length <= 240);
  const facts = Array.from({ length: 50 }, (_, i) => ({ id: 'fact' + i, kind: 'fact', content: '长期偏好'.repeat(10) }));
  assert.ok(estimateTokens(formatCompactOutline(facts, { maxTokens: 1000 }).text) <= 300);
});

test('checkpoint writes only the current verified new fact and never restores or supersedes one', t => {
  const { memory } = harness(t);
  const retain = (id, text) => {
    const events = [];
    addTurn(events, [], 1, qq(id, text));
    events.find(event => event.type === 'user/message').time = Date.now();
    return retainCheckpointFact(memory, events, { scope, messageId: id, sessionId: 'checkpoint' });
  };
  assert.equal(retain('hypothesis', '请记住，我可能住在杭州'), false);
  assert.equal(retain('original', '请记住，我住在广州'), true);
  const original = memory.indexer.getAllActive()[0];
  assert.equal(original.provenance.claimType, 'user_statement');
  assert.equal(original.source.messageId, 'original');
  assert.equal(retain('conflict', '请记住，我住在杭州'), false);
  memory.revoke(original.id);
  assert.equal(retain('deleted', '请记住，我住在广州'), false);
  assert.equal(memory.indexer.getAllActive().length, 0);
});

function harness(t, compaction) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-context-'));
  const listeners = new Map(), tools = new Map(), dispose = [];
  let memory;
  apply({
    on: (event, handler) => listeners.set(event, handler),
    provide: (_name, service) => { memory = service; },
    tools: { register: tool => tools.set(tool.name, tool) },
    effect: setup => dispose.push(setup()),
    get: name => name === 'compaction' ? compaction : undefined,
  }, { dataDir: root, scope });
  t.after(() => {
    for (const close of dispose.reverse()) if (typeof close === 'function') close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, memory, tools, emit: (event, ...args) => listeners.get(event)(...args) };
}

test('working memory is isolated, byte-bounded, and enters a frozen host message once per session epoch', async t => {
  const h = harness(t);
  const store = new WorkingMemory(h.root);
  const initial = qq('old', '一起看了电影');
  const identity = continuityIdentity(initial, scope, 'previous');
  store.save(identity, {
    current_focus: ['一起看了电影', '😀'.repeat(100)],
    recent_media: [{ title: '片尾', albumId: 'alb_01234567' }],
    open_threads: ['选下一部'],
    recent_exchanges: Array(5).fill('一起看了电影' + '😀'.repeat(100)),
  });
  assert.ok(Buffer.byteLength(renderWorkingMemory(store.load(identity))) <= 800);
  assert.equal(store.load({ ...identity, scope: 'axing_private' }), null);
  assert.equal(store.load({ ...identity, speaker: 'stranger' }), null);
  assert.equal(store.load({ ...identity, channel: 'group' }), null);
  const agent = { session: { id: 'new', events: [] } };
  const stranger = qq('stranger', '你好', 'stranger');
  h.emit('agent/inbox/claimed', { agent: { session: { id: 'another' } }, message: stranger });
  assert.equal(stranger.content[0].text, '你好');
  const message = qq('current', '还有什么片');
  Object.freeze(message.content[0]);
  Object.freeze(message.source.qq);
  Object.freeze(message);
  h.emit('agent/inbox/claimed', { agent, message });
  const decision = await h.emit('agent/pre-step', { agent }, async () => ({ kind: 'enter', messages: [message] }));
  const projected = decision.messages[0];
  assert.match(projected.content[0].text, /近期工作记忆/u);
  assert.equal(projected.content[0].text.slice(projected.source.qq.start), '还有什么片');
  assert.equal(message.source.qq.start, 0);
  const next = qq('next', '继续');
  h.emit('agent/inbox/claimed', { agent, message: next });
  assert.equal(next.content[0].text, '继续');
  h.emit('session/event', agent.session, { type: 'user/message', surfaceOp: { op: 'replace' } });
  h.emit('agent/inbox/claimed', { agent, message: next });
  assert.match(next.content[0].text, /近期工作记忆/u);
});

for (const native of [false, true]) test(`42K saves isolated L1 and ${native ? 'uses native compact' : 'reports manual compaction'}`, async t => {
  const compacted = Promise.withResolvers();
  const h = harness(t, native ? { compactNow: async ({ session, runMaintenance }) => runMaintenance(async () => {
    compacted.resolve(session);
    return { shadowedSeqs: [1, 2] };
  }) } : undefined);
  const events = [], messages = [], session = { id: 'context-session', events, messages };
  const agent = { session, async runMaintenance(task) { return task(); } };
  const user = qq('u1', '我们先聊电影');
  h.emit('agent/inbox/claimed', { agent, message: user });
  addTurn(events, messages, 1, user, [line('a'.repeat(175_000))]);
  const options = { sessionId: session.id, system: 'STATIC', messages: messages.slice() };
  h.emit('llm/stream', options, () => {});
  assert.equal(options.system, 'STATIC');
  const journal = h.memory.store.journalPath;
  const before = fs.existsSync(journal) ? fs.readFileSync(journal) : null;
  h.emit('session/event', session, events.at(-1));
  const store = new WorkingMemory(h.root);
  const identity = continuityIdentity(user, scope, session.id);
  for (let i = 0; i < 50 && !store.load(identity); i++) await delay(10);
  assert.ok(store.load(identity)?.recent_exchanges[0].startsWith('我们先聊电影'));
  if (native) assert.equal(await compacted.promise, session);
  const health = await h.tools.get('memory_context_health').execute({}, { agent });
  assert.ok(health.rawTokens >= 42_000);
  assert.equal(health.imageCount, 0);
  assert.equal(health.checkpoint?.status, native ? undefined : 'manual');
  assert.deepEqual(fs.existsSync(journal) ? fs.readFileSync(journal) : null, before);
});
