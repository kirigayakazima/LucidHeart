// 触发层：纯逻辑（事件判定、冷却、安静时段、目标会话选择与开口触发）。
// 零 DSH 依赖。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { canSpeak, consumeSpeak, dateOf, timeOf, ensureLayout, inQuietHours, readSpeak, resolveRoot, getZonedParts } from './store.js'
import { findActiveAgent } from './target.js'
import { formatCommitmentCarePrompt } from './prompt.js'

export const TRIGGER_DEFAULT = {
  lastTriggerAt: null,
  lastEvent: null,
  cooldownMinutes: 360,
}

const HOUR = 60 * 60 * 1000

function autonomousCooldownAt(state) {
  const last = Math.max(Date.parse(state.lastIdleTurnAt) || 0, Date.parse(state.lastTriggerAt) || 0)
  return last ? last + HOUR : 0
}

function trace(root, msg) {
  try {
    fs.appendFileSync(path.join(resolveRoot(root), 'plugin-trace.log'), new Date().toISOString() + ' ' + msg + '\n')
  } catch {}
}

export function readTrigger(root) {
  const file = path.join(resolveRoot(root), 'trigger.json')
  try {
    return { ...TRIGGER_DEFAULT, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...TRIGGER_DEFAULT }
  }
}

export function writeTrigger(root, patch) {
  const dir = ensureLayout(root)
  const current = readTrigger(dir)
  const next = { ...current, ...patch }
  fs.writeFileSync(path.join(dir, 'trigger.json'), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

/**
 * 判定 returned 事件：
 * 条件：
 *   1. previous 是 away 或 asleep；
 *   2. current 是 present；
 *   3. 离开时长 >= awayMinutes（默认 30），以 awaySince 计算；
 *   4. 不在安静时段；
 *   5. 距上次触发 >= triggerCooldownMinutes（默认 360）；
 *   6. 排除首次启动或断档重启（prev.at 距离当前超过 3 * pulseSeconds）。
 */
export function shouldTriggerReturned({ prev, next, triggerState = {}, config = {}, speakState = {}, now = new Date(), isStartup = false }) {
  if (config.triggerOnReturn === false) {
    return { ok: false, reason: 'disabled' }
  }

  // 进程刚启动时 previous 未知，不触发
  if (isStartup || config.isStartup || !prev || !prev.presence) {
    return { ok: false, reason: 'startup' }
  }

  // 防重启误触发：如果 prev.at 距当前时间超过 3 * pulseSeconds，说明进程曾中断，视为重启 startup
  const pulseSec = Number(config.pulseSeconds) || 60
  const maxStaleMs = Math.max(90, pulseSec * 3) * 1000
  if (prev.at && now.getTime() - new Date(prev.at).getTime() > maxStaleMs) {
    return { ok: false, reason: 'startup' }
  }

  if (next?.presence !== 'present') {
    return { ok: false, reason: 'not-present' }
  }

  if (prev.presence !== 'away' && prev.presence !== 'asleep') {
    return { ok: false, reason: 'not-from-away' }
  }

  const tz = 'Asia/Shanghai'
  const quietFrom = speakState?.quietFrom || config.quietFrom || '23:00'
  const quietTo = speakState?.quietTo || config.quietTo || '08:00'
  if (inQuietHours(now, quietFrom, quietTo, tz)) {
    return { ok: false, reason: 'quiet-hours' }
  }

  // 计算离开时长：以 awaySince 为真实起点，避免以 sinceMsgMin / prev.at 猜测造成错判
  const awayMinutes = Number(config.awayMinutes) || 30
  const awaySince = prev.awaySince || next.awaySince
  let awayDuration = 0
  if (awaySince) {
    awayDuration = Math.max(0, Math.floor((now.getTime() - new Date(awaySince).getTime()) / 60000))
  } else if (prev.at) {
    awayDuration = Math.max(0, Math.floor((now.getTime() - new Date(prev.at).getTime()) / 60000))
  } else {
    awayDuration = awayMinutes
  }

  if (awayDuration < awayMinutes) {
    return { ok: false, reason: 'duration-too-short', awayDuration }
  }

  const cooldown = Number(config.triggerCooldownMinutes) || triggerState.cooldownMinutes || 360
  if (triggerState.lastTriggerAt) {
    const elapsedMinutes = (now.getTime() - new Date(triggerState.lastTriggerAt).getTime()) / 60000
    if (elapsedMinutes < cooldown) {
      return { ok: false, reason: 'cooldown', diffMin: Math.floor(elapsedMinutes), cooldown }
    }
  }
  if (now.getTime() < autonomousCooldownAt(triggerState)) {
    return { ok: false, reason: 'cooldown', cooldown: 60 }
  }

  return { ok: true, awayDuration }
}

const IDLE_BUCKET_END_HOURS = [12, 18, 23]

function idleBucket(now, timeZone) {
  const hour = getZonedParts(now, timeZone).hour
  return hour >= 8 ? IDLE_BUCKET_END_HOURS.findIndex((end) => hour < end) : -1
}

function idleRhythmAt(at, bucket, available, timeZone) {
  const { hour, minute, second } = getZonedParts(at, timeZone)
  const midnight = at.getTime() - (hour * 3600 + minute * 60 + second) * 1000 - at.getUTCMilliseconds()
  const end = midnight + IDLE_BUCKET_END_HOURS[bucket] * HOUR
  if (available > 1) {
    // 当前这一拍也占一个位置，用开拍时的余额把余下机会分散在桶内。
    const interval = Math.max(HOUR, (end - at) / available)
    return Math.min(at.getTime() + interval, end)
  }
  return bucket === 2 ? midnight + 32 * HOUR : end
}

/** 空闲自主回合：消息静默达到阈值，且当前作息时段与排程均允许时触发。 */
export function shouldTriggerIdle({ next, triggerState = {}, config = {}, speakState = {}, now = new Date() }) {
  if (config.idleTurns === false) {
    return { ok: false, reason: 'disabled' }
  }
  const minMinutes = Number(config.idleTurnMinMinutes) || 6
  // 以“多久没消息”为准，不看鼠标/键盘空闲：
  // 他可能在电脑前干活、手机熄屏；只要没对话，就该允许她自己待一会儿。
  const since = Number(next?.sinceMsgMin)
  if (!Number.isFinite(since) || since < minMinutes) {
    return {
      ok: false,
      reason: 'min-idle',
      since: Number.isFinite(since) ? since : null,
      minMinutes,
    }
  }

  const tz = 'Asia/Shanghai'
  const quietFrom = speakState?.quietFrom || config.quietFrom || '23:00'
  const quietTo = speakState?.quietTo || config.quietTo || '08:00'
  const bucket = idleBucket(now, tz)
  if (bucket === -1 || inQuietHours(now, quietFrom, quietTo, tz)) {
    return { ok: false, reason: 'quiet-hours' }
  }

  const cap = Number(config.idleTurnDailyCap) || 6
  const today = dateOf(now, tz)
  const used = triggerState.idleDate === today ? Number(triggerState.idleCount) || 0 : 0
  if (used >= cap) {
    return { ok: false, reason: 'daily-cap', used, cap }
  }

  // 每到一桶释放两次额度，减去当日已用次数即包含前桶的结转。
  const bucketRemaining = Math.min(cap, (bucket + 1) * 2) - used
  if (bucketRemaining <= 0) {
    return { ok: false, reason: 'bucket-cap' }
  }

  const lastIdle = new Date(triggerState.lastIdleTurnAt)
  const rhythmAt = Number.isFinite(lastIdle.getTime()) && triggerState.idleDate === today &&
    dateOf(lastIdle, tz) === today && idleBucket(lastIdle, tz) === bucket
    ? idleRhythmAt(lastIdle, bucket, bucketRemaining + 1, tz)
    : 0
  const due = Math.max(Date.parse(triggerState.nextIdleAt) || 0, rhythmAt, autonomousCooldownAt(triggerState))
  const dueAt = due ? new Date(due).toISOString() : null
  if (now.getTime() < due) {
    return { ok: false, reason: 'not-due', nextIdleAt: dueAt, diffMin: Math.ceil((due - now.getTime()) / 60000) }
  }
  const initial = Number(config.idleTurnMinutes) || 30
  if (!dueAt && since < initial) {
    return { ok: false, reason: 'too-soon', since, initial }
  }

  const { counts } = idleCategoryState(triggerState, now, config)
  const remaining = idleCategoryRemaining(config, counts)
  if (remaining.length && remaining.every((c) => c.remaining <= 0)) {
    return { ok: false, reason: 'category-cap', remaining }
  }

  return { ok: true, since, dueAt, minMinutes, cap, used, remaining, nextRhythmAt: idleRhythmAt(now, bucket, bucketRemaining, tz) }
}

/** 今天各类别已用次数；跨日自动清零。 */
export function idleCategoryState(triggerState = {}, now = new Date(), config = {}) {
  const tz = 'Asia/Shanghai'
  const today = dateOf(now, tz)
  const counts =
    triggerState.idleCategoryDate === today ? { ...(triggerState.idleCategoryCounts || {}) } : {}
  return { today, counts }
}

/** 类别配置 + 今日用量 → 每类剩余额度。 */
export function idleCategoryRemaining(config = {}, counts = {}) {
  const cats = Array.isArray(config?.idleCategories) ? config.idleCategories : []
  return cats
    .filter((c) => c && c.id)
    .map((c) => {
      const used = Number(counts[c.id]) || 0
      const dailyCap = Number(c.dailyCap) || 0
      return {
        id: String(c.id),
        label: String(c.label || c.id),
        dailyCap,
        used,
        remaining: Math.max(0, dailyCap - used),
      }
    })
}

/** 记一次类别；额度用完返回 category-cap，不写。 */
export function recordIdleCategory(root, id, config = {}, now = new Date()) {
  const cats = Array.isArray(config?.idleCategories) ? config.idleCategories : []
  const cat = cats.find((c) => c && c.id === id)
  if (!cat) {
    return { ok: false, reason: 'unknown-category', categories: cats.map((c) => c.id) }
  }
  const state = readTrigger(root)
  const { today, counts } = idleCategoryState(state, now, config)
  const used = Number(counts[id]) || 0
  const dailyCap = Number(cat.dailyCap) || 0
  if (used >= dailyCap) {
    return { ok: false, reason: 'category-cap', id, used, dailyCap, label: cat.label }
  }
  counts[id] = used + 1
  writeTrigger(root, { idleCategoryDate: today, idleCategoryCounts: counts })
  return { ok: true, id, label: cat.label, used: used + 1, dailyCap }
}

/** 模型决定下一次空闲回合的间隔；写入 trigger.json，下一次 tick 生效。 */
export function scheduleNextIdle(root, minutes, config = {}, now = new Date()) {
  const min = Math.max(1, Number(config.idleTurnMinMinutes) || 6)
  const max = Math.max(min, Number(config.idleTurnMaxMinutes) || 180)
  const wanted = Math.round(Number(minutes))
  const m = Number.isFinite(wanted) ? Math.min(max, Math.max(min, wanted)) : min
  const at = new Date(now.getTime() + m * 60000).toISOString()
  writeTrigger(root, { nextIdleAt: at })
  trace(resolveRoot(root), 'idle:next ' + m + 'm at=' + at)
  return { minutes: m, nextIdleAt: at }
}

/**
 * 组装给模型的消息模板（供模型感知后自行决定开口内容）。
 */
export function formatReturnedPrompt(awayDuration, now = new Date(), timeZone = 'Asia/Shanghai') {
  const timeStr = timeOf(now, timeZone)
  return `【感知】他离开了 ${awayDuration} 分钟，刚回来（现在 ${timeStr}）。手上有没做完的事就接着说；没有就别硬找话。`
}

/** 空闲自主回合的提示词：给方向，不逼它说话；下一次由它自己排。 */
export function formatIdlePrompt(idleMinutes, now = new Date(), config = {}, remaining = []) {
  const timeStr = timeOf(now, 'Asia/Shanghai')
  const min = Number(config.idleTurnMinMinutes) || 6
  const max = Number(config.idleTurnMaxMinutes) || 180
  const left = remaining
    .filter((c) => c.remaining > 0)
    .map((c) => `${c.label}(${c.id}) ${c.used}/${c.dailyCap}`)
    .join('、')
  const leftLine = left ? `今天还能做：${left}。` : ''
  return `【感知】他有一阵没说话了（${idleMinutes} 分钟，现在 ${timeStr}），你一个人。想干点什么就干，不用等指令；${leftLine}做完用 heart_next(下次 ${min}–${max} 分钟, 类别id) 记一笔并排下一次，实际唤醒还要等节律允许。这个类别用完了就换一个或休息。做完记一句就行，不用汇报过程。`
}

/**
 * 构造合法的 UserMessage 对象。
 * agent.followup 必须收完整对象，不能传裸字符串。
 */
export function createSelfMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'schedule' },
  }
}

