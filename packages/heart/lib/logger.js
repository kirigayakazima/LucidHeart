// dsh-heart 的统一轻量分区日志系统。
//
// 核心原则（模块 C 规范）：
// 1. 按模块分区独立落盘：core / mood / dream / memory / store；
// 2. 结构化 JSONL 单行记录，包含时间戳、级别、模块、操作、结果、ID 及脱敏摘要；
// 3. 有界日志管理：超过最大字节限制（默认 512KB）自动轮转备份为 .old，杜绝磁盘无限制膨胀；
// 4. 绝对高可用与零侵入：写日志异常绝不阻断业务逻辑，严禁抛出异常干扰主调用；
// 5. 严格隐私保护：过滤密钥、token、密码，长文本摘要截断，不记录用户完整私人对话。

import fs from 'node:fs'
import path from 'node:path'
import { resolveRoot } from './store.js'

export const LOGS_DIR = 'logs'
export const MAX_LOG_SIZE_BYTES = 512 * 1024 // 512 KB

export const LOG_MODULES = Object.freeze(['core', 'mood', 'dream', 'memory', 'store'])
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error'])

const SENSITIVE_KEY_REGEX = /(?:password|secret|token|key|auth|credential|api_key|bearer)/i

/**
 * 脱敏与摘要数据清洗函数：
 * 1. 递归清洗对象中的敏感键；
 * 2. 截断超长字符串（最多保留 300 字符），防止日志膨胀；
 * 3. 剥离不可序列化对象。
 */
export function sanitizeLogData(val, depth = 0) {
  if (val === null || val === undefined) return val
  if (depth > 4) return '[DeepObject]'

  if (typeof val === 'string') {
    if (val.length > 300) {
      return val.slice(0, 300) + '...[截断]'
    }
    return val
  }

  if (typeof val === 'number' || typeof val === 'boolean') {
    return val
  }

  if (Array.isArray(val)) {
    return val.slice(0, 20).map((item) => sanitizeLogData(item, depth + 1))
  }

  if (typeof val === 'object') {
    const clean = {}
    for (const [k, v] of Object.entries(val)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        clean[k] = '[REDACTED]'
      } else {
        clean[k] = sanitizeLogData(v, depth + 1)
      }
    }
    return clean
  }

  return String(val)
}

/**
 * 确保日志目录与文件的有界轮转
 */
function rotateIfOversized(logFilePath, maxBytes = MAX_LOG_SIZE_BYTES) {
  try {
    if (!fs.existsSync(logFilePath)) return
    const stat = fs.statSync(logFilePath)
    if (stat.size >= maxBytes) {
      const oldPath = `${logFilePath}.old`
      try {
        if (fs.existsSync(oldPath)) {
          fs.unlinkSync(oldPath)
        }
      } catch {}
      fs.renameSync(logFilePath, oldPath)
    }
  } catch {
    // 轮转失败静默忽略
  }
}

/**
 * 记录单条结构化分区日志（JSONL 格式）。
 *
 * 契约规范：
 * - root: 数据存储根目录；
 * - module: 'core' | 'mood' | 'dream' | 'memory' | 'store'；
 * - level: 'debug' | 'info' | 'warn' | 'error'；
 * - action: 具体操作标识，如 'update_mood' / 'promote_memory'；
 * - data: 附带元数据（可选 id, result, detail, error 等）。
 */
export function logEvent(root, module, level, action, data = {}, now = new Date()) {
  try {
    const mod = String(module || 'core').trim().toLowerCase()
    const targetModule = LOG_MODULES.includes(mod) ? mod : 'core'

    const lvl = String(level || 'info').trim().toLowerCase()
    const targetLevel = LOG_LEVELS.includes(lvl) ? lvl : 'info'

    const dir = resolveRoot(root)
    const logsDir = path.join(dir, LOGS_DIR)

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true })
    }

    const logFile = path.join(logsDir, `${targetModule}.log`)
    rotateIfOversized(logFile)

    const nowIso = (now instanceof Date && !isNaN(now.getTime()) ? now : new Date()).toISOString()

    const entry = {
      ts: nowIso,
      level: targetLevel,
      module: targetModule,
      action: String(action || 'event').trim(),
      result: data && data.result ? String(data.result) : 'ok',
    }

    if (data && data.id) {
      entry.id = String(data.id).slice(0, 64)
    }

    if (data && data.detail !== undefined) {
      entry.detail = sanitizeLogData(data.detail)
    }

    if (data && data.error) {
      entry.error = typeof data.error === 'string' ? data.error : String(data.error.message || data.error)
    }

    const line = JSON.stringify(entry) + '\n'
    fs.appendFileSync(logFile, line, 'utf8')
    return { ok: true, file: logFile, entry }
  } catch {
    // 极限制约：写日志异常绝不阻断业务逻辑
    return { ok: false }
  }
}

/**
 * 读取指定模块的近期日志条目（支持诊断与测试验收）
 */
export function readModuleLogs(root, module, { limit = 100 } = {}) {
  try {
    const mod = String(module || 'core').trim().toLowerCase()
    const targetModule = LOG_MODULES.includes(mod) ? mod : 'core'

    const dir = resolveRoot(root)
    const logFile = path.join(dir, LOGS_DIR, `${targetModule}.log`)

    if (!fs.existsSync(logFile)) {
      return []
    }

    const content = fs.readFileSync(logFile, 'utf8')
    const lines = content.split('\n').filter((l) => l.trim().length > 0)
    const parsed = []

    for (const l of lines) {
      try {
        parsed.push(JSON.parse(l))
      } catch {}
    }

    return limit > 0 ? parsed.slice(-limit) : parsed
  } catch {
    return []
  }
}

/**
 * 便捷日志调用器
 */
export const log = Object.freeze({
  core: (root, level, action, data, now) => logEvent(root, 'core', level, action, data, now),
  mood: (root, level, action, data, now) => logEvent(root, 'mood', level, action, data, now),
  dream: (root, level, action, data, now) => logEvent(root, 'dream', level, action, data, now),
  memory: (root, level, action, data, now) => logEvent(root, 'memory', level, action, data, now),
  store: (root, level, action, data, now) => logEvent(root, 'store', level, action, data, now),
})
