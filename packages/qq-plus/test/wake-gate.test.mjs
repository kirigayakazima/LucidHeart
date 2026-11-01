import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWakeGate } from '../lib/wake-gate.js'
import { XIAOMAN_PROFILE, AXING_PROFILE } from '../lib/personas.js'

function makeMockCtx({ kind = 'group', content = '', atEvent = false, mentions = [], appId = 'bot123' }) {
  let stopped = false
  let stopReason = ''
  let nextCalled = false

  const mCtx = {
    message: {
      kind,
      content,
      rawEventType: atEvent ? 'GROUP_AT_MESSAGE_CREATE' : 'GROUP_MESSAGE_CREATE',
      mentions,
      groupOpenid: kind === 'group' ? 'group_abc' : undefined,
    },
    bot: { appId },
    state: {},
    stop(reason) {
      stopped = true
      stopReason = reason
    },
  }

  const next = async () => {
    nextCalled = true
  }

  return { mCtx, next, getResult: () => ({ stopped, stopReason, nextCalled, state: mCtx.state }) }
}

test('小满（妹妹）画像入站唤醒门控', async () => {
  const wakeEvents = []
  const gate = createWakeGate({
    getConfig: () => ({ persona: 'xiaoman', wakeWords: XIAOMAN_PROFILE.wakeWords }),
    onWake: (ev) => wakeEvents.push(ev),
    appId: 'bot123',
  })

  // 1. 无 @，无唤醒词 → 阻断
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '今天天气真不错啊大家' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.stopped, true)
    assert.equal(res.nextCalled, false)
  }

  // 2. 带唤醒词「小满」 → 唤醒放行，且触发 onWake
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '小满，帮我看下日历' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.stopped, false)
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.shouldAnswer, true)
    assert.equal(res.state.mention.hitWord, '小满')
    assert.equal(res.state.mention.persona, 'xiaoman')
  }

  // 3. 带昵称「满宝」 → 同样唤醒
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '满宝今天辛苦啦' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.hitWord, '满宝')
  }

  // 4. 斜杠命令「/status」 → 唤醒放行
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '/status' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.implicit, true)
  }

  // 5. 事件带 @ → 唤醒放行
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '你好呀', atEvent: true })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.wasMentioned, true)
  }

  // 6. 私聊 (c2c) → 无条件放行
  {
    const { mCtx, next, getResult } = makeMockCtx({ kind: 'c2c', content: '私聊测试' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.reason, 'c2c')
  }
})

test('阿醒（姐姐）画像入站唤醒门控', async () => {
  const wakeEvents = []
  const gate = createWakeGate({
    getConfig: () => ({ persona: 'axing', wakeWords: AXING_PROFILE.wakeWords }),
    onWake: (ev) => wakeEvents.push(ev),
    appId: 'bot123',
  })

  // 1. 小满的唤醒词在阿醒处不生效（除非自定义配置了）
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '小满在吗' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.stopped, true)
  }

  // 2. 带「阿醒」或「姐姐」 → 唤醒阿醒
  {
    const { mCtx, next, getResult } = makeMockCtx({ content: '阿醒在不在' })
    await gate(mCtx, next)
    const res = getResult()
    assert.equal(res.nextCalled, true)
    assert.equal(res.state.mention.hitWord, '阿醒')
    assert.equal(res.state.mention.persona, 'axing')
  }
})
