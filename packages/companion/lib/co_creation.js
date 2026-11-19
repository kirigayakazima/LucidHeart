import { randomUUID } from 'node:crypto'
import { requireThat, str, transaction } from './db.js'

export const creationSchema = `
CREATE TABLE IF NOT EXISTS creations (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS creation_versions (
 id TEXT NOT NULL REFERENCES creations(id), version INTEGER NOT NULL, parent INTEGER,
 status TEXT NOT NULL, content TEXT NOT NULL, author TEXT NOT NULL, created_at INTEGER NOT NULL,
 PRIMARY KEY(id,version)
) STRICT;
CREATE TABLE IF NOT EXISTS programs (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES creations(id),
 artifact_version INTEGER NOT NULL, status TEXT NOT NULL, offered_at INTEGER, cooldown_until INTEGER,
 response_id TEXT, UNIQUE(artifact_id,artifact_version)
) STRICT;`

export function coCreation(db, now) {
  const get = (scope, id) => {
    const row = db.prepare('SELECT * FROM creations WHERE id=? AND scope=?').get(id, scope)
    requireThat(row, '找不到共创产物')
    return { ...row, history: db.prepare('SELECT * FROM creation_versions WHERE id=? ORDER BY version').all(id) }
  }
  const program = (scope, id) => {
    const row = db.prepare('SELECT * FROM programs WHERE id=? AND scope=?').get(id, scope)
    requireThat(row, '找不到准备好的节目')
    return row
  }
  return {
    get,
    draft(scope, { content, author = 'xiaoman' }) {
      return transaction(db, () => {
        const id = randomUUID()
        db.prepare("INSERT INTO creations VALUES (?,?,1,'draft')").run(id, scope)
        db.prepare("INSERT INTO creation_versions VALUES (?,1,NULL,'draft',?,?,?)")
          .run(id, str(content, '草稿', 8000), str(author, '作者', 80), now())
        return get(scope, id)
      })
    },
    revise(scope, { id, expectedVersion, content, finalized = false, author = 'xiaoman' }) {
      return transaction(db, () => {
        const row = get(scope, id)
        requireThat(row.status !== 'finalized' && row.version === expectedVersion, '产物已定稿或版本冲突')
        const version = row.version + 1, status = finalized ? 'finalized' : 'revision'
        db.prepare('INSERT INTO creation_versions VALUES (?,?,?,?,?,?,?)')
          .run(id, version, row.version, status, str(content, '内容', 8000), str(author, '作者', 80), now())
        db.prepare('UPDATE creations SET version=?,status=? WHERE id=?').run(version, status, id)
        return get(scope, id)
      })
    },
    prepare(scope, artifactId) {
      return transaction(db, () => {
        const row = get(scope, artifactId)
        requireThat(row.status === 'finalized', '节目需先定稿准备完毕')
        const existing = db.prepare('SELECT id FROM programs WHERE artifact_id=? AND artifact_version=?').get(row.id, row.version)
        if (existing) return program(scope, existing.id)
        const id = randomUUID()
        db.prepare("INSERT INTO programs VALUES (?,?,?,?,'ready',NULL,NULL,NULL)").run(id, scope, row.id, row.version)
        return program(scope, id)
      })
    },
    offer(scope, id) {
      return transaction(db, () => {
        const row = program(scope, id)
        const cooling = db.prepare('SELECT 1 FROM programs WHERE scope=? AND cooldown_until>?').get(scope, now())
        requireThat(row.status === 'ready' && !cooling, '节目邀请已使用或仍在冷却')
        db.prepare("UPDATE programs SET status='offered',offered_at=? WHERE id=?").run(now(), id)
        return { ...program(scope, id), invitation: '我准备了一个小节目，现在想一起看看吗？', executionAllowed: false }
      })
    },
    respond(scope, id, evidence) {
      return transaction(db, () => {
        const row = program(scope, id)
        requireThat(row.status === 'offered' && evidence?.id && evidence?.text, '需要真实用户回应')
        const declined = /不用|不了|不想|算了|下次|改天|不要|先忙/u.test(evidence.text)
        const accepted = !declined && /好呀|好啊|可以|想看|开始吧|来吧|一起看/u.test(evidence.text)
        requireThat(declined || accepted, '回应尚不明确，保持等待')
        db.prepare('UPDATE programs SET status=?,cooldown_until=?,response_id=? WHERE id=?')
          .run(declined ? 'declined' : 'accepted', declined ? now() + 86_400_000 : null, evidence.id, id)
        return { ...program(scope, id), executionAllowed: accepted }
      })
    },
  }
}
