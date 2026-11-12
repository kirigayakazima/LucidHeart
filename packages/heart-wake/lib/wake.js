import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveWakeTarget, resolveWakeTurn } from './target.js'

const cooldownMs = 15_000
const hourMs = 3_600_000
const hourlyCap = 2
const dailyCap = 6
const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
})

const refusal = {
  invalid_text: '请提供下一轮要继续思考的内容。',
  quiet_hours: '深夜静音期休息中，不执行自唤醒',
  cancelled: '当前调用已取消，不执行自唤醒。',
  no_agent: '找不到可唤醒的会话。',
  turn_unavailable: '无法确认当前回合，不执行自唤醒。',
  wake_loop: '当前回合由自唤醒开启，不能再次自唤醒。',
  same_turn: '当前回合已经提交过自唤醒。',
  cooldown: '距该会话上次自唤醒不足 15 秒。',
  hourly_cap: '最近一小时自唤醒已达 2 次上限。',
  daily_cap: '今天自唤醒已达 6 次上限。',
  heart_blocked: 'Heart 当前建议休息，不执行自唤醒。',
  heart_error: '无法确认 Heart 活动门控，不执行自唤醒。',
  quota_unavailable: '无法确认自唤醒记录，不执行自唤醒。',
  clock_regressed: '检测到时钟回拨，不执行自唤醒。',
  followup_failed: '宿主未确认自唤醒已排队，本次占用仍保留。',
}

function deny(reason) {
  return { ok: false, reason, message: refusal[reason] }
}

function localTime(at) {
  const { year, month, day, hour } = Object.fromEntries(shanghai.formatToParts(at).map(part => [part.type, part.value]))
  return { day: `${year}-${month}-${day}`, quiet: Number(hour) >= 1 && Number(hour) < 7 }
}

export function createWakeMessage(text) {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text: String(text) }], source: { kind: 'schedule' } }
}

function reserve(file, target, at, day, messageId) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 500; PRAGMA synchronous = FULL; BEGIN IMMEDIATE;')
    db.exec(`
      CREATE TABLE IF NOT EXISTS wakes (
        id TEXT NOT NULL PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn INTEGER,
        at INTEGER NOT NULL,
        day TEXT NOT NULL,
        UNIQUE (session_id, turn)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS wake_time ON wakes (at);
      CREATE INDEX IF NOT EXISTS wake_day ON wakes (day);
      CREATE INDEX IF NOT EXISTS wake_session_time ON wakes (session_id, at);
    `)
    const { sessionId, turn, scheduledIds } = target
    const priorMessage = db.prepare('SELECT 1 FROM wakes WHERE id = ? AND session_id = ?')
    const latest = db.prepare('SELECT max(at) AS at FROM wakes').get().at
    const sameTurn = db.prepare('SELECT 1 FROM wakes WHERE session_id = ? AND turn = ?')
    const lastInSession = db.prepare('SELECT max(at) AS at FROM wakes WHERE session_id = ?').get(sessionId).at
    let reason
    if (latest !== null && at < latest) reason = 'clock_regressed'
    else if (scheduledIds.some(id => priorMessage.get(id, sessionId))) reason = 'wake_loop'
    else if (turn !== null && sameTurn.get(sessionId, turn)) reason = 'same_turn'
    else if (lastInSession !== null && at - lastInSession < cooldownMs) reason = 'cooldown'
    else if (db.prepare('SELECT count(*) AS used FROM wakes WHERE at > ?').get(at - hourMs).used >= hourlyCap) reason = 'hourly_cap'
    else if (db.prepare('SELECT count(*) AS used FROM wakes WHERE day = ?').get(day).used >= dailyCap) reason = 'daily_cap'
    else db.prepare('INSERT INTO wakes (id, session_id, turn, at, day) VALUES (?, ?, ?, ?, ?)').run(messageId, sessionId, turn, at, day)
    db.exec('COMMIT')
    return reason
  } finally {
    // Closing an uncommitted SQLite transaction rolls it back.
    db.close()
  }
}

export function createWake(ctx, { dataDir, now = Date.now } = {}) {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  const file = path.resolve(dataDir || path.join(home, 'heart-wake'), 'wake.sqlite')

  return async function wake(text, exec) {
    if (exec?.signal?.aborted) return deny('cancelled')
    if (typeof text !== 'string' || !text.trim()) return deny('invalid_text')
    if (localTime(now()).quiet) return deny('quiet_hours')

    let agent
    try {
      agent = resolveWakeTarget(ctx, exec)
      if (typeof agent?.followup !== 'function' || agent.status === 'disposed') return deny('no_agent')
    } catch {
      return deny('no_agent')
    }

    try {
      const heart = typeof ctx.get === 'function' ? ctx.get('heart') : ctx.heart
      if (heart?.evaluateActivity) {
        // A follow-up is autonomous even when the current turn began with a user message.
        const gate = await heart.evaluateActivity({ intent: 'heart_wake' })
        if (gate?.suitable === false) return deny('heart_blocked')
      }
    } catch {
      return deny('heart_error')
    }

    if (exec?.signal?.aborted) return deny('cancelled')
    let target
    try {
      target = resolveWakeTurn(agent, exec)
    } catch {
      return deny('turn_unavailable')
    }
    if (!target) return deny('turn_unavailable')

    const at = now()
    const { day, quiet } = localTime(at)
    if (quiet) return deny('quiet_hours')
    const message = createWakeMessage(text)
    try {
      // Reserve durably before the host can see the message. A host error
      // cannot prove the inbox was untouched, so it never refunds the slot.
      const blocked = reserve(file, target, at, day, message.id)
      if (blocked) return deny(blocked)
    } catch {
      return deny('quota_unavailable')
    }
    try {
      await agent.followup(message)
    } catch {
      return deny('followup_failed')
    }
    return { ok: true, message: '已排入下一轮自唤醒。', messageId: message.id }
  }
}
