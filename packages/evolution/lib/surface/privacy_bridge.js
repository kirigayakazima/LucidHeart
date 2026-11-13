import { check, text } from '../db.js'

export const privacySchema = `
CREATE TABLE IF NOT EXISTS public_cues (
  scope TEXT NOT NULL, message_id TEXT NOT NULL, topic TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(scope,message_id)
) STRICT;
`

const normalizeScope = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
export function surfaceContext(exec, { coreGroupSessions = [], ownerDirectSessions = [] } = {}) {
  const session = exec?.agent?.session
  const scope = normalizeScope(session?.id ?? session?.header?.id ?? exec?.agent?.id)
  const events = session?.snapshotEvents?.() ?? session?.events
  const callId = exec?.rootCallId ?? exec?.callId
  if (!scope || !callId || !Array.isArray(events) || exec.signal?.aborted) return null
  const start = events.findLastIndex(event => ['turn/start', 'turn/end', 'session/end-seed'].includes(event?.type))
  if (events[start]?.type !== 'turn/start') return null
  const call = events.findLastIndex(event => event?.type === 'tool/call' && event.data?.callId === callId &&
    event.data?.turn === events[start].data?.turn)
  if (call <= start) return null
  const input = events.slice(start + 1, call).findLast(event => event?.type === 'user/message' &&
    ['user', 'schedule', 'external'].includes(event.data?.source?.kind))
  const message = input?.data
  if (message?.role !== 'user' || message.source.kind !== 'user' || typeof message.id !== 'string' || !message.id) return null
  const qq = message.source.qq
  const raw = message.content?.find(block => block?.type === 'text')?.text
  if (typeof raw !== 'string') return null
  if (qq && (!['direct', 'group'].includes(qq.channel) || !Number.isSafeInteger(qq.start) ||
      !Number.isSafeInteger(qq.length) || qq.start < 0 || qq.length < 1 || qq.start > raw.length - qq.length)) return null
  const channel = qq?.channel ?? 'direct'
  return { scope, storageScope: session?.id ?? session?.header?.id ?? exec.agent.id,
    channel, messageId: message.id, at: Number.isSafeInteger(input.time) ? input.time : null,
    utterance: (qq ? raw.slice(qq.start, qq.start + qq.length) : raw).trim(),
    coreGroup: channel === 'group' && coreGroupSessions.map(normalizeScope).includes(scope),
    ownerDirect: channel === 'direct' && ownerDirectSessions.map(normalizeScope).includes(scope) }
}

export function visibleTo(entry, surface) {
  if (!entry || !surface) return false
  if (entry.visibility === 'PUBLIC_FRIENDLY') return surface.coreGroup || surface.ownerDirect || entry.scope === surface.scope
  return entry.visibility === 'PRIVATE' && surface.channel === 'direct' && entry.scope === surface.scope
}

export function privacyBridge(db, now, readFootprint) {
  return {
    filter(memories, target, surface) {
      check(surface?.channel === target, '目标场景必须与宿主当前会话一致')
      check(Array.isArray(memories) && memories.length <= 100, 'memories 必须是最多 100 条记录的数组')
      const found = new Map()
      for (const item of memories) {
        const id = typeof item === 'string' ? item : item?.id
        if (typeof id !== 'string') continue
        const entry = readFootprint(id)
        if (visibleTo(entry, surface)) found.set(id, entry)
      }
      return [...found.values()]
    },
    recordCue(surface, topic) {
      check(surface?.coreGroup, '仅可登记配置中的核心主群话题')
      topic = text(topic, 'topic', 100)
      check(surface.utterance.includes(topic), '话题须来自当前群消息')
      // Use an explicit public-sharing instruction, never ordinary group text.
      check(/^(?:公开话题|群话题)[：:]\s*/u.test(surface.utterance) &&
        surface.utterance.replace(/^(?:公开话题|群话题)[：:]\s*/u, '') === topic, '需要用户明确登记群话题')
      return { recorded: db.prepare('INSERT OR IGNORE INTO public_cues VALUES (?, ?, ?, ?)')
        .run(surface.scope, surface.messageId, topic, now()).changes === 1 }
    },
    cue(target, surface) {
      if (target !== 'direct' || !surface?.ownerDirect) return { has_cue: false }
      const at = now()
      const row = db.prepare('SELECT topic FROM public_cues WHERE at>=? AND at<=? ORDER BY at DESC, rowid DESC LIMIT 1')
        .get(at - 4 * 3_600_000, at)
      return row ? { has_cue: true, topic: row.topic, suggestion: `刚才群里聊到「${row.topic}」，要接着聊吗？` } : { has_cue: false }
    },
  }
}
