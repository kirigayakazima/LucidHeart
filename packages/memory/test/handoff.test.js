import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatRelativeTime,
  resolveHandoffKey,
  loadLastHandoff,
  saveLastHandoff,
  buildHandoffClue,
  extractTextFromMessage,
  shouldInjectHandoff,
  injectHandoffToMessage,
} from '../lib/handoff.js';

test('resolveHandoffKey: 正确区分私聊与群聊分区 Key', () => {
  assert.equal(resolveHandoffKey({ channel: 'direct' }), 'direct:default');
  assert.equal(resolveHandoffKey({ channel: 'direct', speaker: 'boss' }), 'direct:boss');
  assert.equal(resolveHandoffKey({ channel: 'group' }), 'group:default');
  assert.equal(resolveHandoffKey({ channel: 'group', targetId: 'grp_123' }), 'group:grp_123');
});

test('formatRelativeTime: 准确格式化跨度时间', () => {
  const base = new Date('2026-11-15T12:00:00+08:00');

  // 今天早上
  const todayMorning = new Date('2026-11-15T08:30:00+08:00');
  assert.match(formatRelativeTime(todayMorning, base), /今天/);

  // 昨天晚上
  const yesterdayEvening = new Date('2026-11-14T22:30:00+08:00');
  assert.match(formatRelativeTime(yesterdayEvening, base), /昨/);

  // 前天
  const beforeYesterday = new Date('2026-11-13T15:00:00+08:00');
  assert.match(formatRelativeTime(beforeYesterday, base), /前天/);

  // 更早日期
  const longAgo = new Date('2026-10-01T10:00:00+08:00');
  assert.match(formatRelativeTime(longAgo, base), /10月/);
});

