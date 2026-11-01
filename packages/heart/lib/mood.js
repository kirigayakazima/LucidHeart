// dsh-heart 的 Mood（情绪感知与连续内生状态层）。
//
// 核心原则（路线 C：小规模 Mood 2.0 实验）：
// 1. 三维连续内生状态：valence（愉悦度 [-1, 1]）、arousal（激活度 [0, 1]）、energy（精力度 [0, 1]）；
// 2. 读时向非零基线自然回落（valence: 0.2, arousal: 0.3, energy: 0.6），零后台定时器；
// 3. 事件产生冲量叠加在当前衰减后的有效状态之上，不丢失前序尚未衰减的影响；
// 4. 持久化记录最近一次有效事件的简短 why 原因，收敛至日常底噪后弱化原因；
// 5. 保持现有 heart_mood 调用接口 100% 兼容，透明迁移 v1 数据，提示词提供弱表达倾向参考。

import fs from 'node:fs'
import path from 'node:path'
import {
  ensureLayout,
  resolveRoot,
  acquireDirLock,
  releaseDirLock,
  isDirLockHeld,
  safeAtomicReplace,
} from './store.js'
import { log } from './logger.js'

export const MOOD_FILE = 'mood.json'
export const MOOD_SCHEMA_VERSION = 1

// ---------------------------------------------------------------- 常量配置与基线参数
/** 三维中性基线（非零底噪） */
export const BASELINE = Object.freeze({
  valence: 0.2,
  arousal: 0.3,
  energy: 0.6,
})

/** 各维度指数衰减半衰期 (毫秒) */
export const HALF_LIFE_MS = Object.freeze({
  valence: 12 * 60 * 60 * 1000, // 12 小时
  arousal: 4 * 60 * 60 * 1000,   // 4 小时
  energy: 24 * 60 * 60 * 1000,  // 24 小时
})

/** 默认离散状态与兼容原因枚举 */
export const MOOD_STATES = Object.freeze(['calm', 'engaged', 'cheerful', 'excited', 'tired'])
export const MOOD_REASONS = Object.freeze([
  'baseline',
  'task_completed',
  'positive_interaction',
  'focus',
  'deep_work',
])

export const DEFAULT_HALF_LIFE_MS = 2 * 60 * 60 * 1000 // 兼容旧版常量（2小时）
export const LOW_INTENSITY_THRESHOLD = 0.15           // 兼容旧版常量 / 底噪判决阈值

/**
 * 状态与原因映射矩阵 (State-Reason Matrix)：
 * 严格限制原因能够触发的状态及强度范围，杜绝无事实依据的越权状态跳转。
 */
export const STATE_REASON_MATRIX = Object.freeze({
  baseline: Object.freeze({
    allowedStates: Object.freeze(['calm']),
    minIntensity: 0.0,
    maxIntensity: 0.0,
  }),
  task_completed: Object.freeze({
    allowedStates: Object.freeze(['engaged', 'cheerful', 'excited']),
    minIntensity: 0.3,
    maxIntensity: 1.0,
    stateConstraints: Object.freeze({
      excited: Object.freeze({ minIntensity: 0.7 }),
    }),
  }),
  positive_interaction: Object.freeze({
    allowedStates: Object.freeze(['cheerful', 'excited']),
    minIntensity: 0.3,
    maxIntensity: 0.9,
    stateConstraints: Object.freeze({
      excited: Object.freeze({ minIntensity: 0.7 }),
    }),
  }),
  focus: Object.freeze({
    allowedStates: Object.freeze(['engaged']),
    minIntensity: 0.4,
    maxIntensity: 0.9,
  }),
  deep_work: Object.freeze({
    allowedStates: Object.freeze(['tired']),
    minIntensity: 0.2,
    maxIntensity: 0.6,
  }),
})

