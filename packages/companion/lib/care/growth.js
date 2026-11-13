import { createHash, randomUUID } from 'node:crypto'
import { json, requireThat, str, transaction } from '../db.js'
import { dayMs } from '../tasks/ledger.js'

export const growthSchema = `
CREATE TABLE IF NOT EXISTS experience_candidates (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, category TEXT NOT NULL, insight TEXT NOT NULL, quote TEXT,
  status TEXT NOT NULL DEFAULT 'candidate', created_at INTEGER NOT NULL, UNIQUE(scope,category,insight)
) STRICT;
CREATE TABLE IF NOT EXISTS reinforcement (
  candidate_id TEXT NOT NULL REFERENCES experience_candidates(id), message_id TEXT NOT NULL,
  evidence TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(candidate_id,message_id)
) STRICT;
CREATE TABLE IF NOT EXISTS growth_promotions (
  seq INTEGER PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES experience_candidates(id),
  source TEXT NOT NULL, evidence_json TEXT NOT NULL, at INTEGER NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS growth_config (
  candidate_id TEXT PRIMARY KEY REFERENCES experience_candidates(id), category TEXT NOT NULL, insight TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS promotions_no_update BEFORE UPDATE ON growth_promotions
BEGIN SELECT RAISE(ABORT, 'growth promotion is append only'); END;
CREATE TRIGGER IF NOT EXISTS promotions_no_delete BEFORE DELETE ON growth_promotions
BEGIN SELECT RAISE(ABORT, 'growth promotion is append only'); END;
`

const categories = ['expression', 'knowledge', 'emotion', 'life', 'habit', 'dream']
const positive = text => /(?:喜欢|好可爱|很好|很棒|赞同|记住|保持|继续这样)/u.test(text) &&
  !/(?:不喜欢|不可爱|不要|别|并不|不好|[？?])/u.test(text)
const digest = data => createHash('sha256').update(json(data)).digest('hex')

export function growth(db, now) {
  const get = (scope, id) => db.prepare('SELECT * FROM experience_candidates WHERE scope=? AND id=?').get(scope, id)
  return {
    observe(scope, { category, insight, quote }, evidence) {
      requireThat(categories.includes(category), '经验类别不在受控范围')
      insight = str(insight, 'insight')
      const verified = quote !== undefined ? str(quote, 'quote') : null
      if (verified) requireThat(evidence?.text.includes(verified), '引文须来自当前真实用户消息')
      return transaction(db, () => {
        const at = now()
        db.prepare('INSERT OR IGNORE INTO experience_candidates VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), scope, category, insight, verified, 'candidate', at)
        const candidate = db.prepare('SELECT * FROM experience_candidates WHERE scope=? AND category=? AND insight=?')
          .get(scope, category, insight)
        if (verified && positive(verified) && positive(evidence.text) && (evidence.text.includes(insight) || evidence.text.includes(candidate.id))) {
          db.prepare('INSERT OR IGNORE INTO reinforcement VALUES (?, ?, ?, ?)').run(candidate.id, evidence.id, verified, at)
        }
        const count = db.prepare('SELECT count(*) AS n FROM reinforcement WHERE candidate_id=? AND at>=? AND at<=?')
          .get(candidate.id, at - 7 * dayMs, at).n
        return { ...candidate, reinforcement_count: count }
      })
    },
    promote(scope, { id, approval_source }, evidence) {
      return transaction(db, () => {
        const candidate = get(scope, str(id, 'id'))
        requireThat(candidate, '找不到经验候选')
        if (candidate.status === 'approved') return candidate
        requireThat(['user_confirmation', 'reinforcement'].includes(approval_source), '晋升来源无效')
        const at = now()
        const rows = approval_source === 'reinforcement'
          ? db.prepare('SELECT message_id, evidence, at FROM reinforcement WHERE candidate_id=? AND at>=? AND at<=? ORDER BY at, message_id')
            .all(id, at - 7 * dayMs, at) : null
        if (rows) requireThat(rows.length >= 3, '最近七天需要至少三条独立的用户正向强化')
        else requireThat(evidence && positive(evidence.text) &&
          (evidence.text.includes(candidate.insight) || evidence.text.includes(id)), '需要真实用户明确确认该经验')
        const record = json(rows ?? [{ message_id: evidence.id, evidence: evidence.text }])
        const previous = db.prepare('SELECT hash FROM growth_promotions ORDER BY seq DESC LIMIT 1').get()?.hash ?? ''
        const hash = digest([previous, id, candidate.category, candidate.insight, approval_source, record, at])
        db.prepare('INSERT INTO growth_promotions(candidate_id, source, evidence_json, at, previous, hash) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, approval_source, record, at, previous, hash)
        db.prepare('INSERT INTO growth_config VALUES (?, ?, ?)').run(id, candidate.category, candidate.insight)
        db.prepare("UPDATE experience_candidates SET status='approved' WHERE id=?").run(id)
        return { ...get(scope, id), audit_hash: hash }
      })
    },
    approved(scope) {
      return db.prepare(`SELECT g.* FROM growth_config g JOIN experience_candidates c ON c.id=g.candidate_id
        WHERE c.scope=? ORDER BY c.created_at, c.id`).all(scope)
    },
  }
}
