// Heart Protocol v1: 输入验证与安全防御模块
// 确保任何外部输入均经过严格校验，防止外部插件越权直接写入 Mood 或注入恶意负载。

import {
  HEART_PROTOCOL_VERSION,
  SENSORY_SOURCES,
  SENSORY_TYPES,
  ERROR_CODES,
} from './types.js'

/**
 * 校验外部感知观察输入 (heart.observe)
 *
 * 核心安全规则：
 * 1. 必须包含 type, source, timestamp, confidence。
 * 2. confidence 必须处于 [0.0, 1.0] 闭区间。
 * 3. 严禁外部直接指定 valence, arousal, energy, moodDelta 或 state！
 *    若包含此类字段，必须彻底剔除或拦截，杜绝三维数值被外部篡改。
 * 4. 来源与类型必须属于已知类型或合法自定义标识符。
 */
export function validateObservation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_OBSERVATION,
      error: 'Observation input must be a non-null object',
    }
  }

  // 1. 类型校验
  const type = typeof input.type === 'string' ? input.type.trim() : ''
  if (!type || !/^[a-zA-Z0-9_\-\.]{1,40}$/.test(type)) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_OBSERVATION,
      error: `Invalid or missing observation type: "${input.type}"`,
    }
  }

  // 2. 来源校验
  const source = typeof input.source === 'string' ? input.source.trim() : ''
  if (!source || !/^[a-zA-Z0-9_\-\.]{1,40}$/.test(source)) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_OBSERVATION,
      error: `Invalid or missing observation source: "${input.source}"`,
    }
  }

  // 3. 置信度校验
  const confidence = Number(input.confidence)
  if (!Number.isFinite(confidence) || confidence < 0.0 || confidence > 1.0) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_OBSERVATION,
      error: `Observation confidence must be a number between 0.0 and 1.0, got: ${input.confidence}`,
    }
  }

  // 4. 时间戳校验
  let timestamp = input.timestamp
  if (typeof timestamp === 'number') {
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_OBSERVATION,
        error: `Invalid numeric timestamp: ${timestamp}`,
      }
    }
    timestamp = new Date(timestamp).toISOString()
  } else if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp)
    if (Number.isNaN(parsed)) {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_OBSERVATION,
        error: `Invalid ISO timestamp: "${timestamp}"`,
      }
    }
    timestamp = new Date(parsed).toISOString()
  } else if (!timestamp) {
    timestamp = new Date().toISOString()
  } else {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_OBSERVATION,
      error: 'Timestamp must be an ISO string or epoch milliseconds',
    }
  }

  // 5. 安全防御：禁止外部直接写 Mood 字段
  const prohibitedFields = ['valence', 'arousal', 'energy', 'moodDelta', 'state', 'delta']
  for (const field of prohibitedFields) {
    if (field in input) {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_OBSERVATION,
        error: `Security violation: direct mood mutation via "${field}" is forbidden in sensory observations`,
      }
    }
  }

  // 6. 证据载荷净化
  let evidence = input.evidence
  if (evidence !== undefined && evidence !== null) {
    if (typeof evidence !== 'object' && typeof evidence !== 'string' && typeof evidence !== 'number' && typeof evidence !== 'boolean') {
      return {
        valid: false,
        code: ERROR_CODES.INVALID_OBSERVATION,
        error: 'Observation evidence must be a serializable object or primitive',
      }
    }
  } else {
    evidence = {}
  }

  return {
    valid: true,
    data: {
      type,
      source,
      timestamp,
      confidence: Math.round(confidence * 1000) / 1000,
      evidence,
      summary: typeof input.summary === 'string' ? input.summary.slice(0, 300) : '',
    },
  }
}

/**
 * 校验活动适宜性评估请求 (heart.evaluateActivity)
 */
export function validateActivityIntent(input) {
  if (!input) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_INTENT,
      error: 'Activity intent input must not be empty',
    }
  }

  let intent = ''
  let category = ''
  let estimatedDurationMinutes = 15

  if (typeof input === 'string') {
    intent = input.trim()
  } else if (typeof input === 'object') {
    intent = typeof input.intent === 'string' ? input.intent.trim() : ''
    category = typeof input.category === 'string' ? input.category.trim() : ''
    if (typeof input.estimatedDurationMinutes === 'number' && Number.isFinite(input.estimatedDurationMinutes)) {
      estimatedDurationMinutes = Math.max(1, Math.min(300, Math.floor(input.estimatedDurationMinutes)))
    }
  } else {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_INTENT,
      error: 'Activity intent must be a string or object',
    }
  }

  if (!intent) {
    return {
      valid: false,
      code: ERROR_CODES.INVALID_INTENT,
      error: 'Missing required intent name',
    }
  }

  return {
    valid: true,
    data: {
      intent,
      category,
      estimatedDurationMinutes,
    },
  }
}

/**
 * 验证快照格式完整性
 */
export function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false
  if (snapshot.protocolVersion !== HEART_PROTOCOL_VERSION) return false
  if (!snapshot.timestamp || !snapshot.mood || typeof snapshot.mood !== 'object') return false
  if (typeof snapshot.mood.state !== 'string') return false
  if (typeof snapshot.mood.valence !== 'number' || typeof snapshot.mood.arousal !== 'number' || typeof snapshot.mood.energy !== 'number') return false
  return true
}