export const MOOD_PROMPT_DESCRIPTIONS = Object.freeze({
  engaged: Object.freeze({
    label: '投入、专注',
    advice: '清晰、积极推进，保持专注节奏。',
  }),
  cheerful: Object.freeze({
    label: '轻快、愉悦',
    advice: '可以适度活泼、亲切，但保持自然。',
  }),
  excited: Object.freeze({
    label: '兴奋、活跃',
    advice: '更有活力与热情，但避免过度夸张。',
  }),
  tired: Object.freeze({
    label: '低活跃、舒缓',
    advice: '简洁、柔和，不刻意拖沓，不作为拒绝任务的理由。',
  }),
})

// ---------------------------------------------------------------- 数学工具与连续衰减
/**
 * 数值限制并保留两位小数
 */
export function clamp(val, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return min
  const n = Math.min(max, Math.max(min, val))
  return Math.round(n * 100) / 100
}

/**
 * 单维度向非零基线指数回落纯函数：
 * S(t) = B + (S_0 - B) * 2^(-dt / H)
 * 具备时钟倒退防御（dt < 0 按 0 计算，绝不放大振幅）
 */
export function decayDimension(current, baseline, elapsedMs, halfLifeMs) {
  if (typeof current !== 'number' || isNaN(current)) return baseline
  if (typeof elapsedMs !== 'number' || elapsedMs <= 0) return current
  const h = typeof halfLifeMs === 'number' && halfLifeMs > 0 ? halfLifeMs : 12 * 3600 * 1000
  return baseline + (current - baseline) * Math.pow(2, -elapsedMs / h)
}

/**
 * 旧版单维度衰减函数（保持 100% 精确兼容）：
 * I(t) = I_0 * 2^(-t / H)
 * 具备时间倒退防御：若 elapsedMs < 0，视为 0，绝不放大强度。
 */
export function calculateDecayedIntensity(initialIntensity, elapsedMs, halfLifeMs = DEFAULT_HALF_LIFE_MS) {
  if (typeof initialIntensity !== 'number' || isNaN(initialIntensity) || initialIntensity <= 0) {
    return 0.0
  }
  if (typeof elapsedMs !== 'number' || isNaN(elapsedMs) || elapsedMs <= 0) {
    return Math.min(1.0, Math.max(0.0, initialIntensity))
  }
  const h = typeof halfLifeMs === 'number' && halfLifeMs > 0 ? halfLifeMs : DEFAULT_HALF_LIFE_MS
  const decayed = initialIntensity * Math.pow(2, -elapsedMs / h)
  return Math.min(1.0, Math.max(0.0, decayed))
}

/**
 * 计算三维状态与中性基线的欧氏距离（用于判定事件温差与 why 显隐）
 */
export function calculateDistanceToBaseline(v, a, e) {
  const dv = (typeof v === 'number' ? v : BASELINE.valence) - BASELINE.valence
  const da = (typeof a === 'number' ? a : BASELINE.arousal) - BASELINE.arousal
  const de = (typeof e === 'number' ? e : BASELINE.energy) - BASELINE.energy
  const dist = Math.sqrt(dv * dv + da * da + de * de)
  return Math.round(dist * 100) / 100
}

/**
 * 根据三维连续状态推导离散主导标签（保持向后兼容）
 */
export function deriveDominantState(v, a, e) {
  const dist = calculateDistanceToBaseline(v, a, e)
  if (dist <= LOW_INTENSITY_THRESHOLD) {
    return 'calm'
  }
  if (e < 0.45 && a < 0.35) {
    return 'tired'
  }
  if (v > 0.45 && a > 0.45) {
    return 'excited'
  }
  if (v > 0.35) {
    return 'cheerful'
  }
  if (a > 0.38) {
    return 'engaged'
  }
  return 'calm'
}

/**
 * 默认基准状态工厂函数。
 */
