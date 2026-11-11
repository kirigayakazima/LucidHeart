import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { apply, resolveHostContext } from '../lib/index.js';

const require = createRequire(import.meta.url);
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-tools'));
const { Session } = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-session')));

function qq(text, { channel = 'group', speaker = '小舟', prefix = '' } = {}) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: prefix + text }],
    source: { kind: 'user', qq: { channel, speaker, start: prefix.length, length: text.length } } };
}

function liveTurn(message, { context, later } = {}) {
  const session = Session.create(randomUUID());
  session.append('turn/start', { turn: 0 });
  session.append('step/start', { turn: 0, step: 0 });
  const event = session.append('user/message', message, { surfaceOp: 'append' });
  if (context) session.append('user/message', context, { surfaceOp: 'append' });
  const rootCallId = randomUUID();
  session.append('tool/call', { turn: 0, step: 0, callId: rootCallId, name: 'run_code', arguments: '{}' });
  if (later) session.append('user/message', later, { surfaceOp: 'append' });
  return { event, session, exec: { agent: { id: 'agent-alias', session }, callId: 'subcall', rootCallId,
    signal: new AbortController().signal } };
}

test('DSH SDK session and root call identify the exact consumed QQ utterance', () => {
  const message = qq('我住在上海。', { prefix: '群历史：我住在广州\n引用：我住在杭州\n' });
  const context = { ...qq('我住在苏州'), source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] } };
  const later = qq('我住在北京。', { speaker: '另一个人' });
  const { event, exec, session } = liveTurn(message, { context, later });
  assert.deepEqual(resolveHostContext({ ...exec, arguments: { speaker: '伪造', messageId: later.id } }), {
    sessionId: session.id, channel: 'group', speaker: '小舟', messageId: message.id,
    observedAt: new Date(event.time).toISOString(), rawSnippet: '我住在上海。', origin: 'user_request',
  });
  assert.equal(resolveHostContext({ ...exec, rootCallId: later.id }).rawSnippet, null);
  assert.equal(resolveHostContext({ ...exec, signal: AbortSignal.abort() }).messageId, null);
});

test('closed or seeded turns and non-user sources cannot borrow a previous statement', () => {
  const message = qq('我喜欢喝乌龙茶。');
  const events = [{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', time: 1, data: message }];
  const resolve = items => resolveHostContext({ agent: { id: 'session', session: { snapshotEvents: () => items } } });
  assert.equal(resolve([...events, { type: 'turn/end' }]).rawSnippet, null);
  assert.equal(resolve([...events, { type: 'session/end-seed' }]).rawSnippet, null);
  assert.equal(resolve([...events, { type: 'turn/end' }, { type: 'turn/start', data: { turn: 2 } }]).messageId, null);
  for (const [kind, origin] of [['schedule', 'autonomous'], ['external', 'external'], ['foreign', 'unknown']]) {
    const result = resolve([...events, { type: 'user/message', time: 2, data: { ...message, source: { kind } } }]);
    assert.equal(result.origin, origin);
    assert.equal(result.rawSnippet, null);
  }
});

test('malformed offsets and missing source fields stay unknown instead of using tool data', () => {
  const message = qq('我喜欢喝乌龙茶。', { channel: 'direct', prefix: '旧消息：我住在杭州\n' });
  message.source.qq.start = -4;
  const { exec } = liveTurn(message);
  const result = resolveHostContext({ ...exec, source: { channel: 'direct', speaker: '伪造' } });
  assert.equal(result.origin, 'user_request');
  assert.equal(result.rawSnippet, null);
  assert.equal(result.channel, null);
  assert.equal(result.speaker, null);
  const plain = { ...qq('我喜欢喝茶。'), source: { kind: 'user' } };
  const unlabelled = resolveHostContext(liveTurn(plain).exec);
  assert.equal(unlabelled.rawSnippet, '我喜欢喝茶。');
  assert.equal(unlabelled.channel, null);
  assert.equal(unlabelled.speaker, null);
});

test('tools confirm only grounded self-reports and keep inference outside recall', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-host-context-'));
  const tools = new Map();
  let memory;
  apply({
    tools: { register: tool => tools.set(tool.name, tool) },
    provide: (_name, service) => { memory = service; },
  }, { dataDir, scope: 'xiaoman_private' });
  t.after(() => { memory.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const entry = () => JSON.parse(fs.readFileSync(memory.store.journalPath, 'utf8').trim().split('\n').at(-1)).entry;
  const run = (name, args, exec) => tools.get(name).execute(args, exec);
  const userMessage = qq('其实我住在上海。', { prefix: '旧消息：我住在杭州\n' });
  const { exec, session } = liveTurn(userMessage);
  const args = { content: '小舟住在上海', kind: 'fact', origin: 'user_statement', evidence: '我住在上海' };
  assert.deepEqual(await run('memory_intake', { ...args, evidence: '我住在杭州' }, exec), { stored: false });
  assert.deepEqual(await run('memory_intake', args, exec), { stored: true });
  assert.deepEqual(entry().source, { sessionId: session.id, channel: 'group', speaker: '小舟', messageId: userMessage.id,
    observedAt: resolveHostContext(exec).observedAt, evidenceText: '我住在上海' });
  assert.deepEqual(entry().provenance, { origin: 'user_request', claimType: 'user_statement', evidenceStatus: 'resolved' });
  assert.equal(entry().confirmed, true);
  assert.equal(entry().status, 'active');
  const activeId = entry().id;
  assert.deepEqual(await run('memory_intake', { ...args, content: '小舟住在苏州' }, exec), { stored: true });
  assert.equal(entry().provenance.claimType, 'model_inference');
  assert.equal(entry().confirmed, false);
  assert.equal(entry().status, 'candidate');
  assert.equal(memory.inspect(activeId).status, 'active');
  assert.equal(memory.recall('苏州').count, 0);

  for (const [place, text] of [
    ['广州', '如果我住在广州就好了。'],
    ['合肥', '我住在合肥吗？'],
    ['泉州', '他说：“这是例句。我住在泉州。还有一句。”'],
  ]) {
    const context = liveTurn(qq(text)).exec;
    assert.deepEqual(await run('memory_intake', {
      ...args, content: `小舟住在${place}`, evidence: `我住在${place}`,
    }, context), { stored: true });
    assert.equal(entry().provenance.claimType, 'model_inference');
    assert.equal(entry().confirmed, false);
  }
  assert.match((await run('memory_remember', { content: '用户住在深圳' }, { source: userMessage.source })).message, /待确认/);
  assert.equal(entry().provenance.origin, 'unknown');
  assert.equal(entry().confirmed, false);
});