/**
 * 节律唤醒时的触发调度：
 * 只有条件满足时才开口；找不到目标会话或并列时不开口。
 */
export async function maybeTrigger(ctx, root, prev, next, config = {}, now = new Date(), service = null) {
  const dir = resolveRoot(root)
  const speakState = readSpeak(dir)
  const triggerState = readTrigger(dir)

  const returned = shouldTriggerReturned({
    prev,
    next,
    triggerState,
    config,
    speakState,
    now,
  })
  const idle =
    returned.ok || returned.reason === 'cooldown' || returned.reason === 'startup'
      ? { ok: false, reason: 'returned-priority' }
      : shouldTriggerIdle({ next, triggerState, config, speakState, now })

  const kind = returned.ok ? 'returned' : idle.ok ? 'idle' : null
  if (!kind) return false
  const timeZone = 'Asia/Shanghai'
  const today = dateOf(now, timeZone)
  const used = triggerState.idleDate === today ? Number(triggerState.idleCount) || 0 : 0
  const cap = Number(config.idleTurnDailyCap) || 6
  if (used >= cap) return false

  const care = service && ctx.get?.('memory')?.commitments?.getActiveCommitmentCare?.(now, 'Asia/Shanghai')
  if (care && (used >= 6 || next?.presence === 'asleep' ||
      inQuietHours(now, '23:00', '08:00', 'Asia/Shanghai') || !canSpeak(dir, now).ok ||
      !service.evaluateActivity({ intent: 'companion_care', category: 'chat' }).suitable)) return false

  // 当空闲条件成立时，发布 heart/idle 契约事件
  if (idle.ok && !care) {
    const idlePayload = {
      sinceMsgMin: idle.since,
      availableCategories: (idle.remaining || []).map((c) => c.id),
      quotaRemaining: idle.cap - idle.used,
    }
    if (service && typeof service.notifyIdle === 'function') {
      service.notifyIdle(idlePayload)
    } else if (ctx && typeof ctx.parallel === 'function') {
      ctx.parallel('heart/idle', { ...idlePayload, timestamp: now.toISOString() }).catch(() => {})
    } else if (ctx && typeof ctx.emit === 'function') {
      ctx.emit('heart/idle', { ...idlePayload, timestamp: now.toISOString() })
    }
  }

  const agent = findActiveAgent(ctx && ctx.agents, config.sessionsRoot)
  if (!agent || typeof agent.followup !== 'function') {
    trace(dir, 'trigger:skip no-agent')
    return false
  }
  if (care && agent.status === 'running') return false

  const prompt = care
    ? formatCommitmentCarePrompt(kind, now)
    : kind === 'returned'
      ? formatReturnedPrompt(returned.awayDuration, now, timeZone)
      : formatIdlePrompt(idle.since, now, config, idle.remaining)

  const message = createSelfMessage(prompt)
  try {
    if (care) service.commitmentCareTurn = { agentId: agent.id, messageId: message.id, commitmentId: care.id }
    agent.followup(message)
    const accounting = { idleDate: today, idleCount: used + 1, lastEvent: kind }
    if (care && config.idleCategories?.some(category => category.id === 'chat')) {
      const { counts } = idleCategoryState(triggerState, now, config)
      counts.chat = (Number(counts.chat) || 0) + 1
      Object.assign(accounting, { idleCategoryDate: today, idleCategoryCounts: counts })
    }
    if (kind === 'returned') {
      writeTrigger(dir, {
        ...accounting,
        lastTriggerAt: now.toISOString(),
        cooldownMinutes: Number(config.triggerCooldownMinutes) || 360,
      })
      trace(dir, 'trigger:returned to=' + agent.id + ' away=' + returned.awayDuration + 'm')
    } else {
      const fallbackMinutes = Number(config.idleTurnDefaultMinutes) || 30
      writeTrigger(dir, {
        ...accounting,
        lastIdleTurnAt: now.toISOString(),
        nextIdleAt: new Date(Math.max(now.getTime() + Math.max(HOUR, fallbackMinutes * 60000), idle.nextRhythmAt)).toISOString(),
      })
      trace(
        dir,
        'trigger:idle to=' + agent.id + ' idle=' + idle.since + 'm n=' + accounting.idleCount + '/' + idle.cap
      )
    }
    if (care) consumeSpeak(dir, now)
    return true
  } catch (error) {
    if (care) service.commitmentCareTurn = null
    trace(dir, 'trigger:error ' + String((error && error.message) || error))
    return false
  }
}