export function createDefaultMood(now = new Date()) {
  const dateStr = now instanceof Date && !isNaN(now.getTime()) ? now.toISOString() : new Date().toISOString()
  return {
    schemaVersion: MOOD_SCHEMA_VERSION,
    state: 'calm',
    intensity: 0.0,
    updatedAt: dateStr,
    reason: 'baseline',
    valence: BASELINE.valence,
    arousal: BASELINE.arousal,
    energy: BASELINE.energy,
    why: '日常基准状态',
  }
}

// ---------------------------------------------------------------- 数据校验与透明转换
/**
 * 校验持久化（或待计算有效状态）的 Mood 记录结构与字段合法性（Pure Function）。
 *
 * 严格规则：
 * 1. 必须为非空普通对象且非数组；
 * 2. schemaVersion 必须严格等于 MOOD_SCHEMA_VERSION (1)；
 * 3. state 必须为合法的离散状态 (MOOD_STATES)；
 * 4. intensity 必须为 [0.0, 1.0] 闭区间内的有限数值；
 * 5. reason 必须为合法的触发原因 (MOOD_REASONS)；
 * 6. updatedAt 必须为非空字符串，且能被 Date.parse() 成功解析为有效时间戳；
 * 7. 若存在三维属性 (valence/arousal/energy)，必须符合各自区间范围。
 */
export function isValidPersistedMood(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return false
  }
  const { schemaVersion, state, intensity, reason, updatedAt } = record
  if (schemaVersion !== MOOD_SCHEMA_VERSION) {
    return false
  }
  if (typeof state !== 'string' || !MOOD_STATES.includes(state)) {
    return false
  }
  if (typeof intensity !== 'number' || isNaN(intensity) || !isFinite(intensity) || intensity < 0.0 || intensity > 1.0) {
    return false
  }
  if (typeof reason !== 'string' || !MOOD_REASONS.includes(reason)) {
    return false
  }
  if (typeof updatedAt !== 'string' || !updatedAt.trim() || isNaN(Date.parse(updatedAt))) {
    return false
  }
  if (typeof record.valence === 'number' && (isNaN(record.valence) || record.valence < -1.0 || record.valence > 1.0)) {
    return false
  }
  if (typeof record.arousal === 'number' && (isNaN(record.arousal) || record.arousal < 0.0 || record.arousal > 1.0)) {
    return false
  }
  if (typeof record.energy === 'number' && (isNaN(record.energy) || record.energy < 0.0 || record.energy > 1.0)) {
    return false
  }
  return true
}

/**
 * 归一化为完整状态结构
 */
export function normalizeToV2(record, now = new Date()) {
  return getEffectiveMood(record, now)
}

/**
 * 离散状态到三维冲量增量（Impulse）的确定性映射
 */
export function mapStateTo3DImpulse(state, intensity) {
  const i = typeof intensity === 'number' ? Math.max(0, Math.min(1, intensity)) : 0.5
  switch (state) {
    case 'cheerful':
      return { dv: 0.5 * i, da: 0.1 * i, de: 0.0 }
    case 'excited':
      return { dv: 0.5 * i, da: 0.5 * i, de: -0.1 * i }
    case 'engaged':
      return { dv: 0.2 * i, da: 0.3 * i, de: -0.05 * i }
    case 'tired':
      return { dv: -0.05 * i, da: -0.2 * i, de: -0.4 * i }
    case 'calm':
    default:
      return { dv: 0.0, da: 0.0, de: 0.0 }
  }
}

export function mapReasonToWhy(reason, state) {
  switch (reason) {
    case 'task_completed':
      return '完成了一项有意义的任务'
    case 'positive_interaction':
      return '与用户有了积极愉快的互动'
    case 'focus':
      return '进入深度专注攻坚'
    case 'deep_work':
      return '经历了持续较长时间的高负荷工作'
    case 'baseline':
    default:
      return state === 'calm' ? '日常基准状态' : '日常状态'
  }
}

/**
 * 计算给定时间点的三维与离散有效状态（读时连续衰减计算，无定时写盘）
 */
