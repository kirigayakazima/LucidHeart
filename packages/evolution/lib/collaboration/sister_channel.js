import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { check, encode, text, transaction } from '../db.js'

export const sisterPath = '/api/dsh-evolution/sister'
export const dayMs = 86_400_000
export const sisterSchema = `
CREATE TABLE IF NOT EXISTS sister_messages (
  id TEXT PRIMARY KEY, sender TEXT NOT NULL, receiver TEXT NOT NULL, type TEXT NOT NULL,
  summary TEXT NOT NULL, payload_json TEXT NOT NULL, urgency TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, handled INTEGER NOT NULL DEFAULT 0,
  handled_at INTEGER, result_note TEXT, direction TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS sister_inbox ON sister_messages(direction,handled,expires_at);
`
const types = {
  care_relay: ['delay_minutes', 'suggestion'],
  status_sync: ['state'],
  joint_task: ['task_id', 'action'],
  whisper: ['text'],
}
const roles = ['axing', 'xiaoman']
const urgencyLevels = ['low', 'normal', 'high']
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i

function validate(packet, at) {
  check(typeof packet.id === 'string' && uuid.test(packet.id) && roles.includes(packet.sender) &&
    roles.includes(packet.receiver) && packet.receiver !== packet.sender, '协作路由无效')
  check(Object.hasOwn(types, packet.type) && urgencyLevels.includes(packet.urgency), '协作类型或紧急程度无效')
  check(Number.isSafeInteger(packet.createdAt) && packet.createdAt > 0 && packet.createdAt <= at + 60_000 &&
    packet.expiresAt === packet.createdAt + dayMs && packet.expiresAt > at, '协作包已过期或时间无效')
  const summary = text(packet.summary, 'summary', 100)
  const payload = packet.payload
  check(payload && typeof payload === 'object' && !Array.isArray(payload) &&
    Object.keys(payload).every(key => types[packet.type].includes(key)), '协作载荷超出允许字段')
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'delay_minutes') check(Number.isInteger(value) && value >= 0 && value <= 1440, '延迟分钟无效')
    else text(value, key, 500)
  }
  return { id: packet.id, sender: packet.sender, receiver: packet.receiver, type: packet.type, summary,
    payload, urgency: packet.urgency, createdAt: packet.createdAt, expiresAt: packet.expiresAt, handled: false }
}

export function signature(body, secret) {
  return createHmac('sha256', secret).update(body).digest('hex')
}

function decode(row) {
  return { id: row.id, sender: row.sender, receiver: row.receiver, type: row.type, summary: row.summary,
    payload: JSON.parse(row.payload_json), urgency: row.urgency, createdAt: row.created_at, expiresAt: row.expires_at,
    handled: Boolean(row.handled), ...(row.handled_at !== null && { handledAt: row.handled_at, resultNote: row.result_note }) }
}

export function sisterChannel(db, { role, now = Date.now, transport }) {
  check(roles.includes(role), '本端角色无效')
  const save = (packet, direction) => db.prepare(`INSERT INTO sister_messages
    (id,sender,receiver,type,summary,payload_json,urgency,created_at,expires_at,direction) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(packet.id, packet.sender, packet.receiver, packet.type, packet.summary, encode(packet.payload, 4096),
      packet.urgency, packet.createdAt, packet.expiresAt, direction)
  const get = id => db.prepare('SELECT * FROM sister_messages WHERE id=?').get(id)
  let sending
  async function flush(signal) {
    if (!transport) return 0
    if (sending) return sending
    sending = (async () => {
      const rows = db.prepare("SELECT * FROM sister_messages WHERE direction='out' AND delivered=0 AND expires_at>? ORDER BY created_at LIMIT 50")
        .all(now())
      let sent = 0
      for (const row of rows) {
        signal?.throwIfAborted()
        await transport(decode(row), signal)
        db.prepare('UPDATE sister_messages SET delivered=1 WHERE id=?').run(row.id)
        sent++
      }
      return sent
    })()
    try { return await sending } finally { sending = null }
  }
  return {
    async send({ type, summary, payload = {}, urgency = 'normal' }, signal) {
      const at = now()
      const packet = validate({ id: randomUUID(), sender: role, receiver: role === 'axing' ? 'xiaoman' : 'axing',
        type, summary, payload, urgency, createdAt: at, expiresAt: at + dayMs }, at)
      signal?.throwIfAborted()
      save(packet, 'out')
      try { await flush(signal) } catch { /* Durable outbox remains available for explicit retry. */ }
      return { ...packet, delivery: get(packet.id).delivered ? 'sent' : 'queued' }
    },
    flush,
    ingest(body, mac, secret) {
      check(typeof secret === 'string' && secret.length >= 32 && typeof body === 'string' &&
        Buffer.byteLength(body) <= 8192 && typeof mac === 'string' && /^[a-f\d]{64}$/.test(mac) &&
        timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(body, secret), 'hex')), '协作签名无效')
      let packet
      try { packet = JSON.parse(body) } catch { check(false, '协作 JSON 无效') }
      check(packet && typeof packet === 'object', '协作包无效')
      packet = validate(packet, now())
      check(packet.receiver === role, '协作包目标与本端不一致')
      return transaction(db, () => {
        const prior = get(packet.id)
        if (!prior) save(packet, 'in')
        else {
          const { handledAt, resultNote, ...original } = decode(prior)
          check(prior.direction === 'in' && encode({ ...original, handled: false }) === encode(packet), '协作包 ID 冲突')
        }
        return { accepted: true, duplicate: Boolean(prior) }
      })
    },
    receive({ limit = 20, unhandled_only = true } = {}) {
      check(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit 必须为 1–100')
      return db.prepare(`SELECT * FROM sister_messages WHERE direction='in' AND receiver=? AND expires_at>?
        AND (handled=0 OR ?=0) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .all(role, now(), Number(unhandled_only), limit).map(decode)
    },
    markHandled({ id, result_note }) {
      return transaction(db, () => {
        const row = get(text(id, 'id'))
        check(row?.direction === 'in' && row.receiver === role && row.expires_at > now(), '找不到有效的本端协作包')
        if (!row.handled) db.prepare('UPDATE sister_messages SET handled=1, handled_at=?, result_note=? WHERE id=?')
          .run(now(), text(result_note, 'result_note'), id)
        return decode(get(id))
      })
    },
  }
}

export function httpTransport(url, secret) {
  const target = new URL(url)
  check((target.protocol === 'https:' || (target.protocol === 'http:' &&
    ['127.0.0.1', '[::1]', 'localhost'].includes(target.hostname))) && !target.username && !target.password &&
    target.pathname === sisterPath && !target.search && !target.hash, '协作端点须为 HTTPS 或回环地址')
  return async (packet, signal) => {
    const body = encode(packet, 8192)
    const response = await fetch(target, { method: 'POST', body, redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-sister-signature': signature(body, secret) },
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]) })
    await response.body?.cancel()
    if (!response.ok) throw new Error('协作网关未接受消息')
  }
}
