import { randomUUID } from 'node:crypto'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { requireThat, str, transaction } from '../db.js'

export const jukeboxSchema = `
CREATE TABLE IF NOT EXISTS playlist (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, artist TEXT NOT NULL, style TEXT,
  preferred_pitch INTEGER NOT NULL CHECK(preferred_pitch IN (0,-4)), source_url TEXT,
  created_at INTEGER NOT NULL, UNIQUE(title,artist,preferred_pitch)
) STRICT;
CREATE TABLE IF NOT EXISTS queue (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, song_id TEXT NOT NULL REFERENCES playlist(id),
  requester TEXT NOT NULL, status TEXT NOT NULL, rvc_task_id TEXT, output_path TEXT, task_id TEXT,
  position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_synthesis ON queue(status) WHERE status='synthesizing';
CREATE INDEX IF NOT EXISTS queue_scope ON queue(scope,status,position);
`

async function hasMp3(file) {
  const handle = await open(file, 'r').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return false
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size < 128) return false
    const bytes = Buffer.alloc(3)
    await handle.read(bytes)
    return bytes.toString() === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  } finally {
    await handle.close()
  }
}

export function jukebox(db, tasks, now, dispatch) {
  const joined = 'SELECT q.*, p.title, p.artist, p.preferred_pitch FROM queue q JOIN playlist p ON p.id=q.song_id'
  const find = id => db.prepare(joined + ' WHERE q.id=?').get(id)
  async function reconcile() {
    const job = db.prepare("SELECT * FROM queue WHERE status='synthesizing'").get()
    if (!job) return
    if (!job.output_path && now() - job.updated_at < 120_000) return
    const artifact = job.output_path && await hasMp3(job.output_path)
    const task = job.task_id && tasks.get(job.task_id)
    if (!artifact && task?.status !== 'failed' && now() - job.updated_at < 30 * 60_000 && job.output_path) return
    transaction(db, () => {
      const current = find(job.id)
      if (current.status !== 'synthesizing' || current.updated_at !== job.updated_at || current.output_path !== job.output_path) return
      const ledger = job.task_id && tasks.get(job.task_id)
      const ready = artifact && ledger?.status !== 'failed'
      const error = ready ? null : (ledger?.error_message ?? (job.output_path ? 'synthesis_timeout' : 'dispatch_unconfirmed'))
      if (ledger?.status === 'processing') {
        tasks.update(job.task_id, ready ? 'completed' : 'failed', undefined,
          ready ? { result: { output_path: job.output_path, rvc_task_id: job.rvc_task_id } } : { error })
      }
      db.prepare('UPDATE queue SET status=?, updated_at=?, error=? WHERE id=?')
        .run(ready ? 'ready' : 'failed', now(), error, job.id)
    })
  }
  async function advance(scope, exec) {
    await reconcile()
    const row = transaction(db, () => {
      if (db.prepare("SELECT 1 FROM queue WHERE status='synthesizing'").get()) return null
      const pending = db.prepare(joined + " WHERE q.scope=? AND q.status='queued' ORDER BY q.position LIMIT 1").get(scope)
      if (!pending) return null
      exec?.signal?.throwIfAborted()
      const task = tasks.create('singing', 'jukebox:' + pending.id, scope, { queue_id: pending.id, title: pending.title })
      // A surviving task without a queue claim has not yet been dispatched.
      if (task.status === 'pending') tasks.update(task.id, 'processing', 0)
      requireThat(['pending', 'processing'].includes(task.status), '点歌任务已经结算')
      db.prepare("UPDATE queue SET status='synthesizing', task_id=?, updated_at=? WHERE id=?").run(task.id, now(), pending.id)
      return { ...pending, task_id: task.id }
    })
    if (!row) return null
    try {
      const receipt = await dispatch(row, exec)
      requireThat(receipt?.ok && typeof receipt.job_id === 'string' && /^[\w-]+$/.test(receipt.job_id) &&
        typeof receipt.expected_output === 'string' && path.isAbsolute(receipt.expected_output) &&
        path.basename(receipt.expected_output) === `song_${receipt.job_id}.mp3`,
        'RVC 未接受点歌任务')
      db.prepare('UPDATE queue SET rvc_task_id=?, output_path=?, updated_at=? WHERE id=? AND status=?')
        .run(receipt.job_id, receipt.expected_output, now(), row.id, 'synthesizing')
    } catch {
      transaction(db, () => {
        if (find(row.id).status !== 'synthesizing') return
        tasks.update(row.task_id, 'failed', undefined, { error: 'rvc_dispatch_failed' })
        db.prepare("UPDATE queue SET status='failed', error='rvc_dispatch_failed', updated_at=? WHERE id=?").run(now(), row.id)
      })
    }
    return find(row.id)
  }
  return {
    async add(scope, { title, artist = '', pitch = 0, requester = 'user' }, exec) {
      title = str(title, 'title', 160)
      artist = artist === '' ? '' : str(artist, 'artist', 120)
      requireThat([0, -4].includes(pitch), '音高只能是 0 或 -4')
      requireThat(['user', 'xiaoman'].includes(requester), '点歌来源无效')
      const id = transaction(db, () => {
        const at = now()
        db.prepare('INSERT OR IGNORE INTO playlist VALUES (?, ?, ?, NULL, ?, NULL, ?)').run(randomUUID(), title, artist, pitch, at)
        const song = db.prepare('SELECT id FROM playlist WHERE title=? AND artist=? AND preferred_pitch=?').get(title, artist, pitch)
        const id = randomUUID()
        db.prepare(`INSERT INTO queue VALUES (?, ?, ?, ?, 'queued', NULL, NULL, NULL,
          (SELECT coalesce(max(position),0)+1 FROM queue), ?, ?, NULL)`).run(id, scope, song.id, requester, at, at)
        return id
      })
      await advance(scope, exec)
      return find(id)
    },
    async next(scope, exec) {
      await reconcile()
      const previous = transaction(db, () => {
        const ready = db.prepare("SELECT * FROM queue WHERE scope=? AND status='ready' ORDER BY position LIMIT 1").get(scope)
        if (!ready) return null
        db.prepare("UPDATE queue SET status='played', updated_at=? WHERE id=?").run(now(), ready.id)
        return find(ready.id)
      })
      return { previous, next: await advance(scope, exec) }
    },
    async list(scope) {
      await reconcile()
      return {
        playlist: db.prepare('SELECT * FROM playlist ORDER BY title,artist LIMIT 100').all(),
        queue: db.prepare(joined + " WHERE q.scope=? AND q.status IN ('queued','synthesizing','ready') ORDER BY q.position LIMIT 100").all(scope),
      }
    },
    async history(scope, limit = 20) {
      requireThat(Number.isInteger(limit) && limit >= 1 && limit <= 100, 'limit 必须为 1–100')
      await reconcile()
      return db.prepare(joined + " WHERE q.scope=? AND q.status IN ('ready','played') ORDER BY q.position DESC LIMIT ?").all(scope, limit)
    },
  }
}
