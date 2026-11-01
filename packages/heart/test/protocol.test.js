import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HEART_PROTOCOL_VERSION,
  HEART_CORE_VERSION,
  HEART_EVENTS,
  ERROR_CODES,
  validateObservation,
  validateActivityIntent,
  validateSnapshot,
} from '../contracts/index.js'

test('Heart Protocol v1: 常量与版本号契约', () => {
  assert.equal(HEART_PROTOCOL_VERSION, '1.0.0')
  assert.equal(HEART_CORE_VERSION, '0.20.0')
  assert.equal(HEART_EVENTS.STATE_CHANGED, 'heart/state-changed')
  assert.equal(HEART_EVENTS.IDLE, 'heart/idle')
})

test('Heart Protocol v1: observe() 输入合法性校验', () => {
  // 1. 空输入或非对象输入拦截
  assert.equal(validateObservation(null).valid, false)
  assert.equal(validateObservation(undefined).valid, false)
  assert.equal(validateObservation('string').valid, false)
  assert.equal(validateObservation([]).valid, false)

  // 2. 缺失必要字段拦截
  assert.equal(validateObservation({ source: 'qq', confidence: 0.8 }).valid, false)
  assert.equal(validateObservation({ type: 'sticker', confidence: 0.8 }).valid, false)
  assert.equal(validateObservation({ type: 'sticker', source: 'qq' }).valid, false)

  // 3. 置信度范围严格校验 [0.0, 1.0]
  assert.equal(validateObservation({ type: 'sticker', source: 'qq', confidence: -0.1 }).valid, false)
  assert.equal(validateObservation({ type: 'sticker', source: 'qq', confidence: 1.05 }).valid, false)
  assert.equal(validateObservation({ type: 'sticker', source: 'qq', confidence: NaN }).valid, false)
  assert.equal(validateObservation({ type: 'sticker', source: 'qq', confidence: 'invalid' }).valid, false)

  // 4. 合法输入通过
  const res = validateObservation({
    type: 'sticker',
    source: 'qq',
    confidence: 0.85,
    evidence: { meaning: 'comfort', id: 'face123' },
    summary: '收到安慰表情包',
  })
  assert.equal(res.valid, true)
  assert.equal(res.data.type, 'sticker')
  assert.equal(res.data.source, 'qq')
  assert.equal(res.data.confidence, 0.85)
  assert.equal(res.data.evidence.meaning, 'comfort')
  assert.ok(res.data.timestamp)
})

test('Heart Protocol v1 安全防御: 坚决拦截外部直接篡改 Mood 数值', () => {
  // 严禁外部直接指定 valence / arousal / energy / moodDelta / state
  const attacks = [
    { type: 'sticker', source: 'qq', confidence: 0.9, valence: 0.5 },
    { type: 'sticker', source: 'qq', confidence: 0.9, arousal: 0.8 },
    { type: 'sticker', source: 'qq', confidence: 0.9, energy: 0.2 },
    { type: 'sticker', source: 'qq', confidence: 0.9, state: 'excited' },
    { type: 'sticker', source: 'qq', confidence: 0.9, moodDelta: { dv: 0.5 } },
    { type: 'sticker', source: 'qq', confidence: 0.9, delta: 0.3 },
  ]

  for (const attack of attacks) {
    const res = validateObservation(attack)
    assert.equal(res.valid, false, `未能拦截攻击载荷: ${JSON.stringify(attack)}`)
    assert.equal(res.code, ERROR_CODES.INVALID_OBSERVATION)
    assert.match(res.error, /Security violation: direct mood mutation/)
  }
})

test('Heart Protocol v1: evaluateActivity() 意图合法性校验', () => {
  // 1. 空输入拦截
  assert.equal(validateActivityIntent(null).valid, false)
  assert.equal(validateActivityIntent('').valid, false)

  // 2. 字符串意图解析
  const res1 = validateActivityIntent('browse_bilibili')
  assert.equal(res1.valid, true)
  assert.equal(res1.data.intent, 'browse_bilibili')
  assert.equal(res1.data.estimatedDurationMinutes, 15)

  // 3. 对象意图解析与耗时边界归一化
  const res2 = validateActivityIntent({
    intent: 'study_code',
    category: 'study',
    estimatedDurationMinutes: 60,
  })
  assert.equal(res2.valid, true)
  assert.equal(res2.data.intent, 'study_code')
  assert.equal(res2.data.category, 'study')
  assert.equal(res2.data.estimatedDurationMinutes, 60)

  // 4. 超大超小耗时边界夹取
  const res3 = validateActivityIntent({ intent: 'quick_check', estimatedDurationMinutes: -5 })
  assert.equal(res3.data.estimatedDurationMinutes, 1)
  const res4 = validateActivityIntent({ intent: 'long_task', estimatedDurationMinutes: 999 })
  assert.equal(res4.data.estimatedDurationMinutes, 300)
})

test('Heart Protocol v1: validateSnapshot() 格式校验', () => {
  assert.equal(validateSnapshot(null), false)
  assert.equal(validateSnapshot({}), false)

  const validSnapshot = {
    protocolVersion: '1.0.0',
    heartVersion: '0.20.0',
    timestamp: new Date().toISOString(),
    device: 'phone',
    memoryMode: 'legacy',
    mood: {
      state: 'calm',
      intensity: 0,
      reason: 'baseline',
      valence: 0.2,
      arousal: 0.3,
      energy: 0.6,
      why: '日常基准状态',
      updatedAt: new Date().toISOString(),
    },
    presence: { status: 'present' },
    idle: { date: '2026-10-31', totalUsed: 0, totalCap: 6, nextIdleAt: null, categories: [] },
  }
  assert.equal(validateSnapshot(validSnapshot), true)

  // 缺少核心 mood 属性判定非法
  const invalidSnapshot = { ...validSnapshot, mood: { state: 'calm' } }
  assert.equal(validateSnapshot(invalidSnapshot), false)
})
