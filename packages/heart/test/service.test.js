import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HeartService } from '../lib/service.js'
import { HEART_EVENTS } from '../contracts/index.js'
import { ensureLayout, writeHeartConfig } from '../lib/store.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'heart-service-test-'))

class MockCordisContext {
  constructor() {
    this.events = new Map()
    this.provided = new Map()
  }

  on(name, listener) {
    if (!this.events.has(name)) this.events.set(name, [])
    this.events.get(name).push(listener)
    return () => {
      const arr = this.events.get(name) || []
      const idx = arr.indexOf(listener)
      if (idx !== -1) arr.splice(idx, 1)
    }
  }

  async parallel(name, ...args) {
    const list = this.events.get(name) || []
    await Promise.all(list.map((fn) => fn(...args)))
  }

  emit(name, ...args) {
    const list = this.events.get(name) || []
    for (const fn of list) {
      fn(...args)
    }
  }

  provide(name, value) {
    this.provided.set(name, value)
    return () => this.provided.delete(name)
  }

  get(name) {
    return this.provided.get(name)
  }
}

test('HeartService: 1. getSnapshot() 返回只读只查快照', () => {
  const root = tmpDir()
  ensureLayout(root)
  const ctx = new MockCordisContext()
  const service = new HeartService(ctx, root, { device: 'phone' })

  const snapshot = service.getSnapshot()
  assert.equal(snapshot.protocolVersion, '1.0.0')
  assert.equal(snapshot.heartVersion, '0.20.0')
  assert.equal(snapshot.device, 'phone')
  assert.equal(snapshot.mood.state, 'calm')
  assert.equal(typeof snapshot.mood.valence, 'number')
  assert.equal(typeof snapshot.mood.arousal, 'number')
  assert.equal(typeof snapshot.mood.energy, 'number')
  assert.ok(snapshot.timestamp)

  // 验证快照为 Object.freeze 保护的只读对象
  assert.throws(() => {
    snapshot.mood.state = 'hacked'
  })
})

test('HeartService: 2. observe() 接收感知并由 Heart 自主决定情绪变化', async () => {
  const root = tmpDir()
  ensureLayout(root)
  const ctx = new MockCordisContext()
  const service = new HeartService(ctx, root, { device: 'phone' })

  const emittedEvents = []
  ctx.on(HEART_EVENTS.STATE_CHANGED, (evt) => {
    emittedEvents.push(evt)
  })

  // 1. 尝试注入非法三维数值直接被拦截
  const hackRes = await service.observe({
    type: 'sticker',
    source: 'qq',
    confidence: 0.9,
    valence: 0.99,
  })
  assert.equal(hackRes.accepted, false)
  assert.equal(hackRes.stateChanged, false)
  assert.equal(emittedEvents.length, 0)

  // 2. 正常表情包感知输入：带安慰意味 -> Heart 自主更新至 cheerful
  const stickerRes = await service.observe({
    type: 'sticker',
    source: 'sticker-look',
    confidence: 0.85,
    evidence: { meaning: 'comfort', id: 'face001' },
    summary: '用户发送了安慰抱抱表情包',
  })
  assert.equal(stickerRes.accepted, true)
  assert.equal(stickerRes.stateChanged, true)
  assert.match(stickerRes.actionTaken, /mood_updated_cheerful/)
  assert.equal(stickerRes.snapshot.mood.state, 'cheerful')

  // 验证触发了 heart/state-changed 事件
  assert.equal(emittedEvents.length, 1)
  assert.equal(emittedEvents[0].prev.mood.state, 'calm')
  assert.equal(emittedEvents[0].current.mood.state, 'cheerful')
  assert.equal(emittedEvents[0].eventSource, 'observation:sticker')

  // 3. 低置信度感知输入 (<0.3) -> 记日志但不改变状态
  const lowConfRes = await service.observe({
    type: 'sticker',
    source: 'sticker-look',
    confidence: 0.2,
    evidence: { meaning: 'comfort' },
  })
  assert.equal(lowConfRes.accepted, true)
  assert.equal(lowConfRes.stateChanged, false)
})

test('HeartService: 3. evaluateActivity() 评估自主活动适宜性（不承担执行授权）', async () => {
  const root = tmpDir()
  ensureLayout(root)
  const ctx = new MockCordisContext()
  const service = new HeartService(ctx, root, {
    device: 'phone',
    quietFrom: '04:00',
    quietTo: '04:00', // 禁用安静时段以确保日间活动判定不受深夜测试时钟影响
    idleTurnDailyCap: 4,
    idleCategories: [
      { id: 'bilibili', label: 'B站浏览', dailyCap: 2 },
      { id: 'study', label: '代码学习', dailyCap: 2 },
    ],
  })

  // 1. 正常活动评估 -> 适宜
  const eval1 = service.evaluateActivity({ intent: 'browse_bilibili', category: 'bilibili' })
  assert.equal(eval1.suitable, true)
  assert.equal(eval1.reason, 'ok')
  assert.equal(eval1.quota.cap, 2)

  // 2. 安静时段拦截
  const serviceNight = new HeartService(ctx, root, {
    device: 'phone',
    quietFrom: '00:00',
    quietTo: '23:59', // 全天安静时段模拟
  })
  const evalNight = serviceNight.evaluateActivity({ intent: 'browse_bilibili', category: 'bilibili' })
  assert.equal(evalNight.suitable, false)
  assert.equal(evalNight.reason, 'quiet-hours')

  // 3. 疲惫状态 (tired) 下劝阻重度学习
  const { updateMood } = await import('../lib/mood.js')
  updateMood(root, { state: 'tired', intensity: 0.5, reason: 'deep_work' })
  const evalTired = service.evaluateActivity({ intent: 'heavy_audit', category: 'study' })
  assert.equal(evalTired.suitable, false)
  assert.equal(evalTired.reason, 'mood-tired')
})

test('HeartService 容错防御: 外部事件监听器异常不阻断 Heart 内部运行', async () => {
  const root = tmpDir()
  ensureLayout(root)
  const ctx = new MockCordisContext()
  const service = new HeartService(ctx, root, { device: 'phone' })

  // 注册一个恶意或崩溃的外部监听器
  ctx.on(HEART_EVENTS.STATE_CHANGED, async () => {
    throw new Error('Crashing external listener!')
  })

  // Heart 触发感知与状态变更，绝不能抛错中断
  const res = await service.observe({
    type: 'wake',
    source: 'qq',
    confidence: 0.9,
    evidence: { userCalled: true },
    summary: '收到对话呼唤',
  })

  assert.equal(res.accepted, true)
  assert.equal(res.stateChanged, true)
})