export function getEffectiveMood(
  persistedMood,
  now = new Date(),
  { halfLifeMs = DEFAULT_HALF_LIFE_MS, lowThreshold = LOW_INTENSITY_THRESHOLD } = {}
) {
  if (!isValidPersistedMood(persistedMood)) {
    return createDefaultMood(now)
  }

  const updatedTime = Date.parse(persistedMood.updatedAt)
  const currentTime = (now instanceof Date ? now : new Date(now)).getTime()
  const elapsedMs = isNaN(currentTime) || isNaN(updatedTime) ? 0 : Math.max(0, currentTime - updatedTime)

  // 1. 三维初始值提取（兼容只有旧版字段的历史数据）
  let initV = BASELINE.valence
  let initA = BASELINE.arousal
  let initE = BASELINE.energy
  let initWhy = '日常基准状态'

  if (
    typeof persistedMood.valence === 'number' &&
    typeof persistedMood.arousal === 'number' &&
    typeof persistedMood.energy === 'number'
  ) {
    initV = persistedMood.valence
    initA = persistedMood.arousal
    initE = persistedMood.energy
    initWhy = persistedMood.why || mapReasonToWhy(persistedMood.reason, persistedMood.state)
  } else {
    const impulse = mapStateTo3DImpulse(persistedMood.state, persistedMood.intensity)
    initV = clamp(BASELINE.valence + impulse.dv, -1.0, 1.0)
    initA = clamp(BASELINE.arousal + impulse.da, 0.0, 1.0)
    initE = clamp(BASELINE.energy + impulse.de, 0.0, 1.0)
    initWhy = mapReasonToWhy(persistedMood.reason, persistedMood.state)
  }

  // 2. 三维独立向非零基线指数回落
  const curV = decayDimension(initV, BASELINE.valence, elapsedMs, HALF_LIFE_MS.valence)
  const curA = decayDimension(initA, BASELINE.arousal, elapsedMs, HALF_LIFE_MS.arousal)
  const curE = decayDimension(initE, BASELINE.energy, elapsedMs, HALF_LIFE_MS.energy)

  const roundedV = clamp(curV, -1.0, 1.0)
  const roundedA = clamp(curA, 0.0, 1.0)
  const roundedE = clamp(curE, 0.0, 1.0)
  const dist = calculateDistanceToBaseline(roundedV, roundedA, roundedE)

  // 3. 传统状态与强度衰减（保持 Step 2 既有契约 100% 精确兼容）
  let effectiveIntensity = 0.0
  let effectiveState = 'calm'

  if (persistedMood.state === 'calm') {
    effectiveIntensity = 0.0
    effectiveState = 'calm'
  } else {
    const decayedLegacy = calculateDecayedIntensity(persistedMood.intensity, elapsedMs, halfLifeMs)
    const roundedLegacy = Math.round(decayedLegacy * 100) / 100
    if (roundedLegacy <= lowThreshold) {
      effectiveIntensity = 0.0
      effectiveState = 'calm'
    } else {
      effectiveIntensity = roundedLegacy
      effectiveState = persistedMood.state
    }
  }

  return {
    schemaVersion: MOOD_SCHEMA_VERSION,
    state: effectiveState,
    intensity: effectiveIntensity,
    reason: persistedMood.reason,
    updatedAt: persistedMood.updatedAt,
    valence: roundedV,
    arousal: roundedA,
    energy: roundedE,
    why: dist <= lowThreshold ? '日常基准状态' : initWhy,
  }
}

// ---------------------------------------------------------------- 候选校验与转移判定
/**
 * 校验候选更新的合法性
 */
