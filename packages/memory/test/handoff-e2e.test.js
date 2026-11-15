import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { apply, loadLastHandoff } from '../lib/index.js';

test('端到端会话接力器 (Turn 1 Session Handoff E2E 验证)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-e2e-'));
  const listeners = new Map();
  const disposers = [];
  const tools = new Map();
  let memoryService;

  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: () => {} },
    on: (event, handler) => listeners.set(event, handler),
    effect: (fn) => disposers.push(fn()),
    provide: (_name, service) => { memoryService = service; },
  }, { dataDir, scope: 'xiaoman_private' });

  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const emit = (agent, event) => listeners.get('session/event')(agent.session, event);
  const claim = (agent, message) => listeners.get('agent/inbox/claimed')({ agent, message });

  // 1. Session 1 对话发生
  const session1 = { id: 'session-001', messages: [] };
  const agent1 = { id: 'agent-1', session: session1 };

  // 用户发送消息
  const msg1 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '小满，明天早上记得提醒我吃降压药' }],
    source: { kind: 'user', qq: { channel: 'direct', speaker: 'boss', start: 0, length: 19 } },
  };
  claim(agent1, msg1);
  emit(agent1, { type: 'turn/start' });
  emit(agent1, { type: 'user/message', data: msg1, time: Date.parse('2026-11-15T22:00:00+08:00') });

  // 助手回复
  const reply1 = {
    role: 'assistant',
    content: [{ type: 'text', text: '收到啦，明早小满一定准时提醒你吃药！' }],
  };
  emit(agent1, { type: 'assistant/message', data: reply1 });
  emit(agent1, { type: 'turn/end' });

  // 验证 last_handoff.json 已经原子写盘
  const handoff = loadLastHandoff(dataDir);
  assert.ok(handoff, 'last_handoff.json 必须落盘');
  assert.equal(handoff.sessionId, 'session-001');
  assert.match(handoff.lastExchange.user, /提醒我吃降压药/);
  assert.match(handoff.lastExchange.assistant, /准时提醒你吃药/);

  // 2. 隔天开始全新 Session 2
  const session2 = { id: 'session-002', messages: [] };
  const agent2 = { id: 'agent-2', session: session2 };

  const msg2 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '早安小满' }],
    source: { kind: 'user', qq: { channel: 'direct', speaker: 'boss', start: 0, length: 4 } },
  };

  // Session 2 第一轮消息被 Claim
  claim(agent2, msg2);

  // 验证前置线索已注入用户消息体中
  assert.match(msg2.content[0].text, /\[交接线索:/);
  assert.match(msg2.content[0].text, /提醒我吃降压药/);
  assert.match(msg2.content[0].text, /早安小满/);

  // 验证 QQ 真实发言取证偏移量已准确后移，不受线索污染
  assert.equal(
    msg2.content[0].text.slice(msg2.source.qq.start, msg2.source.qq.start + msg2.source.qq.length),
    '早安小满'
  );

  // 模拟消息进入历史
  session2.messages.push(msg2);
  emit(agent2, { type: 'turn/start' });
  emit(agent2, { type: 'user/message', data: msg2, time: Date.parse('2026-11-16T08:00:00+08:00') });
  emit(agent2, {
    type: 'assistant/message',
    data: { role: 'assistant', content: [{ type: 'text', text: '早上好！昨晚答应的降压药吃了吗？' }] },
  });
  emit(agent2, { type: 'turn/end' });

  // 3. Session 2 第二轮消息发送
  const msg3 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '刚刚吃了' }],
    source: { kind: 'user', qq: { channel: 'direct', speaker: 'boss', start: 0, length: 4 } },
  };
  session2.messages.push({ role: 'assistant', content: [{ type: 'text', text: '...' }] });
  claim(agent2, msg3);

  // 验证第二轮绝不再重复注入交接线索
  assert.equal(msg3.content[0].text, '刚刚吃了');
  assert.equal(msg3.source.qq.start, 0);
});