test('saveLastHandoff & loadLastHandoff: 分通道原子读写与严格隐私隔离', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  try {
    // 初始读取为空
    assert.equal(loadLastHandoff(tmpDir), null);

    // 1. 写入私聊交接
    const directHandoff = {
      sessionId: 'session-direct-001',
      channel: 'direct',
      speaker: 'boss',
      updatedAt: '2026-11-15T12:00:00.000Z',
      lastExchange: {
        user: '私密：我今天去看了心理医生',
        assistant: '抱抱你，小满一直都在',
      },
    };
    saveLastHandoff(tmpDir, directHandoff);

    // 验证私聊能读取
    const loadedDirect = loadLastHandoff(tmpDir, { channel: 'direct', speaker: 'boss' });
    assert.ok(loadedDirect);
    assert.equal(loadedDirect.sessionId, 'session-direct-001');
    assert.equal(loadedDirect.channel, 'direct');
    assert.match(loadedDirect.lastExchange.user, /心理医生/);

    // 验证群聊绝对读不到私聊交接（安全隔离核心！）
    const leakedToGroup = loadLastHandoff(tmpDir, { channel: 'group', targetId: 'group-100' });
    assert.equal(leakedToGroup, null, '群聊绝对不能读取私聊交接记录');

    // 2. 写入群聊交接
    const groupHandoff = {
      sessionId: 'session-group-002',
      channel: 'group',
      targetId: 'group-100',
      speaker: 'member_a',
      updatedAt: '2026-11-15T13:00:00.000Z',
      lastExchange: {
        user: '群公开：大家周末一起打球吗',
        assistant: '周末天气好，可以去呀',
      },
    };
    saveLastHandoff(tmpDir, groupHandoff);

    // 验证群聊能读取对应群组记录
    const loadedGroup = loadLastHandoff(tmpDir, { channel: 'group', targetId: 'group-100' });
    assert.ok(loadedGroup);
    assert.equal(loadedGroup.channel, 'group');
    assert.match(loadedGroup.lastExchange.user, /打球/);

    // 验证私聊绝对不读取群聊交接
    const directAgain = loadLastHandoff(tmpDir, { channel: 'direct', speaker: 'boss' });
    assert.match(directAgain.lastExchange.user, /心理医生/);
    assert.doesNotMatch(directAgain.lastExchange.user, /打球/);

    // 验证不同群号之间互不串流
    const differentGroup = loadLastHandoff(tmpDir, { channel: 'group', targetId: 'group-999' });
    assert.equal(differentGroup, null, '不同群号之间不能串流');

    // 损坏文件容错
    fs.writeFileSync(path.join(tmpDir, 'last_handoff.json'), '{ invalid json ...', 'utf8');
    assert.equal(loadLastHandoff(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildHandoffClue: 组装紧凑线索并严格执行通道与承诺隔离', () => {
  const now = new Date('2026-11-15T09:00:00.000Z');
  const directHandoff = {
    channel: 'direct',
    updatedAt: '2026-11-14T23:30:00.000Z',
    lastExchange: {
      user: '明天早上记得问我游戏通关没',
      assistant: '好呀满宝，明早一定第一时间问你！',
    },
  };
  const directCommitment = {
    title: '一起去吃火锅',
    targetTime: '2026-11-16',
    channel: 'direct',
  };

  // 私聊场景下正常组装
  const directClue = buildHandoffClue({ lastHandoff: directHandoff, commitment: directCommitment, channel: 'direct', now });
  assert.match(directClue, /\[交接线索:/);
  assert.match(directClue, /明天早上记得问我游戏通关没/);
  assert.match(directClue, /好呀满宝，明早一定第一时间问你！/);
  assert.match(directClue, /一起去吃火锅/);
  assert.ok(directClue.length < 200, '交接线索必须极简紧凑 (< 200 字符)');

  // 群聊场景下：若误传入私聊 handoff 或私聊承诺，必须被完全阻断与过滤
  const groupClue = buildHandoffClue({ lastHandoff: directHandoff, commitment: directCommitment, channel: 'group', now });
  assert.equal(groupClue, '', '群聊场景下必须严格阻断私聊交接与私聊承诺');
});

test('shouldInjectHandoff: 准确识别通道隔离、会话切换与时间跨度', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');
  const injected = new Set(['session-already-done']);

  // 通道不匹配：私聊记录绝不注入群聊，反之亦然
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'direct' },
    currentSessionId: 'session-group-new',
    channel: 'group',
    messages: [],
    injectedSessions: injected,
    now,
  }), false, '私聊 handoff 绝不注入群聊');

  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'group', targetId: 'grp-1' },
    currentSessionId: 'session-direct-new',
    channel: 'direct',
    messages: [],
    injectedSessions: injected,
    now,
  }), false, '群聊 handoff 绝不注入私聊');

  // 群号不匹配：群 1 记录绝不注入群 2
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'group', targetId: 'grp-1' },
    currentSessionId: 'session-grp2-new',
    channel: 'group',
    targetId: 'grp-2',
    messages: [],
    injectedSessions: injected,
    now,
  }), false, '群 1 记录绝不注入群 2');

  // 已注入过的会话：绝不重复注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'direct' },
    currentSessionId: 'session-already-done',
    channel: 'direct',
    injectedSessions: injected,
  }), false);

  // 会话 ID 切换（同通道跨 Session）：应当注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'direct', updatedAt: '2026-11-15T09:30:00.000Z' },
    currentSessionId: 'session-new-123',
    channel: 'direct',
    messages: [],
    injectedSessions: injected,
    now,
  }), true);

  // 相同会话，但时间超过 1 小时：应当注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-same', channel: 'direct', updatedAt: '2026-11-15T08:00:00.000Z' },
    currentSessionId: 'session-same',
    channel: 'direct',
    messages: [],
    injectedSessions: injected,
    now,
  }), true);

  // 相同会话，距离上次仅 5 分钟：不注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-same', channel: 'direct', updatedAt: '2026-11-15T09:55:00.000Z' },
    currentSessionId: 'session-same',
    channel: 'direct',
    messages: [],
    injectedSessions: injected,
    now,
  }), false);

  // 非第一轮消息 (已有 2 条以上用户消息)：不注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', channel: 'direct' },
    currentSessionId: 'session-new-123',
    channel: 'direct',
    messages: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }],
    injectedSessions: injected,
    now,
  }), false);
});

test('injectHandoffToMessage: 前置注入并修正 QQ 偏移量', () => {
  const clue = '[交接线索: 上次聊到明天早起。]\n\n';
  const originalUserText = '早上好小满！';

  // 模拟带 QQ 元数据的消息
  const msg = {
    role: 'user',
    content: [{ type: 'text', text: originalUserText }],
    source: {
      kind: 'user',
      qq: {
        channel: 'direct',
        speaker: 'user_boss',
        start: 0,
        length: originalUserText.length,
      },
    },
  };

  injectHandoffToMessage(msg, clue);

  // 1. 模型可见文本包含了前置线索
  assert.equal(msg.content[0].text, clue + originalUserText);

  // 2. QQ 取证偏移量向后平移，依然精确框定真实用户原话
  assert.equal(msg.source.qq.start, clue.length);
  assert.equal(msg.source.qq.length, originalUserText.length);
  assert.equal(
    msg.content[0].text.slice(msg.source.qq.start, msg.source.qq.start + msg.source.qq.length),
    originalUserText
  );
});
