import { randomUUID } from 'node:crypto'
import { addColumn, json, requireThat, str, transaction } from '../db.js'
import { goalPolicy, stopReason, advanceGoal } from '../goal_policy.js'

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
  addColumn(db, 'projects', 'control_json', "TEXT NOT NULL DEFAULT '{}'")
  function status(scope, id) {
    const row = db.prepare('SELECT * FROM projects WHERE scope=? AND id=?').get(scope, str(id, 'project_id'))
    requireThat(row, '找不到项目')
    const { milestones_json, control_json, ...project } = row
    const control = { ...goalPolicy(), ...JSON.parse(control_json) }
    if (project.status === 'in_progress' && stopReason(control, now())) {
      control.reason = stopReason(control, now())
      db.prepare("UPDATE projects SET status='stopped', control_json=?, updated_at=? WHERE id=?").run(json(control), now(), id)
      project.status = 'stopped'
    }
    const milestones = JSON.parse(milestones_json)
    return { ...project, control, milestones, remaining: milestones.filter(item => !item.done),
      logs: db.prepare('SELECT * FROM project_logs WHERE project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id) }
  }
  return {
    status,
    create(scope, { name, goal, milestones, budget }) {
      requireThat(Array.isArray(milestones) && milestones.length >= 1 && milestones.length <= 50, '需要 1–50 个里程碑')
      const plan = milestones.map((text, index) => ({ index: index + 1, text: str(text, '里程碑'), done: false }))
      const at = now()
      const id = randomUUID()
      db.prepare("INSERT INTO projects (id,scope,name,goal,milestones_json,current_step,status,created_at,updated_at,control_json) VALUES (?, ?, ?, ?, ?, 1, 'in_progress', ?, ?, ?)")
        .run(id, scope, str(name, 'name'), str(goal, 'goal'), json(plan), at, at, json(goalPolicy({ ...budget, subgoals: milestones })))
      return status(scope, id)
    },
    checkin(scope, { project_id: id, note, milestone_index_done: index, observedCondition }) {
      const current = status(scope, id)
      if (observedCondition && stopReason(current.control, now(), observedCondition) === 'stop_condition') {
        return this.stop(scope, id, 'stop_condition')
      }
      requireThat(current.status === 'in_progress' || (current.status === 'completed' &&
        current.milestones.some(item => item.index === index && item.done)), '项目已停止或完成')
      return transaction(db, () => {
        const project = status(scope, id)
        requireThat(project.status === 'in_progress' || (project.status === 'completed' &&
          project.milestones.some(item => item.index === index && item.done)), '项目已停止或完成')
        const at = now()
        let delta = 0
        if (index !== undefined) {
          const item = project.milestones.find(m => m.index === index)
          requireThat(item, '里程碑序号无效')
          requireThat(item.done || index === project.milestones.find(m => !m.done)?.index, '请按顺序完成子目标')
          if (!item.done) {
            Object.assign(item, { done: true, done_at: at })
            delta = 1
          }
        }
        const next = project.milestones.find(item => !item.done)
        const control = project.status === 'completed' ? project.control : advanceGoal(project.control, { completeSubgoal: delta > 0 })
        db.prepare('UPDATE projects SET control_json=? WHERE id=?').run(json(control), id)
        db.prepare('UPDATE projects SET milestones_json=?, current_step=?, status=?, updated_at=? WHERE id=?')
          .run(json(project.milestones), next?.index ?? project.milestones.length + 1, next ? 'in_progress' : 'completed', at, id)
        db.prepare('INSERT INTO project_logs VALUES (?, ?, ?, ?, ?)').run(randomUUID(), id, str(note, 'note'), delta, at)
        return status(scope, id)
      })
    },
    stop(scope, id, reason = 'user_stop') {
      const project = status(scope, id)
      if (project.status !== 'in_progress') return project
      project.control.reason = str(reason, '停止原因')
      db.prepare("UPDATE projects SET status='stopped',control_json=?,updated_at=? WHERE id=?").run(json(project.control), now(), id)
      return status(scope, id)
    },
    replan(scope, id, subgoals) {
      const project = status(scope, id)
      requireThat(project.status === 'in_progress', '项目已停止或完成')
      const control = { ...project.control, subgoals: goalPolicy({ subgoals }).subgoals }
      requireThat(subgoals.length > 0, '需要子目标')
      db.prepare('UPDATE projects SET milestones_json=?,current_step=1,control_json=?,updated_at=? WHERE id=?')
        .run(json(subgoals.map((text, index) => ({ index: index + 1, text, done: false }))), json(control), now(), id)
      return status(scope, id)
    },
    active(scope) {
      return db.prepare("SELECT id FROM projects WHERE scope=? AND status='in_progress' ORDER BY updated_at,id").all(scope)
        .map(row => status(scope, row.id)).filter(row => row.status === 'in_progress')
    },
    nudge(scope, id) {
      const project = status(scope, id)
      if (project.status !== 'in_progress') return null
      const control = advanceGoal(project.control, { nudge: true })
      db.prepare('UPDATE projects SET control_json=?,updated_at=? WHERE id=?').run(json(control), now(), id)
      return { id, subgoal: project.milestones.find(item => !item.done)?.text }
    },
  }
}
