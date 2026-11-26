import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { apply } from '../lib/index.js';
import { buildIntakeMetadata } from '../lib/intake.js';
import { WorkingMemory, renderWorkingMemory, saveDailyEpisode, renderRecentEpisodes } from '../lib/working_memory.js';

function createHostFixture(t, { coreProfile = '' } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-v020-'));
  if (coreProfile) {
    fs.writeFileSync(path.join(dataDir, 'core_profile.md'), coreProfile, 'utf8');
  }
  const cleanups = [];
  const listeners = new Map();
  const tools = new Map();
  const sections = [];
  let memoryService;
  const ctx = {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
    },
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    tools: {
      register(tool) { tools.set(tool.name, tool); },
    },
    systemPrompt: {
      section(sec) { sections.push(sec); },
    },
    provide(name, val) {
      if (name === 'memory') memoryService = val;
    },
  };
  apply(ctx, { dataDir, scope: 'xiaoman_private' });
  t.after(() => {
    for (const fn of cleanups.reverse()) fn();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function emit(name, ...args) {
    for (const fn of listeners.get(name) ?? []) await fn(...args);
  }

  function makeSession(id) {
    const messages = [];
    return {
      id,
      messages,
      deriveMessages: () => messages,
    };
  }

  function makeNativeDirectMessage(id, text, { time = Date.now(), blocks = [], extraSource = {} } = {}) {
    return {
      id,
      role: 'user',
      time,
      source: { kind: 'user', ...extraSource },
      content: [
        ...(text ? [{ type: 'text', text }] : []),
        ...blocks,
      ],
    };
  }

  function makeQqMessage(id, text, { channel = 'direct', speaker = '清羽', speakerId = '10001', targetId = '10001', groupId, time = Date.now() } = {}) {
    return {
      id,
      role: 'user',
      time,
      source: {
        kind: 'user',
        qq: {
          channel,
          speaker,
          speakerId,
          targetId,
          ...(groupId && { groupId }),
          start: 0,
          length: text.length,
        },
      },
      content: [{ type: 'text', text }],
    };
  }

  return { dataDir, tools, sections, getMemory: () => memoryService, emit, makeSession, makeNativeDirectMessage, makeQqMessage };
}

test('groundedEvidenceClause rescues third-person/paraphrased direct & native turns while blocking hallucinations/quotes/uncertainty', () => {
  const groundedDirect = buildIntakeMetadata({
    origin: 'user_request',
    sessionId: 'sess-1',
    channel: 'direct',
    speaker: '清羽',
    messageId: 'm1',
    observedAt: '2026-11-26T08:00:00.000Z',
    rawSnippet: '对了我养了一只猫',
  }, {
    content: '用户养了一只金渐层猫咪',
    kind: 'fact',
    origin: 'shared_experience',
  });
  assert.equal(groundedDirect.provenance.claimType, 'observation');
  assert.equal(groundedDirect.provenance.evidenceStatus, 'resolved');
  assert.equal(groundedDirect.confidence, 0.85);
  assert.equal(groundedDirect.retentionClass, 'stable');

  const groundedNativeVoice = buildIntakeMetadata({
    origin: 'user_request',
    sessionId: 'sess-native-voice',
    channel: null,
    speaker: null,
    messageId: 'm-voice-1',
    observedAt: '2026-11-26T08:01:00.000Z',
    rawSnippet: '我这边能听到你说话，不用后面带一个这个',
  }, {
    content: '连电脑时让小满直接开口说话，别在回复后面加"桌宠那边我说了"这类说明',
    kind: 'preference',
    origin: 'user_statement',
    evidence: '我这边能听到你说话，不用后面带一个这个',
  });
  assert.equal(groundedNativeVoice.source.channel, 'direct');
  assert.equal(groundedNativeVoice.source.speaker, 'user');
  assert.equal(groundedNativeVoice.provenance.evidenceStatus, 'resolved');
  assert.equal(groundedNativeVoice.provenance.claimType, 'observation');
  assert.equal(groundedNativeVoice.retentionClass, 'stable');

  const hallucination = buildIntakeMetadata({
    origin: 'user_request',
    sessionId: 'sess-2',
    channel: 'direct',
    speaker: '清羽',
    messageId: 'm2',
    observedAt: '2026-11-26T08:02:00.000Z',
    rawSnippet: '我住在上海',
  }, {
    content: '小舟住在苏州',
    kind: 'fact',
    origin: 'user_statement',
  });
  assert.equal(hallucination.provenance.claimType, 'model_inference');
  assert.equal(hallucination.provenance.evidenceStatus, 'unavailable');

  const uncertain = buildIntakeMetadata({
    origin: 'user_request',
    sessionId: 'sess-3',
    channel: 'direct',
    speaker: '清羽',
    messageId: 'm3',
    observedAt: '2026-11-26T08:03:00.000Z',
    rawSnippet: '如果我有空就去公园。',
  }, {
    content: '用户会去公园散步',
    kind: 'fact',
    origin: 'user_statement',
  });
  assert.equal(uncertain.provenance.claimType, 'model_inference');

  const quotedUserMsg = buildIntakeMetadata({
    origin: 'user_request',
    sessionId: 'sess-4',
    channel: 'direct',
    speaker: '清羽',
    messageId: 'm4',
    observedAt: '2026-11-26T08:04:00.000Z',
    rawSnippet: '别人跟我说「我最喜欢榴莲」',
  }, {
    content: '用户最喜欢榴莲',
    kind: 'preference',
    origin: 'user_statement',
  });
  assert.equal(quotedUserMsg.provenance.claimType, 'model_inference');
});

test('core_profile.md injects in direct turns only and invalidates cache on modification', async t => {
  const { dataDir, sections, emit, makeSession, makeNativeDirectMessage, makeQqMessage } = createHostFixture(t, {
    coreProfile: '- 你是小满，一直记得清羽。\n- 清羽有金渐层猫咪。',
  });
  assert.equal(sections.length, 1);
  const directSess = makeSession('s-direct');
  const directMsg = makeNativeDirectMessage('m1', '今天心情怎么样');
  await emit('agent/inbox/claimed', { agent: { id: 'a1', session: directSess }, message: directMsg });
  const directPrompt = sections[0].text({ agent: { session: directSess } });
  assert.match(directPrompt, /【核心长期记忆锚点】/);
  assert.match(directPrompt, /金渐层猫咪/);

  const groupSess = makeSession('s-group');
  const groupMsg = makeQqMessage('m2', '群里聊聊猫', { channel: 'group', groupId: 'g-1', targetId: 'g-1' });
  await emit('agent/inbox/claimed', { agent: { id: 'a1', session: groupSess }, message: groupMsg });
  const groupPrompt = sections[0].text({ agent: { session: groupSess } });
  assert.doesNotMatch(groupPrompt, /【核心长期记忆锚点】/);

  const profilePath = path.join(dataDir, 'core_profile.md');
  fs.writeFileSync(profilePath, '- 更新后的核心锚点：喜欢冰美式。', 'utf8');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(profilePath, future, future);
  const refreshedPrompt = sections[0].text({ agent: { session: directSess } });
  assert.match(refreshedPrompt, /更新后的核心锚点：喜欢冰美式/);
});

test('WorkingMemory uses 7-day TTL and daily episodes cross sessions in direct chats without leaking to group', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ep-v020-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.parse('2026-11-20T10:00:00.000+08:00');
  const wm = new WorkingMemory(dataDir, () => now);
  const s1Identity = { channel: 'direct', scope: 'xiaoman_private', targetId: 'host:sess-1' };
  wm.save(s1Identity, {
    current_focus: ['找以前的自拍照片'],
    recent_exchanges: ['你以前发过写真吗 / 发过好多张呢'],
  });
  saveDailyEpisode(dataDir, s1Identity, {
    exchanges: ['你以前发过写真吗 / 发过好多张呢'],
    focus: ['照片回看'],
  }, now);
  // Idempotent duplicate write on same day/content returns null
  assert.equal(saveDailyEpisode(dataDir, s1Identity, {
    exchanges: ['你以前发过写真吗 / 发过好多张呢'],
    focus: ['照片回看'],
  }, now), null);

  now += 6 * 24 * 60 * 60 * 1000;
  assert.ok(renderWorkingMemory(wm.load(s1Identity)).includes('找以前的自拍照片'));
  // Brand new native session shares 5-day direct episodes
  const s2Identity = { channel: 'direct', scope: 'xiaoman_private', targetId: 'host:sess-2' };
  const s2Episode = renderRecentEpisodes(dataDir, s2Identity, { days: 7, now });
  assert.match(s2Episode, /近几日直聊片段/);
  assert.match(s2Episode, /你以前发过写真吗/);

  // Group chat never gets or writes episodes
  const groupIdentity = { channel: 'group', scope: 'xiaoman_private', targetId: 'group:123', speaker: '清羽' };
  assert.equal(saveDailyEpisode(dataDir, groupIdentity, { exchanges: ['群消息'] }, now), null);
  assert.equal(renderRecentEpisodes(dataDir, groupIdentity, { days: 7, now }), '');

  now += 2 * 24 * 60 * 60 * 1000;
  assert.equal(wm.load(s1Identity), null);
});

