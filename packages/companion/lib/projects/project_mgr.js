import { randomUUID } from 'node:crypto'
import { json, requireThat, str, transaction } from '../db.js'

export const projectSchema = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, name TEXT NOT NULL, goal TEXT NOT NULL, milestones_json TEXT NOT NULL,
  current_step INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS project_logs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), note TEXT NOT NULL,
  progress_delta INTEGER NOT NULL, created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS project_log ON project_logs(project_id, created_at);
`

export function projectManager(db, now) {
  function status(scope, id) {
    const row = db.prepare('SELECT * FROM projects WHERE scope=? AND id=?').get(scope, str(id, 'project_id'))
    requireThat(row, '找不到项目')
    const { milestones_json, ...project } = row
    const milestones = JSON.parse(milestones_json)
    return { ...project, milestones, remaining: milestones.filter(item => !item.done),
      logs: db.prepare('SELECT * FROM project_logs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id) }
  }
  return {
    status,
    create(scope, { name, goal, milestones }) {
      requireThat(Array.isArray(milestones) && milestones.length >= 1 && milestones.length <= 50, '需要 1–50 个里程碑')
      const plan = milestones.map((text, index) => ({ index: index + 1, text: str(text, '里程碑'), done: false }))
      const at = now()
      const id = randomUUID()
      db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?, 1, 'in_progress', ?, ?)")
        .run(id, scope, str(name, 'name'), str(goal, 'goal'), json(plan), at, at)
      return status(scope, id)
    },
    checkin(scope, { project_id: id, note, milestone_index_done: index }) {
      return transaction(db, () => {
        const project = status(scope, id)
        const at = now()
        let delta = 0
        if (index !== undefined) {
          const item = project.milestones.find(m => m.index === index)
          requireThat(item, '里程碑序号无效')
          if (!item.done) {
            Object.assign(item, { done: true, done_at: at })
            delta = 1
          }
        }
        const next = project.milestones.find(item => !item.done)
        db.prepare('UPDATE projects SET milestones_json=?, current_step=?, status=?, updated_at=? WHERE id=?')
          .run(json(project.milestones), next?.index ?? project.milestones.length + 1, next ? 'in_progress' : 'completed', at, id)
        db.prepare('INSERT INTO project_logs VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, str(note, 'note'), delta, at)
        return status(scope, id)
      })
    },
  }
}
