import { check, encode, text, transaction } from './db.js'
import { evaluateSkill, normalizeSkill, previewSkill } from './skill_eval.js'

export const skillSchema = `
CREATE TABLE IF NOT EXISTS skill_revisions (
  skill_id TEXT NOT NULL, revision INTEGER NOT NULL, parent INTEGER,
  status TEXT NOT NULL CHECK(status IN ('candidate','evaluating','committed','reverted')),
  definition TEXT NOT NULL, assessment TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY(skill_id, revision)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS skill_one_trial ON skill_revisions(skill_id)
  WHERE status IN ('candidate','evaluating');
CREATE TABLE IF NOT EXISTS skill_heads (
  skill_id TEXT PRIMARY KEY, revision INTEGER NOT NULL,
  FOREIGN KEY(skill_id, revision) REFERENCES skill_revisions(skill_id, revision)
) STRICT;
`

export function skillSandbox(db, now = Date.now) {
  const parseId = value => text(value, '技能 ID', 80)
  const read = (id, revision) => db.prepare('SELECT * FROM skill_revisions WHERE skill_id=? AND revision=?').get(id, revision)
  const pending = id => db.prepare("SELECT * FROM skill_revisions WHERE skill_id=? AND status IN ('candidate','evaluating')").get(id)
  const head = id => db.prepare('SELECT revision FROM skill_heads WHERE skill_id=?').get(id)?.revision ?? null
  const setHead = (id, revision) => revision === null ? db.prepare('DELETE FROM skill_heads WHERE skill_id=?').run(id)
    : db.prepare('INSERT INTO skill_heads VALUES (?,?) ON CONFLICT(skill_id) DO UPDATE SET revision=excluded.revision').run(id, revision)
  const decode = row => row ? { skillId: row.skill_id, revision: row.revision, status: row.status,
    definition: JSON.parse(row.definition), assessment: JSON.parse(row.assessment) } : null

  return {
    propose(id, value) {
      id = parseId(id)
      const config = encode(normalizeSkill(value))
      return transaction(db, () => {
        check(!pending(id), '该技能已有候选版本')
        const { revision } = db.prepare('SELECT coalesce(max(revision),0)+1 AS revision FROM skill_revisions WHERE skill_id=?').get(id)
        db.prepare("INSERT INTO skill_revisions VALUES (?,?,?,'candidate',?,NULL,?)").run(id, revision, head(id), config, now())
        return decode(read(id, revision))
      })
    },
    async evaluate(id, revision, signal) {
      id = parseId(id)
      signal?.throwIfAborted()
      const snapshot = transaction(db, () => {
        const row = read(id, revision)
        check(row?.status === 'candidate' || row?.status === 'evaluating', '候选版本已结束')
        db.prepare("UPDATE skill_revisions SET status='evaluating',assessment=NULL WHERE skill_id=? AND revision=?").run(id, revision)
        return JSON.parse(row.definition)
      })
      const report = await evaluateSkill(snapshot)
      signal?.throwIfAborted()
      const result = { total: report.total, passed: report.passed, failed: report.results.filter(row => !row.passed).map(row => row.id) }
      return transaction(db, () => {
        check(read(id, revision)?.status === 'evaluating', '回测期间候选版本已结束')
        db.prepare('UPDATE skill_revisions SET assessment=? WHERE skill_id=? AND revision=?').run(encode(result), id, revision)
        return decode(read(id, revision))
      })
    },
    commit(id, revision) {
      id = parseId(id)
      return transaction(db, () => {
        const row = read(id, revision), assessment = JSON.parse(row?.assessment ?? 'null')
        check(row?.status === 'evaluating' && assessment?.total >= 40 && assessment.passed === assessment.total &&
          row.parent === head(id), '需通过完整回测且基线未变更')
        db.prepare("UPDATE skill_revisions SET status='committed' WHERE skill_id=? AND revision=?").run(id, revision)
        setHead(id, revision)
        return decode(read(id, revision))
      })
    },
    revert(id, revision) {
      id = parseId(id)
      return transaction(db, () => {
        const active = head(id)
        const row = revision === undefined ? pending(id) ?? (active && read(id, active)) : read(id, revision)
        check(row && row.status !== 'reverted' && (row.status !== 'committed' || row.revision === active), '没有可回退的版本')
        db.prepare("UPDATE skill_revisions SET status='reverted' WHERE skill_id=? AND revision=?").run(id, row.revision)
        if (row.revision === active) setHead(id, row.parent)
        return { reverted: row.revision, active: head(id) }
      })
    },
    active(id) {
      id = parseId(id)
      const revision = head(id)
      return revision === null ? null : decode(read(id, revision))
    },
    trial(id) { return decode(pending(parseId(id))) },
    preview(id, context, { trial = false } = {}) {
      const selected = trial ? this.trial(id) : this.active(id)
      return selected ? previewSkill(selected.definition, context) : null
    },
  }
}