test('native direct recall supports multi-turn referential augmentation and clears on routine greetings', async t => {
  const { tools, sections, getMemory, emit, makeSession, makeNativeDirectMessage } = createHostFixture(t);
  const mem = getMemory();
  mem.remember({
    content: '用户以前给小满发过自拍和写真照片',
    kind: 'episodic',
    scope: 'xiaoman_private',
    source: { sessionId: 'seed', channel: 'direct', speaker: 'user', messageId: 'seed-1', observedAt: new Date().toISOString(), evidenceText: '发过写真照片' },
    provenance: { origin: 'user_request', claimType: 'user_statement', evidenceStatus: 'resolved' },
    confidence: 0.95,
    confirmed: true,
    audience: [{ channel: 'direct', speaker: 'user' }],
    retentionClass: 'stable',
  });

  const session = makeSession('native-1');
  const agent = { id: 'a1', session };

  const m1 = makeNativeDirectMessage('nm-1', '你以前不是一直有自己的照片吗？');
  await emit('session/event', session, { type: 'turn/start', time: Date.now(), data: {} });
  await emit('agent/inbox/claimed', { agent, message: m1 });
  session.messages.push(m1);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: m1 });
  const p1 = sections[0].text({ agent });
  assert.match(p1, /自拍和写真照片/);

  const m2 = makeNativeDirectMessage('nm-2', '一点都没记住吗');
  await emit('agent/inbox/claimed', { agent, message: m2 });
  session.messages.push(m2);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: m2 });
  const p2 = sections[0].text({ agent });
  assert.match(p2, /自拍和写真照片/);

  const m3 = makeNativeDirectMessage('nm-3', '早安');
  await emit('agent/inbox/claimed', { agent, message: m3 });
  session.messages.push(m3);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: m3 });

  const m4 = makeNativeDirectMessage('nm-4', '晚点吃点啥');
  await emit('agent/inbox/claimed', { agent, message: m4 });
  session.messages.push(m4);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: m4 });
  const p4 = sections[0].text({ agent });
  assert.doesNotMatch(p4, /自拍和写真照片/);

  // Native direct memory_intake works cleanly too
  const intakeTool = tools.get('memory_intake');
  const m5 = makeNativeDirectMessage('nm-5', '我超爱吃抹茶冰淇淋');
  await emit('agent/inbox/claimed', { agent, message: m5 });
  session.messages.push(m5);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: m5 });
  const intakeRes = await intakeTool.execute({
    content: '用户喜欢吃抹茶冰淇淋',
    kind: 'preference',
    origin: 'user_statement',
    evidence: '我超爱吃抹茶冰淇淋',
  }, { agent });
  assert.equal(intakeRes.stored, true);
  assert.match(mem.recall('抹茶冰淇淋', { scope: 'xiaoman_private' }).text, /抹茶冰淇淋/);
});