export function validateMoodCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, reason: 'invalid-input', message: '候选状态必须是非空对象' }
  }

  // 1. 如果传入的是三维连续状态
  if (
    typeof candidate.valence === 'number' ||
    typeof candidate.arousal === 'number' ||
    typeof candidate.energy === 'number'
  ) {
    const v = candidate.valence !== undefined ? candidate.valence : BASELINE.valence
    const a = candidate.arousal !== undefined ? candidate.arousal : BASELINE.arousal
    const e = candidate.energy !== undefined ? candidate.energy : BASELINE.energy

    if (typeof v !== 'number' || isNaN(v) || v < -1.0 || v > 1.0) {
      return { ok: false, reason: 'invalid-valence', message: 'valence 必须在 -1.0 到 1.0 之间' }
    }
    if (typeof a !== 'number' || isNaN(a) || a < 0.0 || a > 1.0) {
      return { ok: false, reason: 'invalid-arousal', message: 'arousal 必须在 0.0 到 1.0 之间' }
    }
    if (typeof e !== 'number' || isNaN(e) || e < 0.0 || e > 1.0) {
      return { ok: false, reason: 'invalid-energy', message: 'energy 必须在 0.0 到 1.0 之间' }
    }
    return { ok: true, is3D: true }
  }

  // 2. 传统 state / intensity / reason 校验
  const { state, intensity, reason } = candidate
  if (typeof state !== 'string' || !MOOD_STATES.includes(state)) {
    return {
      ok: false,
      reason: 'invalid-state',
      message: `非法情绪状态: ${state}，必须是 ${MOOD_STATES.join(', ')} 之一`,
    }
  }
  if (typeof intensity !== 'number' || isNaN(intensity) || !isFinite(intensity) || intensity < 0.0 || intensity > 1.0) {
    return { ok: false, reason: 'invalid-intensity', message: '强度必须是 0.0 到 1.0 之间的有限数值' }
  }
  if (typeof reason !== 'string' || !MOOD_REASONS.includes(reason)) {
    return {
      ok: false,
      reason: 'invalid-reason',
      message: `非法触发原因: ${reason}，必须是 ${MOOD_REASONS.join(', ')} 之一`,
    }
  }
  return { ok: true, isLegacy: true }
}

/**
 * 状态转移规则判定与冲量计算：
 * 关键特性：必须在衰减后的当前有效状态之上叠加新事件冲量！
 */
