import { randomUUID } from 'node:crypto'
import { check, text, transaction } from '../db.js'
import { visibleTo } from '../surface/privacy_bridge.js'

export const footprintSchema = `
CREATE TABLE IF NOT EXISTS authentic_footprints (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, visibility TEXT NOT NULL, period TEXT NOT NULL,
  dimension TEXT NOT NULL, title TEXT NOT NULL, observation TEXT NOT NULL, evidence_type TEXT NOT NULL,
  evidence_id TEXT NOT NULL, evidence_snippet TEXT NOT NULL, evidence_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(scope,dimension,evidence_type,evidence_id)
) STRICT;
CREATE INDEX IF NOT EXISTS footprint_period ON authentic_footprints(period,evidence_at);
`
const monthFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' })
const monthOf = at => {
  const parts = Object.fromEntries(monthFormat.formatToParts(at).map(item => [item.type, item.value]))
  return parts.year + '-' + parts.month
}
const dimensions = ['music_habit', 'lifestyle', 'companion_milestone', 'shared_joke']
const evidenceTypes = ['song_play', 'project_checkin', 'commitment_done', 'chat_cue']
const publicInstruction = (surface, snippet) =>
  surface.coreGroup && surface.utterance === '公开记录：' + snippet

export function verifyEvidence(args, surface, { companion, memory }, now) {
  const id = text(args.evidence_id ?? surface.messageId, 'evidence_id', 250)
  if (args.evidence_type === 'chat_cue') {
    const snippet = text(args.evidence_snippet, 'evidence_snippet', 300)
    check(id === surface.messageId && surface.utterance.includes(snippet), '引用必须来自本轮用户原话')
    return { id, snippet, at: surface.at ?? now(), public: publicInstruction(surface, snippet) }
  }
  if (args.evidence_type === 'song_play') {
    const task = companion?.tasks?.get(id)
    check(task?.target === surface.storageScope && task.kind === 'singing' && ['completed', 'delivered'].includes(task.status) &&
      task.result?.output_path && typeof task.payload?.title === 'string', '没有同会话已完成成曲证据')
    const heard = surface.utterance.includes(task.payload.title) &&
      /(?:听完了|听过了|听完这首|一起听了)/u.test(surface.utterance) && !/(?:没听|未听|[？?])/u.test(surface.utterance)
    check(heard, '需要用户确认已听过成曲')
    const publicTitle = '公开记录：' + task.payload.title
    return { id, snippet: task.payload.title, at: surface.at ?? now(), public: surface.coreGroup &&
      [publicTitle + '听完了', publicTitle + '听过了'].includes(surface.utterance) }
  }
  if (args.evidence_type === 'project_checkin') {
    let project
    try { project = companion?.projects?.status(surface.storageScope, id) } catch { check(false, '找不到本会话的真实项目') }
    const log = args.evidence_snippet ? project?.logs?.find(item => item.note === args.evidence_snippet) : project?.logs?.[0]
    check(log && typeof log.note === 'string', '找不到本会话的真实打卡')
    return { id: log.id, snippet: log.note, at: log.created_at, public: publicInstruction(surface, log.note) }
  }
  check(surface.ownerDirect, '约定证据仅允许在已配置的本人私聊引用')
  const entry = memory?.commitments?.get(id)
  check(entry?.status === 'fulfilled' && surface.utterance.includes(entry.title) &&
    /(?:已完成|做完了|兑现了|已经完成)/u.test(surface.utterance) &&
    !/(?:未|没|没有|尚未).{0,5}(?:完成|做完|兑现)|[？?]/u.test(surface.utterance), '缺少真实履约证据或本轮确认')
  return { id, snippet: entry.title, at: Date.parse(entry.fulfilledAt), public: false }
}

export function growthFootprint(db, now) {
  const get = id => db.prepare('SELECT * FROM authentic_footprints WHERE id=?').get(id) ?? null
  return {
    get,
    record(args, surface, verify) {
      check(surface, '缺少可信宿主会话')
      check(dimensions.includes(args.dimension) && evidenceTypes.includes(args.evidence_type), '手账维度或证据类型无效')
      const title = text(args.title, 'title', 100)
      const observation = text(args.observation, 'observation', 300)
      const evidence = verify(args, surface)
      check(evidence && Number.isSafeInteger(evidence.at) && evidence.at > 0 && evidence.at <= now(), '证据时间无效')
      const snippet = text(evidence.snippet, '证据', 500)
      // Public output must consist only of user-approved source text. Private
      // entries can retain annotations in their own direct conversation.
      check(args.visibility === undefined || ['PRIVATE', 'PUBLIC_FRIENDLY'].includes(args.visibility), '可见性无效')
      const visibility = args.visibility ?? (surface.channel === 'group' ? 'PUBLIC_FRIENDLY' : 'PRIVATE')
      check(visibility === 'PUBLIC_FRIENDLY' ? evidence.public && snippet.includes(title) && snippet.includes(observation)
        : surface.channel === 'direct' && (surface.utterance.includes(observation) || snippet.includes(observation)),
      '手账内容必须受真实证据与场景可见性约束')
      return transaction(db, () => {
        const prior = db.prepare('SELECT * FROM authentic_footprints WHERE scope=? AND dimension=? AND evidence_type=? AND evidence_id=?')
          .get(surface.scope, args.dimension, args.evidence_type, evidence.id)
        if (prior) return visibleTo(prior, surface) ? prior : null
        const id = randomUUID()
        db.prepare('INSERT INTO authentic_footprints VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, surface.scope, visibility, monthOf(evidence.at), args.dimension, title, observation,
            args.evidence_type, evidence.id, snippet, evidence.at, now())
        return get(id)
      })
    },
    digest(month, surface) {
      check(typeof month === 'string' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(month), 'month 格式为 YYYY-MM')
      const rows = db.prepare('SELECT * FROM authentic_footprints WHERE period=? ORDER BY evidence_at,id').all(month)
        .filter(row => visibleTo(row, surface))
      const songs = new Set(rows.filter(row => row.evidence_type === 'song_play').map(row => row.evidence_id))
      const days = new Set(rows.filter(row => row.evidence_type === 'project_checkin').map(row => dateFormat.format(row.evidence_at)))
      const habits = [...new Set(rows.filter(row => ['music_habit', 'lifestyle'].includes(row.dimension)).map(row => row.title))]
      return { month, songs: songs.size, checkin_days: days.size, habits, entries: rows }
    },
    candidates(surface) {
      return db.prepare(`SELECT * FROM authentic_footprints WHERE scope=? OR visibility='PUBLIC_FRIENDLY'
        ORDER BY evidence_at DESC, id DESC`).all(surface.scope).filter(row => visibleTo(row, surface))
    },
  }
}
