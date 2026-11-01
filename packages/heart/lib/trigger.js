// 触发层：纯逻辑（事件判定、冷却、安静时段、目标会话选择与开口触发）。
// 零 DSH 依赖。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dateOf, ensureLayout, inQuietHours, readSpeak, resolveRoot } from './store.js'
import { findActiveAgent } from './target.js'

export const TRIGGER_DEFAULT = {
  lastTriggerAt: null,
  lastEvent: null,
  cooldownMinutes: 360,
}

const pad = (n) => String(n).padStart(2, '0')

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
export function shouldTriggerReturned({ prev, next, triggerState, config = {}, speakState = {}, now = new Date(), isStartup = false }) {
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

  const quietFrom = speakState?.quietFrom || config.quietFrom || '23:00'
  const quietTo = speakState?.quietTo || config.quietTo || '08:00'
  if (inQuietHours(now, quietFrom, quietTo)) {
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

  return { ok: true, awayDuration }
}

/**
 * 空闲自主回合：他有一阵没说话时，允许模型自己起一轮。
 * 下一次什么时候醒由模型用 heart_next(minutes) 决定；没决定就按兜底间隔。
 * 条件：距上次消息 >= idleTurnMinMinutes；到了 nextIdleAt（或首次阈值）；
 *       不在安静时段；当日次数未超上限。
 */
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

  const dueAt = triggerState.nextIdleAt ? new Date(triggerState.nextIdleAt) : null
  if (dueAt && !Number.isNaN(dueAt.getTime())) {
    if (now.getTime() < dueAt.getTime()) {
      return {
        ok: false,
        reason: 'not-due',
        nextIdleAt: dueAt.toISOString(),
        diffMin: Math.ceil((dueAt.getTime() - now.getTime()) / 60000),
      }
    }
  } else {
    const initial = Number(config.idleTurnMinutes) || 30
    if (since < initial) {
      return { ok: false, reason: 'too-soon', since, initial }
    }
  }

  const quietFrom = speakState?.quietFrom || config.quietFrom || '23:00'
  const quietTo = speakState?.quietTo || config.quietTo || '08:00'
  if (inQuietHours(now, quietFrom, quietTo)) {
    return { ok: false, reason: 'quiet-hours' }
  }

  const cap = Number(config.idleTurnDailyCap) || 6
  const today = dateOf(now)
  const used = triggerState.idleDate === today ? Number(triggerState.idleCount) || 0 : 0
  if (used >= cap) {
    return { ok: false, reason: 'daily-cap', used, cap }
  }

  const { counts } = idleCategoryState(triggerState, now)
  const remaining = idleCategoryRemaining(config, counts)
  if (remaining.length && remaining.every((c) => c.remaining <= 0)) {
    return { ok: false, reason: 'category-cap', remaining }
  }

  return { ok: true, since, dueAt: dueAt ? dueAt.toISOString() : null, minMinutes, cap, remaining }
}

/** 今天各类别已用次数；跨日自动清零。 */
export function idleCategoryState(triggerState = {}, now = new Date()) {
  const today = dateOf(now)
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
  const { today, counts } = idleCategoryState(state, now)
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
export function formatReturnedPrompt(awayDuration, now = new Date()) {
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  return `【感知】他离开了 ${awayDuration} 分钟，刚回来（现在 ${timeStr}）。手上有没做完的事就接着说；没有就别硬找话。`
}

/** 空闲自主回合的提示词：给方向，不逼它说话；下一次由它自己排。 */
export function formatIdlePrompt(idleMinutes, now = new Date(), config = {}, remaining = []) {
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const min = Number(config.idleTurnMinMinutes) || 6
  const max = Number(config.idleTurnMaxMinutes) || 180
  const fallback = Number(config.idleTurnDefaultMinutes) || 30
  const left = remaining
    .filter((c) => c.remaining > 0)
    .map((c) => `${c.label}(${c.id}) ${c.used}/${c.dailyCap}`)
    .join('、')
  const leftLine = left ? `今天还能做：${left}。` : ''
  return `【感知】他有一阵没说话了（${idleMinutes} 分钟，现在 ${timeStr}），你一个人。想干点什么就干，不用等指令；${leftLine}做完用 heart_next(下次 ${min}–${max} 分钟, 类别id) 记一笔并排下一次，这个类别用完了就换一个或休息；不排就 ${fallback} 分钟后再看。做完记一句就行，不用汇报过程。`
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

  // 当空闲条件成立时，发布 heart/idle 契约事件
  if (idle && idle.ok) {
    const idlePayload = {
      sinceMsgMin: idle.since,
      availableCategories: (idle.remaining || []).map((c) => c.id),
      quotaRemaining: (idle.cap || 6) - (triggerState.idleCount || 0),
    }
    if (service && typeof service.notifyIdle === 'function') {
      service.notifyIdle(idlePayload)
    } else if (ctx && typeof ctx.parallel === 'function') {
      ctx.parallel('heart/idle', { ...idlePayload, timestamp: now.toISOString() }).catch(() => {})
    } else if (ctx && typeof ctx.emit === 'function') {
      ctx.emit('heart/idle', { ...idlePayload, timestamp: now.toISOString() })
    }
  }

  const kind = returned.ok ? 'returned' : idle.ok ? 'idle' : null
  if (!kind) {
    return false
  }

  const agent = findActiveAgent(ctx && ctx.agents, config.sessionsRoot)
  if (!agent || typeof agent.followup !== 'function') {
    trace(dir, 'trigger:skip no-agent')
    return false
  }

  const prompt =
    kind === 'returned'
      ? formatReturnedPrompt(returned.awayDuration, now)
      : formatIdlePrompt(idle.since, now, config, idle.remaining)

  try {
    agent.followup(createSelfMessage(prompt))
    if (kind === 'returned') {
      writeTrigger(dir, {
        lastTriggerAt: now.toISOString(),
        lastEvent: 'returned',
        cooldownMinutes: Number(config.triggerCooldownMinutes) || 360,
      })
      trace(dir, 'trigger:returned to=' + agent.id + ' away=' + returned.awayDuration + 'm')
    } else {
      const today = dateOf(now)
      const count =
        (triggerState.idleDate === today ? Number(triggerState.idleCount) || 0 : 0) + 1
      const fallbackMinutes = Number(config.idleTurnDefaultMinutes) || 30
      writeTrigger(dir, {
        lastEvent: 'idle',
        lastIdleTurnAt: now.toISOString(),
        idleDate: today,
        idleCount: count,
        // 兜底；模型如果在回合里调 heart_next，会把它覆盖成自己的判断
        nextIdleAt: new Date(now.getTime() + fallbackMinutes * 60000).toISOString(),
      })
      trace(
        dir,
        'trigger:idle to=' + agent.id + ' idle=' + idle.since + 'm n=' + count + '/' + idle.cap
      )
    }
    return true
  } catch (error) {
    trace(dir, 'trigger:error ' + String((error && error.message) || error))
    return false
  }
}
