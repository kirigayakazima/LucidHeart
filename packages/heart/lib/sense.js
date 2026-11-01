// 感知层：纯逻辑（presence 计算、去抖、sense 日志格式化与文件读写）。
// 零 DSH 依赖。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  dateOf,
  ensureLayout,
  inQuietHours,
  readProfile,
  detectBodyProfile,
  resolveRoot,
} from './store.js'
import { findSessionMtimes } from './target.js'
import { sampleWin } from './sense-win.js'
import { samplePhone } from './sense-phone.js'

export const SENSE_LOG = 'sense.log'
export const SENSE_LOG_MAX = 500

const pad = (n) => String(n).padStart(2, '0')

/** 生成带本地时区偏移的 ISO 字符串（如 2026-10-21T19:20:00+08:00）。 */
export function toLocalISOString(date = new Date()) {
  const tzOffset = -date.getTimezoneOffset()
  const sign = tzOffset >= 0 ? '+' : '-'
  const tzHours = pad(Math.floor(Math.abs(tzOffset) / 60))
  const tzMins = pad(Math.abs(tzOffset) % 60)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${tzHours}:${tzMins}`
}

/** 计算当前距离最新会话文件修改的分钟数。 */
export function getSinceMsgMin(sessionsRoot, now = new Date()) {
  try {
    const root = sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
    const mtimes = findSessionMtimes(root)
    let latestMtime = 0
    for (const mt of mtimes.values()) {
      if (mt > latestMtime) latestMtime = mt
    }
    if (latestMtime > 0) {
      return Math.max(0, Math.floor((now.getTime() - latestMtime) / 60000))
    }
  } catch {}
  return null
}

/**
 * 计算单次采样的原始 presence 状态（未去抖）。
 * 规则：
 *   asleep  = 安静时段（23:00–08:00）
 *   present = idleMs <= 120_000 或 sinceMsgMin <= 5
 *   nearby  = sinceMsgMin <= awayMinutes（默认 30）
 *   away    = 其他
 */
export function computeRawPresence(sample, options = {}) {
  const now = options.now ? new Date(options.now) : new Date(sample.at || Date.now())
  const quietFrom = options.speakState?.quietFrom || options.quietFrom || '23:00'
  const quietTo = options.speakState?.quietTo || options.quietTo || '08:00'
  const awayMinutes = Number(options.awayMinutes) || 30

  if (inQuietHours(now, quietFrom, quietTo)) {
    return 'asleep'
  }

  const idleMs = sample.idleMs
  const sinceMsgMin = sample.sinceMsgMin

  const isIdleActive = idleMs !== null && idleMs !== undefined && idleMs <= 120_000
  const isMsgActive = sinceMsgMin !== null && sinceMsgMin !== undefined && sinceMsgMin <= 5

  if (isIdleActive || isMsgActive) {
    return 'present'
  }

  if (sinceMsgMin !== null && sinceMsgMin !== undefined && sinceMsgMin <= awayMinutes) {
    return 'nearby'
  }

  return 'away'
}

/**
 * 应用去抖规则计算下一状态：
 * 连续两次采样同一状态才切换，避免一次失败误判离开；
 * 采样错误不判定为 away；
 * 进程刚启动时无 previous，只记录当前原始状态；
 * 维护离开起点 awaySince（进入 away/asleep 时记录，进入 present/nearby 时清空）。
 */
export function applyPresence(prev, sample, config = {}, options = {}) {
  // 重启后的第一拍不继承上一次进程的 away 状态：否则隔天重启时，
  // 第一拍只写不触发、第二拍把旧的 awaySince 当成本次离开，长度算成几千分钟。
  if (options.isStartup) prev = null
  const quietFrom = options.speakState?.quietFrom || options.quietFrom || config.quietFrom || '23:00'
  const quietTo = options.speakState?.quietTo || options.quietTo || config.quietTo || '08:00'
  const awayMinutes = Number(config.awayMinutes) || 30
  const now = options.now ? new Date(options.now) : new Date(sample.at || Date.now())

  // PowerShell / Bridge 采样失败且没有有效 idle 时，不因为单次失败误判为离开
  if (sample.error && sample.idleMs === null) {
    const presence = prev?.presence || 'present'
    return {
      at: sample.at,
      presence,
      rawPresence: prev?.rawPresence || presence,
      awaySince: prev?.awaySince || null,
      idleMs: sample.idleMs,
      fg: sample.fg,
      sinceMsgMin: sample.sinceMsgMin,
      screen: sample.screen,
      net: sample.net,
      battery: sample.battery,
      error: sample.error,
    }
  }

  const raw = computeRawPresence(sample, { quietFrom, quietTo, awayMinutes, now })

  let nextPresence = raw
  if (!prev || !prev.presence) {
    // 首次启动，记录原始状态
    nextPresence = raw
  } else {
    const prevConfirmed = prev.presence
    if (raw === prevConfirmed) {
      nextPresence = raw
    } else {
      // 状态有变化：需连续两次采样为 raw 才切换
      if (prev.rawPresence === raw) {
        nextPresence = raw
      } else {
        nextPresence = prevConfirmed
      }
    }
  }

  // 记录离开起点 awaySince：进入 away/asleep 时若为空就记下，进入 present/nearby 时清空
  let awaySince = null
  const isAwayLike = nextPresence === 'away' || nextPresence === 'asleep'
  if (isAwayLike) {
    if (prev && (prev.presence === 'away' || prev.presence === 'asleep') && prev.awaySince) {
      awaySince = prev.awaySince
    } else {
      awaySince = sample.at || toLocalISOString(now)
    }
  } else {
    awaySince = null
  }

  return {
    at: sample.at,
    presence: nextPresence,
    rawPresence: raw,
    awaySince,
    idleMs: sample.idleMs,
    fg: sample.fg,
    sinceMsgMin: sample.sinceMsgMin,
    screen: sample.screen,
    net: sample.net,
    battery: sample.battery,
    error: sample.error || null,
  }
}

/**
 * 格式化 sense.log 单行。
 * 格式稳定，方便 grep：
 * 2026-10-21 19:20:00|presence=present|idle=41s|sinceMsg=0m|fg=DeepSeek Harness
 * 失败带 error=：
 * 2026-10-21 19:22:00|presence=present|idle=0s|sinceMsg=0m|error=powershell-timeout
 */
export function formatSenseLine(record) {
  const atDate = record.at ? new Date(record.at) : new Date()
  const timestamp = `${dateOf(atDate)} ${pad(atDate.getHours())}:${pad(atDate.getMinutes())}:${pad(atDate.getSeconds())}`
  const presence = record.presence || 'unknown'
  const idle = record.idleMs !== null && record.idleMs !== undefined ? `${Math.floor(record.idleMs / 1000)}s` : '-'
  const sinceMsg = record.sinceMsgMin !== null && record.sinceMsgMin !== undefined ? `${record.sinceMsgMin}m` : '-'

  let line = `${timestamp}|presence=${presence}|idle=${idle}|sinceMsg=${sinceMsg}`
  if (record.fg) {
    line += `|fg=${String(record.fg).replace(/[\r\n|]/g, ' ').trim()}`
  }
  if (record.screen) {
    line += `|screen=${record.screen}`
  }
  if (record.error) {
    line += `|error=${record.error}`
  }
  return line
}

/** 原子写 sense.json：临时文件 + rename。 */
export function writeSense(root, record) {
  const dir = ensureLayout(root)
  const target = path.join(dir, 'sense.json')
  const tmp = path.join(dir, `sense.json.tmp.${process.pid}.${Date.now()}`)
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, target)
  return record
}

/** 读取 sense.json。 */
export function readSense(root) {
  const file = path.join(resolveRoot(root), 'sense.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 追加写 sense.log（环形 500 行）。 */
export function appendSenseLog(root, record, config = {}) {
  const dir = ensureLayout(root)
  const file = path.join(dir, SENSE_LOG)
  const line = formatSenseLine(record)
  const maxLines = Number(config.senseLogMax) || SENSE_LOG_MAX

  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []
  lines.push(line)
  const kept = lines.slice(-maxLines)
  fs.writeFileSync(file, kept.join('\n') + '\n', 'utf8')
  return { file, line, count: kept.length }
}

/** 读取最近的 sense.log。 */
export function readSenseLog(root, { limit = 20 } = {}) {
  const file = path.join(resolveRoot(root), SENSE_LOG)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-limit)
}

/**
 * 执行一次采样：按当前设备形态（win / phone / linux）分发。
 */
export async function senseSample(root, options = {}) {
  const dir = resolveRoot(root)
  const profile = readProfile(dir)?.profile || detectBodyProfile({ dir })

  if (profile === 'phone') {
    return samplePhone(options)
  }
  if (profile === 'win' || process.platform === 'win32') {
    return sampleWin(options)
  }

  // 通用 Linux 或兜底
  const at = options.now ? new Date(options.now) : new Date()
  return {
    at: toLocalISOString(at),
    idleMs: null,
    fg: null,
    sinceMsgMin: null,
    screen: null,
    net: null,
    battery: null,
    error: null,
  }
}
