import { requireThat, str, transaction } from '../db.js'

export const interestSchema = `
CREATE TABLE IF NOT EXISTS interests (
  topic_key TEXT PRIMARY KEY, topic TEXT NOT NULL, enthusiasm INTEGER NOT NULL,
  context TEXT NOT NULL, last_mentioned INTEGER NOT NULL, mention_count INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS interest_mentions (
  topic_key TEXT NOT NULL REFERENCES interests(topic_key), scope TEXT NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY(topic_key, scope, message_id)
) STRICT;
`

export function recordInterest(db, now, scope, { topic, details, enthusiasm }, evidence) {
  topic = str(topic, 'topic', 120)
  const key = topic.normalize('NFKC').toLowerCase()
  requireThat(Number.isInteger(enthusiasm) && enthusiasm >= 1 && enthusiasm <= 5, 'enthusiasm 必须为 1–5')
  requireThat(evidence?.text.normalize('NFKC').toLowerCase().includes(key), '需要当前用户真实提及该话题')
  return transaction(db, () => {
    const at = now()
    const context = str(details, 'details')
    db.prepare('INSERT OR IGNORE INTO interests VALUES (?, ?, ?, ?, ?, 0)').run(key, topic, enthusiasm, context, at)
    const inserted = db.prepare('INSERT OR IGNORE INTO interest_mentions VALUES (?, ?, ?)').run(key, scope, evidence.id)
    if (inserted.changes) db.prepare('UPDATE interests SET enthusiasm=?, context=?, last_mentioned=?, mention_count=mention_count+1 WHERE topic_key=?')
      .run(enthusiasm, context, at, key)
    const result = db.prepare('SELECT topic, enthusiasm, context, last_mentioned, mention_count FROM interests WHERE topic_key=?').get(key)
    return { ...result, suggest_promotion: result.mention_count >= 3 && result.enthusiasm >= 4 }
  })
}
