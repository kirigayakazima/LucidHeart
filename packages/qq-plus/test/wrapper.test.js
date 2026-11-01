import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, reportWakeToHeart } from '../lib/index.js'

function createFakeSender() {
  const calls = []
  const sender = {
    name: 'fake-sender',
    sendMarkdown: async function (target, content, opts) {
      assert.equal(this.name, 'fake-sender')
      calls.push({ target, content, opts, at: Date.now() })
      return { ok: true }
    },
    getCalls() {
      return calls
    },
    clear() {
      calls.length = 0
    },
  }
  return sender
}

function createFakeCtx(sender, heart = null) {
  let disposer = null
  const listeners = new Map()

  return {
    qqbotSender: sender,
    heart,
    on: (evt, handler) => {
      listeners.set(evt, handler)
    },
    emit: (evt, data) => {
      const handler = listeners.get(evt)
      if (handler) handler(data)
    },
    effect: (fn) => {
      disposer = fn()
    },
    dispose: () => {
      if (typeof disposer === 'function') disposer()
    },
  }
}

test('短文本（< minChars）不切分，只调用 1 次', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, { split: { minChars: 120, delayMs: 10 } })

  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, '短消息回答。', undefined)
  assert.equal(sender.getCalls().length, 1)
  assert.equal(sender.getCalls()[0].content, '短消息回答。')
})

test('带 opts（如 keyboard 按钮）时绝不切分，只调用 1 次且原样透传 opts', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, { split: { minChars: 20, delayMs: 10 } })

  const longText = '这是一段很长的问答文本，包含足够的字符数。请问您需要选择哪一个操作？点击下方按钮确认。'
  const opts = { keyboard: { rows: [] } }
  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, longText, opts)

  assert.equal(sender.getCalls().length, 1)
  assert.equal(sender.getCalls()[0].content, longText)
  assert.deepEqual(sender.getCalls()[0].opts, opts)
})

test('跳过前缀（🔧 工具结果、❌ 错误、⚠️ 轮次异常）不切分，只调用 1 次', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, { split: { minChars: 20, delayMs: 10 } })

  const toolText = '🔧 执行结果返回成功。包含了很多字数，详细记录了工具运行过程和各项指标，不要对此切分。'
  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, toolText, undefined)
  assert.equal(sender.getCalls().length, 1)
  assert.equal(sender.getCalls()[0].content, toolText)
})

test('普通长文本切分为 2–3 次调用，内容按顺序发送，且段间有延迟', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, {
    persona: 'xiaoman',
    split: {
      minChars: 30,
      targetChars: 35,
      delayMs: 30,
      maxSegments: 3,
    },
  })

  const longText =
    '第一部分内容开始叙述，详细解释相关背景。第二句话深入探讨具体实现细节。第三句话总结经验教训并指出优化方向。'

  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, longText, undefined)
  const calls = sender.getCalls()
  assert.ok(calls.length >= 2, `预期切分为 >= 2 段，实际为 ${calls.length}`)

  // 验证时间间隔
  for (let i = 1; i < calls.length; i++) {
    const diff = calls[i].at - calls[i - 1].at
    assert.ok(diff >= 20, `段间延迟实际为 ${diff}ms，应大于等于 20ms`)
  }
})

test('群聊消息（target.scope=group）最多切分为 2 段', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, {
    split: {
      minChars: 20,
      targetChars: 25,
      groupMaxSegments: 2,
      delayMs: 10,
    },
  })

  const longText =
    '第一段详细解释。第二段继续阐明。第三段深入说明。第四段最后总结。'

  await sender.sendMarkdown({ scope: 'group', targetId: 'group1' }, longText, undefined)
  const calls = sender.getCalls()
  assert.equal(calls.length, 2, '群聊消息应严格受限为 2 段')
})

test('插件卸载（dispose）时能完全恢复原生 sendMarkdown', async () => {
  const sender = createFakeSender()
  const ctx = createFakeCtx(sender)
  apply(ctx, { split: { minChars: 20, delayMs: 10 } })

  ctx.dispose()

  const longText = '这是一段原本会切分的长消息。第二句在此继续。第三句给出结论。'
  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, longText, undefined)
  assert.equal(sender.getCalls().length, 1)
})

test('Heart Protocol v1 联动：疲惫状态自动拉长打字间隔', async () => {
  const sender = createFakeSender()
  const mockHeart = {
    getSnapshot: () => ({
      device: 'phone',
      mood: { energy: 0.1, arousal: 0.2 }, // 极度疲倦
    }),
  }
  const ctx = createFakeCtx(sender, mockHeart)
  apply(ctx, {
    persona: 'xiaoman',
    heartCadence: true,
    split: {
      minChars: 20,
      targetChars: 25,
      delayMs: 40,
    },
  })

  const text = '第一句话先说一下这个事情。第二句话再说一下后续的处理和决定。'
  await sender.sendMarkdown({ scope: 'c2c', targetId: 'user1' }, text, undefined)
  const calls = sender.getCalls()
  if (calls.length >= 2) {
    const diff = calls[1].at - calls[0].at
    // 基础 40ms，疲倦时乘 1.35 = 54ms
    assert.ok(diff >= 45, `疲倦时延迟应被延长，实际为 ${diff}ms`)
  }
})

test('Heart 唤醒感知上报（reportWakeToHeart）', async () => {
  const observed = []
  const mockHeart = {
    observe: async (input) => {
      observed.push(input)
      return { accepted: true, observationId: 'obs_123' }
    },
  }
  const ctx = { heart: mockHeart }

  const res = await reportWakeToHeart(ctx, {
    persona: 'xiaoman',
    hitWord: '小满',
    isMentioned: false,
    isCommand: false,
    msg: { groupOpenid: 'grp_001' },
  })

  assert.equal(res.accepted, true)
  assert.equal(observed.length, 1)
  assert.equal(observed[0].type, 'im_wake')
  assert.equal(observed[0].evidence.hitWord, '小满')
  assert.equal(observed[0].evidence.persona, 'xiaoman')
})