test('memory_album_save supports optional source_hash auto-computation on native image turns', async t => {
  const { tools, getMemory, emit, makeSession, makeNativeDirectMessage } = createHostFixture(t);
  const albumSave = tools.get('memory_album_save');
  const session = makeSession('album-native');
  const agent = { id: 'a1', session };
  const payload = Buffer.from('cat-photo-binary');
  const expectedHash = createHash('sha256').update(payload).digest('hex');

  const msg = makeNativeDirectMessage('img-1', '看我新拍的照片', {
    blocks: [{ type: 'image', data: payload.toString('base64') }],
  });
  await emit('session/event', session, { type: 'turn/start', time: Date.now(), data: {} });
  await emit('agent/inbox/claimed', { agent, message: msg });
  session.messages.push(msg);
  await emit('session/event', session, { type: 'user/message', time: Date.now(), data: msg });

  const saved = await albumSave.execute({
    kind: 'user_photo',
    title: '金渐层近照',
    summary: '清羽发来的猫咪照片',
  }, { agent });
  assert.equal(saved.created, true);
  const found = getMemory().album.search('金渐层', { scope: 'xiaoman_private' });
  assert.equal(found.length, 1);
  assert.equal(found[0].source_hash, expectedHash);
  assert.equal(found[0].source.channel, 'direct');

  // Explicit invalid hash still fails validation
  await assert.rejects(() => albumSave.execute({
    kind: 'user_photo',
    title: '坏哈希',
    summary: '不应绕过校验',
    source_hash: 'bad_hash',
  }, { agent }));
});