test('端到端私聊与群聊强隔离 (Private vs Group Channel Air-Gap E2E)', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-airgap-'));
  const listeners = new Map();
  const disposers = [];
  const tools = new Map();
  let memoryService;

  apply({
    tools: { register: (tool) => { tools.set(tool.name, tool); } },
    systemPrompt: { section: () => {} },
    on: (event, handler) => listeners.set(event, handler),
    effect: (fn) => disposers.push(fn()),
    provide: (_name, service) => { memoryService = service; },
  }, { dataDir, scope: 'xiaoman_private' });

  t.after(() => {
    for (const dispose of disposers.reverse()) dispose?.();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const emit = (agent, event) => listeners.get('session/event')(agent.session, event);
  const claim = (agent, message) => listeners.get('agent/inbox/claimed')({ agent, message });

  // 1. 私聊 Session: 用户在私聊中提及高度私密内容
  const directSession1 = { id: 'session-direct-secret', messages: [] };
  const directAgent1 = { id: 'agent-direct', session: directSession1 };

  const directMsg1 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '小满，我今天去看了心理医生，这件事别告诉别人' }],
    source: { kind: 'user', qq: { channel: 'direct', speaker: 'boss', start: 0, length: 26 } },
  };
  claim(directAgent1, directMsg1);
  emit(directAgent1, { type: 'turn/start' });
  emit(directAgent1, { type: 'user/message', data: directMsg1, time: Date.parse('2026-11-15T22:00:00+08:00') });
  emit(directAgent1, {
    type: 'assistant/message',
    data: { role: 'assistant', content: [{ type: 'text', text: '放心吧，这是我们之间的小秘密，抱抱你。' }] },
  });
  emit(directAgent1, { type: 'turn/end' });

  // 2. 群聊 Session: 随后在公共群聊中发起全新的群会话
  const groupSession1 = { id: 'session-group-public', messages: [] };
  const groupAgent1 = { id: 'agent-group', session: groupSession1 };

  const groupMsg1 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '小满在吗' }],
    source: {
      kind: 'user',
      qq: {
        channel: 'group',
        groupId: 'public-group-100',
        speaker: 'other_member',
        start: 0,
        length: 4,
      },
    },
  };

  // 群聊第一轮消息 claim
  claim(groupAgent1, groupMsg1);

  // 核心安全红线断言：群聊消息体中绝不可出现任何私聊交接线索或心理医生字样！
  assert.doesNotMatch(groupMsg1.content[0].text, /心理医生/, '安全红线：群聊绝对严禁泄露私聊交接内容');
  assert.doesNotMatch(groupMsg1.content[0].text, /小秘密/, '安全红线：群聊绝对严禁泄露私聊助手回复');
  assert.doesNotMatch(groupMsg1.content[0].text, /\[交接线索:/, '群聊未产生本群记录前绝不注入线索');
  assert.equal(groupMsg1.content[0].text, '小满在吗');
  assert.equal(groupMsg1.source.qq.start, 0);

  // 群聊进行一轮正常交流并结束
  emit(groupAgent1, { type: 'turn/start' });
  emit(groupAgent1, { type: 'user/message', data: groupMsg1, time: Date.parse('2026-11-15T22:30:00+08:00') });
  emit(groupAgent1, {
    type: 'assistant/message',
    data: { role: 'assistant', content: [{ type: 'text', text: '在的在的！大家晚上好呀！' }] },
  });
  emit(groupAgent1, { type: 'turn/end' });

  // 3. 次日私聊开启新会话 Session 2
  const directSession2 = { id: 'session-direct-nextday', messages: [] };
  const directAgent2 = { id: 'agent-direct-2', session: directSession2 };

  const directMsg2 = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: '早安' }],
    source: { kind: 'user', qq: { channel: 'direct', speaker: 'boss', start: 0, length: 2 } },
  };

  claim(directAgent2, directMsg2);

  // 验证私聊精准承接前一天私聊内容，而绝不会串入群聊的“大家晚上好”
  assert.match(directMsg2.content[0].text, /\[交接线索:/);
  assert.match(directMsg2.content[0].text, /心理医生/);
  assert.doesNotMatch(directMsg2.content[0].text, /大家晚上好/, '私聊绝不串入群聊交接');
  assert.equal(
    directMsg2.content[0].text.slice(directMsg2.source.qq.start, directMsg2.source.qq.start + directMsg2.source.qq.length),
    '早安'
  );
});
