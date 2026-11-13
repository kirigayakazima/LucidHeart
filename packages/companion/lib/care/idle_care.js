import { randomUUID } from 'node:crypto'
import { requireThat, str, transaction } from '../db.js'
import { shanghaiDay } from '../context.js'

export const idleSchema = `
CREATE TABLE IF NOT EXISTS care_interactions (
  scope TEXT PRIMARY KEY, message_id TEXT NOT NULL, last_at INTEGER NOT NULL, gap_ms INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS care_reminders (
  scope TEXT NOT NULL, day TEXT NOT NULL, trigger_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY(scope, trigger_id)
) STRICT;
CREATE INDEX IF NOT EXISTS care_day ON care_reminders(day);
CREATE TABLE IF NOT EXISTS care_commitments (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, due_at INTEGER NOT NULL,
  source TEXT NOT NULL, completed_at INTEGER, confirmation_id TEXT
) STRICT;
`
const fourHours = 14_400_000

export function idleCare(db, now) {
  return {
    noteInteraction(scope, messageId) {
      transaction(db, () => {
        const at = now()
        const prior = db.prepare('SELECT * FROM care_interactions WHERE scope=?').get(scope)
        if (prior?.message_id === messageId || (prior && prior.last_at > at)) return
        db.prepare('INSERT OR REPLACE INTO care_interactions VALUES (?, ?, ?, ?)')
          .run(scope, messageId, at, prior ? at - prior.last_at : 0)
      })
    },
    addCommitment(scope, { title, due_at }, evidence) {
      title = str(title, 'title')
      requireThat(evidence?.text.includes(title), '需要当前用户消息确认此约定')
      requireThat(Number.isSafeInteger(due_at) && due_at > now(), '约定时限须为未来 Unix 毫秒')
      const id = randomUUID()
      db.prepare("INSERT INTO care_commitments VALUES (?, ?, ?, ?, 'companion', NULL, NULL)").run(id, scope, title, due_at)
      return { id, title, due_at }
    },
    complete(scope, id, evidence) {
      return transaction(db, () => {
        const item = db.prepare('SELECT * FROM care_commitments WHERE scope=? AND id=?').get(scope, str(id, 'id'))
        requireThat(item && evidence?.text.includes(item.title) &&
          /(?:已完成|做完了|兑现了|已经完成)/u.test(evidence.text) &&
          !/(?:未|没|没有|尚未|还没).{0,5}(?:完成|做完|兑现)|[？?]/u.test(evidence.text), '需要用户明确确认约定已完成')
        db.prepare('UPDATE care_commitments SET completed_at=?, confirmation_id=? WHERE id=? AND completed_at IS NULL')
          .run(now(), evidence.id, id)
        return { id, completed: true, source: item.source }
      })
    },
    evaluate(scope, messageId, external) {
      return transaction(db, () => {
        const at = now()
        const day = shanghaiDay(at)
        const interaction = db.prepare('SELECT * FROM care_interactions WHERE scope=?').get(scope)
        const local = db.prepare(`SELECT * FROM care_commitments WHERE scope=? AND completed_at IS NULL AND due_at<=?
          ORDER BY due_at, id LIMIT 1`).get(scope, at)
        let due = local
        if (!due && external?.id && external?.title) {
          const id = `memory:${JSON.stringify([scope, external.id])}`
          if (!db.prepare('SELECT 1 FROM care_commitments WHERE id=? AND completed_at IS NOT NULL').get(id)) {
            due = { id, title: external.title, source: 'memory' }
          }
        }
        const returning = messageId && interaction?.message_id === messageId && interaction.gap_ms >= fourHours
        if (!due && !returning) return { should_care: false, reason: 'not_due' }
        const trigger = due ? `due:${due.id}:${day}` : `return:${messageId}`
        if (db.prepare('SELECT 1 FROM care_reminders WHERE scope=? AND trigger_id=?').get(scope, trigger)) {
          return { should_care: false, reason: 'already_suggested' }
        }
        if (db.prepare('SELECT count(*) AS n FROM care_reminders WHERE day=?').get(day).n >= 2) {
          return { should_care: false, reason: 'daily_cap' }
        }
        if (due?.source === 'memory') {
          db.prepare("INSERT OR IGNORE INTO care_commitments VALUES (?, ?, ?, ?, 'memory', NULL, NULL)")
            .run(due.id, scope, due.title, at)
        }
        db.prepare('INSERT INTO care_reminders VALUES (?, ?, ?, ?)').run(scope, day, trigger, at)
        return due
          ? { should_care: true, reason: 'commitment_due', commitment_id: due.id, suggestion: `还记得我们约好的「${due.title}」，现在进展怎么样？` }
          : { should_care: true, reason: 'user_returned', suggestion: '你回来啦。刚忙完的话，先歇一会儿也好。' }
      })
    },
  }
}