export function shouldUpdateMood(currentEffectiveMood, candidate) {
  const valid = validateMoodCandidate(candidate)
  if (!valid.ok) return valid

  // 1. 三维直接赋值模式
  if (valid.is3D) {
    const v = clamp(candidate.valence !== undefined ? candidate.valence : BASELINE.valence, -1.0, 1.0)
    const a = clamp(candidate.arousal !== undefined ? candidate.arousal : BASELINE.arousal, 0.0, 1.0)
    const e = clamp(candidate.energy !== undefined ? candidate.energy : BASELINE.energy, 0.0, 1.0)
    const why = candidate.why ? String(candidate.why).trim() : '状态更新'

    return {
      ok: true,
      target3D: { valence: v, arousal: a, energy: e, why },
      normalizedState: deriveDominantState(v, a, e),
      normalizedIntensity: calculateDistanceToBaseline(v, a, e),
      reason: candidate.reason || 'custom_update',
    }
  }

  // 2. 传统参数与矩阵约束模式
  const { state, intensity, reason } = candidate
  const rule = STATE_REASON_MATRIX[reason]
  if (!rule) {
    return { ok: false, reason: 'unknown-reason-rule', message: `未定义原因规则: ${reason}` }
  }

  if (!rule.allowedStates.includes(state)) {
    return {
      ok: false,
      reason: 'state-reason-mismatch',
      message: `原因 "${reason}" 不能触发状态 "${state}"（允许目标: ${rule.allowedStates.join(', ')}）`,
    }
  }

  if (intensity < rule.minIntensity || intensity > rule.maxIntensity) {
    return {
      ok: false,
      reason: 'intensity-out-of-range',
      message: `状态 "${state}" 在原因 "${reason}" 下强度必须在 ${rule.minIntensity} ~ ${rule.maxIntensity} 之间（当前 ${intensity}）`,
    }
  }

  if (rule.stateConstraints && rule.stateConstraints[state]) {
    const sub = rule.stateConstraints[state]
    if (typeof sub.minIntensity === 'number' && intensity < sub.minIntensity) {
      return {
        ok: false,
        reason: 'intensity-too-low-for-state',
        message: `状态 "${state}" 在原因 "${reason}" 下要求强度至少为 ${sub.minIntensity}（当前 ${intensity}）`,
      }
    }
  }

  const normalizedIntensity = state === 'calm' ? 0.0 : Math.round(intensity * 100) / 100

  // 微小变化抑制（与当前有效状态对比）
  if (
    currentEffectiveMood &&
    currentEffectiveMood.state === state &&
    currentEffectiveMood.reason === reason &&
    Math.abs((currentEffectiveMood.intensity || 0) - normalizedIntensity) < 0.05
  ) {
    return {
      ok: false,
      reason: 'no-significant-change',
      message: '与当前有效状态相比无显著新事件变化，保持自然衰减即可',
    }
  }

  // 计算新事件在当前有效状态上的冲量叠加
  const effV = typeof currentEffectiveMood?.valence === 'number' ? currentEffectiveMood.valence : BASELINE.valence
  const effA = typeof currentEffectiveMood?.arousal === 'number' ? currentEffectiveMood.arousal : BASELINE.arousal
  const effE = typeof currentEffectiveMood?.energy === 'number' ? currentEffectiveMood.energy : BASELINE.energy

  let targetV, targetA, targetE
  if (state === 'calm') {
    // calm 快速平复回基线
    targetV = BASELINE.valence
    targetA = BASELINE.arousal
    targetE = BASELINE.energy
  } else {
    const impulse = mapStateTo3DImpulse(state, normalizedIntensity)
    targetV = clamp(effV + impulse.dv, -1.0, 1.0)
    targetA = clamp(effA + impulse.da, 0.0, 1.0)
    targetE = clamp(effE + impulse.de, 0.0, 1.0)
  }

  const why = candidate.why ? String(candidate.why).trim() : mapReasonToWhy(reason, state)

  return {
    ok: true,
    target3D: { valence: targetV, arousal: targetA, energy: targetE, why },
    normalizedState: state,
    normalizedIntensity,
    reason,
  }
}

// ---------------------------------------------------------------- 存储读取与带锁原子写入
/**
 * 只读获取当前有效状态（内存读时衰减计算，不写盘）
 */
export function readMood(root, now = new Date()) {
  const dir = resolveRoot(root)
  const file = path.join(dir, 'body', MOOD_FILE)
  try {
    if (!fs.existsSync(file)) {
      return createDefaultMood(now)
    }
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (!isValidPersistedMood(parsed)) {
      // 损坏或非法数据：只读内存安全回退，绝不覆盖破坏磁盘现有现场
      return createDefaultMood(now)
    }
    return getEffectiveMood(parsed, now)
  } catch {
    // I/O 或语法解析异常：只读安全回退
    return createDefaultMood(now)
  }
}

/**
 * 读取磁盘持久化保存的原始对象（无衰减计算）。供诊断与白盒测试使用。
 */
