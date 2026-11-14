import { randomUUID } from 'node:crypto'
import { json, requireThat, str, transaction } from '../db.js'

export const dayMs = 86_400_000
export const taskSchema = `
CREATE TABLE IF NOT EXISTS async_tasks (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL, status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100), idempotency_key TEXT UNIQUE,
  payload_json TEXT, result_json TEXT, error_message TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS task_expiry ON async_tasks(status, expires_at);
`

const transitions = {
  pending: ['processing', 'failed'],
  processing: ['processing', 'completed', 'failed'],
  completed: ['delivered', 'failed'],
  delivered: [],
  failed: [],
}

function decode(row) {
  if (!row) return null
  const { payload_json, result_json, ...task } = row
  return { ...task, payload: JSON.parse(payload_json), result: JSON.parse(result_json) }
}

export function taskLedger(db, now) {
  const get = id => decode(db.prepare('SELECT * FROM async_tasks WHERE id=?').get(str(id, 'task_id')))
  function recoverStale() {
    const at = now()
    return db.prepare(`UPDATE async_tasks SET status='failed', error_message='host_restarted', updated_at=?
      WHERE status='processing' AND expires_at<=?`).run(at, at).changes
  }
  return {
    get, recoverStale,
    active(target) {
      return db.prepare(`SELECT * FROM async_tasks WHERE target=? AND expires_at>?
        AND status IN ('pending','processing','completed') ORDER BY updated_at DESC,id LIMIT 100`)
        .all(str(target, 'target'), now()).map(decode)
    },
    create(kind, key, target, payload = null, ttl = dayMs) {
      kind = str(kind, 'kind', 80)
      key = key == null ? null : str(key, 'idempotency_key', 500)
      target = str(target, 'target')
      requireThat(Number.isSafeInteger(ttl) && ttl > 0 && ttl <= 30 * dayMs, '任务有效期无效')
      const encoded = json(payload)
      return transaction(db, () => {
        const at = now()
        if (key !== null) {
          const existing = db.prepare('SELECT * FROM async_tasks WHERE idempotency_key=?').get(key)
          if (existing && existing.expires_at > at) {
            requireThat(existing.target === target && existing.kind === kind && existing.payload_json === encoded, '幂等键与现有任务冲突')
            return decode(existing)
          }
          if (existing) {
            db.prepare(`UPDATE async_tasks SET idempotency_key=NULL,
              status=CASE WHEN status IN ('pending','processing') THEN 'failed' ELSE status END,
              error_message=CASE WHEN status IN ('pending','processing') THEN 'expired' ELSE error_message END
              WHERE id=?`).run(existing.id)
          }
        }
        const id = 'task_' + randomUUID()
        db.prepare(`INSERT INTO async_tasks VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, ?, ?, ?)`)
          .run(id, kind, target, key, encoded, at, at, at + ttl)
        return get(id)
      })
    },
    update(id, status, progress, { result, error } = {}) {
      return transaction(db, () => {
        const task = get(id)
        requireThat(task, '找不到任务')
        const at = now()
        if (status === task.status && status !== 'processing') return task
        requireThat(transitions[task.status].includes(status), '任务状态迁移不合法')
        requireThat(task.expires_at > at || status === 'failed', '任务已过期')
        const value = ['completed', 'delivered'].includes(status) ? 100 : (progress ?? task.progress)
        requireThat(Number.isInteger(value) && value >= task.progress && value <= 100, '任务进度必须单调递增且不超过 100')
        db.prepare('UPDATE async_tasks SET status=?, progress=?, result_json=?, error_message=?, updated_at=? WHERE id=?')
          .run(status, value, result === undefined ? json(task.result) : json(result),
            status === 'failed' ? str(error ?? 'task_failed', 'error') : null, at, id)
        return get(id)
      })
    },
  }
}
