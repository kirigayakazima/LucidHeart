import { check, text, transaction } from '../db.js'

export const resonanceSchema = `
CREATE TABLE IF NOT EXISTS resonance_cooldown (
  scope TEXT PRIMARY KEY, at INTEGER NOT NULL, message_id TEXT NOT NULL
) STRICT;
`
const hourMs = 3_600_000
const normalized = value => value.normalize('NFKC').toLowerCase()

export function resonanceCallback(db, now, candidates) {
  return {
    find({ topic }, surface) {
      topic = text(topic, 'topic', 80)
      const keyword = normalized(topic)
      check(surface && [...keyword].length >= 2 && normalized(surface.utterance).includes(keyword),
        '回调关键词必须来自本轮真实用户消息')
      return transaction(db, () => {
        const at = now()
        const prior = db.prepare('SELECT * FROM resonance_cooldown WHERE scope=?').get(surface.scope)
        if (prior && (at - prior.at < hourMs || prior.message_id === surface.messageId)) {
          return { has_resonance: false, reason: 'cooldown' }
        }
        const matches = candidates(surface).filter(row =>
          !(row.scope === surface.scope && row.evidence_type === 'chat_cue' && row.evidence_id === surface.messageId)).map(row => ({
          row, score: [row.title, row.evidence_snippet, row.observation]
            .reduce((score, value, index) => score + (normalized(value).includes(keyword) ? [4, 3, 1][index] : 0), 0),
        })).filter(match => match.score)
        matches.sort((left, right) => right.score - left.score)
        const best = matches[0]?.row
        if (!best) return { has_resonance: false, reason: 'no_match' }
        db.prepare('INSERT OR REPLACE INTO resonance_cooldown VALUES (?, ?, ?)').run(surface.scope, at, surface.messageId)
        return { has_resonance: true, story_snippet: best.evidence_snippet,
          suggested_humour: best.dimension === 'shared_joke' ? '可以轻轻接一句当时的梗。' : '自然提一句这段经历即可。' }
      })
    },
  }
}
