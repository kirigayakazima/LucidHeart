import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatRelativeTime,
  loadLastHandoff,
  saveLastHandoff,
  buildHandoffClue,
  extractTextFromMessage,
  shouldInjectHandoff,
  injectHandoffToMessage,
} from '../lib/handoff.js';

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

test('saveLastHandoff & loadLastHandoff: 原子读写与边界容错', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-test-'));
  try {
    // 初始读取为空
    assert.equal(loadLastHandoff(tmpDir), null);

    // 正常写入与读取
    const handoff = {
      sessionId: 'session-alpha-123',
      updatedAt: '2026-11-15T12:00:00.000Z',
      lastExchange: {
        user: '明早记得叫我起床哦',
        assistant: '好呀满宝，明早一定准时叫你！',
      },
    };
    saveLastHandoff(tmpDir, handoff);

    const loaded = loadLastHandoff(tmpDir);
    assert.deepEqual(loaded.sessionId, 'session-alpha-123');
    assert.deepEqual(loaded.lastExchange.user, '明早记得叫我起床哦');
    assert.deepEqual(loaded.lastExchange.assistant, '好呀满宝，明早一定准时叫你！');

    // 损坏文件容错
    fs.writeFileSync(path.join(tmpDir, 'last_handoff.json'), '{ invalid json ...', 'utf8');
    assert.equal(loadLastHandoff(tmpDir), null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildHandoffClue: 组装紧凑线索并严格受控在预算内', () => {
  const now = new Date('2026-11-15T09:00:00.000Z');
  const lastHandoff = {
    updatedAt: '2026-11-14T23:30:00.000Z',
    lastExchange: {
      user: '明天早上记得问我游戏通关没',
      assistant: '好呀满宝，明早一定第一时间问你！',
    },
  };
  const commitment = {
    title: '一起去吃火锅',
    targetTime: '2026-11-16',
  };

  const clue = buildHandoffClue({ lastHandoff, commitment, now });
  assert.match(clue, /\[交接线索:/);
  assert.match(clue, /明天早上记得问我游戏通关没/);
  assert.match(clue, /好呀满宝，明早一定第一时间问你！/);
  assert.match(clue, /一起去吃火锅/);
  assert.ok(clue.length < 200, '交接线索必须极简紧凑 (< 200 字符)');
});

test('shouldInjectHandoff: 准确识别会话切换与时间跨度', () => {
  const now = new Date('2026-11-15T10:00:00.000Z');
  const injected = new Set(['session-already-done']);

  // 已注入过的会话：绝不重复注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old' },
    currentSessionId: 'session-already-done',
    injectedSessions: injected,
  }), false);

  // 会话 ID 切换（跨 Session）：应当注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old', updatedAt: '2026-11-15T09:30:00.000Z' },
    currentSessionId: 'session-new-123',
    messages: [],
    injectedSessions: injected,
    now,
  }), true);

  // 相同会话，但时间超过 1 小时：应当注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-same', updatedAt: '2026-11-15T08:00:00.000Z' },
    currentSessionId: 'session-same',
    messages: [],
    injectedSessions: injected,
    now,
  }), true);

  // 相同会话，距离上次仅 5 分钟：不注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-same', updatedAt: '2026-11-15T09:55:00.000Z' },
    currentSessionId: 'session-same',
    messages: [],
    injectedSessions: injected,
    now,
  }), false);

  // 非第一轮消息 (已有 2 条以上用户消息)：不注入
  assert.equal(shouldInjectHandoff({
    lastHandoff: { sessionId: 'session-old' },
    currentSessionId: 'session-new-123',
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