export function readPersistedMood(root) {
  const dir = resolveRoot(root)
  const file = path.join(dir, 'body', MOOD_FILE)
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 校验并持久化更新情绪状态（Mood 2.0 带锁读-改-写）。
 */
export function updateMood(root, candidate, now = new Date()) {
  const dir = ensureLayout(root)
  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, MOOD_FILE)
  const lockDir = path.join(bodyDir, `${MOOD_FILE}.lock`)

  // 1. 获取当前有效状态，做前置状态转移判定
  const currentEffective = readMood(root, now)
  const decision = shouldUpdateMood(currentEffective, candidate)
  if (!decision.ok) {
    log.mood(root, 'debug', 'update_mood_rejected', { state: candidate?.state, reason: decision.reason, message: decision.message }, now)
    return decision
  }

  // 2. 获取跨进程互斥锁
  const lockToken = acquireDirLock(lockDir)
  if (!lockToken) {
    log.store(root, 'warn', 'lock_timeout', { lock: `${MOOD_FILE}.lock`, action: 'update_mood' }, now)
    return { ok: false, reason: 'lock-timeout', message: '获取文件锁超时，可能有其他并发写入操作' }
  }

  let tmpFile = null
  try {
    // 3. 锁内重新读取并校验，防并发时序竞争
    const freshEffective = readMood(root, now)
    const freshDecision = shouldUpdateMood(freshEffective, candidate)
    if (!freshDecision.ok) {
      log.mood(root, 'debug', 'update_mood_fresh_rejected', { reason: freshDecision.reason }, now)
      return freshDecision
    }

    // 4. 构造落盘持久化数据
    const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()
    const target = freshDecision.target3D
    const record = {
      schemaVersion: MOOD_SCHEMA_VERSION,
      state: freshDecision.normalizedState,
      intensity: freshDecision.normalizedIntensity,
      updatedAt: nowIso,
      reason: freshDecision.reason,
      valence: target.valence,
      arousal: target.arousal,
      energy: target.energy,
      why: target.why,
    }

    // 5. 写入唯一临时文件
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(bodyDir, `${MOOD_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2) + '\n', 'utf8')

    // 6. Fencing Check 校验锁有效性
    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
    }

    // 7. 安全原子替换
    safeAtomicReplace(tmpFile, file)
    log.mood(root, 'info', 'update_mood_success', {
      state: record.state,
      intensity: record.intensity,
      reason: record.reason,
      valence: record.valence,
      arousal: record.arousal,
      energy: record.energy,
    }, now)
    return { ok: true, mood: record }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    log.mood(root, 'error', 'update_mood_error', { error: err.message }, now)
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

/**
 * 重置情绪状态至默认 baseline。
 */
export function resetMood(root, now = new Date()) {
  const dir = ensureLayout(root)
  const bodyDir = path.join(dir, 'body')
  const file = path.join(bodyDir, MOOD_FILE)
  const lockDir = path.join(bodyDir, `${MOOD_FILE}.lock`)

  const lockToken = acquireDirLock(lockDir)
  if (!lockToken) {
    log.store(root, 'warn', 'lock_timeout', { lock: `${MOOD_FILE}.lock`, action: 'reset_mood' }, now)
    return { ok: false, reason: 'lock-timeout', message: '获取文件锁超时' }
  }

  let tmpFile = null
  try {
    const record = createDefaultMood(now)
    const rand = Math.random().toString(36).slice(2, 8)
    tmpFile = path.join(bodyDir, `${MOOD_FILE}.tmp.${process.pid}.${Date.now()}.${rand}`)
    fs.writeFileSync(tmpFile, JSON.stringify(record, null, 2) + '\n', 'utf8')

    if (!isDirLockHeld(lockDir, lockToken)) {
      throw new Error('写盘前锁凭据校验失败：锁已被其他操作接管或失效')
    }

    safeAtomicReplace(tmpFile, file)
    log.mood(root, 'info', 'reset_mood_success', { state: 'calm', intensity: 0.0 }, now)
    return { ok: true, mood: record }
  } catch (err) {
    if (tmpFile && fs.existsSync(tmpFile)) {
      try { fs.unlinkSync(tmpFile) } catch {}
    }
    log.mood(root, 'error', 'reset_mood_error', { error: err.message }, now)
    throw err
  } finally {
    releaseDirLock(lockDir, lockToken)
  }
}

// ---------------------------------------------------------------- 提示词格式化（弱约束指引）
/**
 * 格式化提示词小节文本。
 * 低侵入原则：有效状态为 calm 或强度 <= 0.15 时返回空串，不注入提示词。
 * 完整接通：将离散表达建议、三维内生连续底噪与事件背景（why）自然合流。
 */
export function formatMoodPrompt(effectiveMood) {
  if (!effectiveMood || typeof effectiveMood !== 'object') return ''
  const { state, intensity } = effectiveMood
  if (state === 'calm' || typeof intensity !== 'number' || intensity <= LOW_INTENSITY_THRESHOLD) {
    return ''
  }
  const desc = MOOD_PROMPT_DESCRIPTIONS[state]
  if (!desc) return ''

  const lines = [
    '### 当前表达状态',
    `当前倾向：${desc.label}。`,
    `表达建议：${desc.advice}`,
  ]

  // 融入三维内生连续底噪与近期事件背景（病历卡）
  if (
    typeof effectiveMood.valence === 'number' &&
    typeof effectiveMood.arousal === 'number' &&
    typeof effectiveMood.energy === 'number'
  ) {
    const v = effectiveMood.valence
    const a = effectiveMood.arousal
    const e = effectiveMood.energy
    const dist = calculateDistanceToBaseline(v, a, e)

    let vText = '心情平稳中性'
    if (v >= 0.4) vText = '略偏愉悦舒畅'
    else if (v <= 0.0) vText = '略显沉重内敛'

    let aText = '较为平静从容'
    if (a >= 0.5) aText = '较为活跃敏锐'
    else if (a <= 0.2) aText = '较为安静沉稳'

    let eText = '精力尚可'
    if (e >= 0.75) eText = '精力充沛'
    else if (e <= 0.4) eText = '精力消耗较多（表达宜简洁柔和，不影响实际工作）'

    lines.push(`- 连续底噪参考：当前${vText}、${aText}，${eText}。`)

    if (dist > LOW_INTENSITY_THRESHOLD && effectiveMood.why && effectiveMood.why !== '日常基准状态') {
      lines.push(`- 状态背景：近期${effectiveMood.why}。`)
    }
  }

  lines.push(
    '该状态是短期表达参考，不是固定人格规则。优先清晰完成用户的实际任务，不必刻意表现出某种情绪，也不要为了符合状态而改变答案的正确性；精力状态绝不作为拒绝任务的理由。'
  )

  return lines.join('\n')
}

/**
 * 格式化三维内部状态弱约束指引（Mood 2.0 专用）
 */
export function format3DMoodPrompt(effectiveMood) {
  if (!effectiveMood || typeof effectiveMood !== 'object') return ''
  const v = typeof effectiveMood.valence === 'number' ? effectiveMood.valence : BASELINE.valence
  const a = typeof effectiveMood.arousal === 'number' ? effectiveMood.arousal : BASELINE.arousal
  const e = typeof effectiveMood.energy === 'number' ? effectiveMood.energy : BASELINE.energy
  const dist = calculateDistanceToBaseline(v, a, e)
  if (dist <= LOW_INTENSITY_THRESHOLD) return ''

  let vText = '心情平稳中性'
  if (v >= 0.4) vText = '略偏愉悦舒畅'
  else if (v <= 0.0) vText = '略显沉重内敛'

  let aText = '较为平静从容'
  if (a >= 0.5) aText = '较为活跃敏锐'
  else if (a <= 0.2) aText = '较为安静沉稳'

  let eText = '精力尚可'
  if (e >= 0.75) eText = '精力充沛'
  else if (e <= 0.4) eText = '精力消耗较多（表达宜简洁柔和，不影响实际工作）'

  const whyText = dist > LOW_INTENSITY_THRESHOLD && effectiveMood.why && effectiveMood.why !== '日常基准状态'
    ? `\n- 状态背景：近期${effectiveMood.why}。`
    : ''

  return [
    '### 当前内部状态（短期表达倾向参考）',
    `- 倾向状态：当前${vText}、${aText}，${eText}。${whyText}`,
    '- 指引说明：当前内部状态是自然变化的表达底噪与倾向参考，不是固定人格设定，也不需要向用户汇报。优先清晰完成用户的实际任务，不必刻意表现出某种情绪，也不要为了符合状态而改变答案的正确性；精力状态绝不作为拒绝任务的理由。',
  ].join('\n')
}
