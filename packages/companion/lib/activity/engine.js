import { randomUUID } from 'node:crypto'
import { addColumn, json, object, requireThat, str, transaction } from '../db.js'
import { goalPolicy, stopReason, advanceGoal } from '../goal_policy.js'

export const activitySchema = `
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','aborted','stopped')),
  state_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS active_activity ON activities(scope) WHERE status='active';
`

const decode = row => {
  if (!row) return null
  const { state_json, ...activity } = row
  return { ...activity, state: JSON.parse(state_json) }
}

export function activityEngine(db, now) {
  const oldSchema = db.prepare("SELECT sql FROM sqlite_master WHERE name='activities'").get().sql
  if (!oldSchema.includes("'stopped'")) transaction(db, () => {
    db.exec('DROP INDEX active_activity; ALTER TABLE activities RENAME TO activities_legacy;')
    db.exec(activitySchema)
    db.exec('INSERT INTO activities SELECT * FROM activities_legacy; DROP TABLE activities_legacy;')
  })
  addColumn(db, 'activities', 'control_json', "TEXT NOT NULL DEFAULT '{}'")
  const decodeRow = row => row ? { ...decode(row), control: { ...goalPolicy(), ...JSON.parse(row.control_json) } } : null
  const get = (scope, id) => {
    const row = decodeRow(db.prepare('SELECT * FROM activities WHERE scope=? AND id=?').get(scope, id))
    if (row && ['active', 'paused'].includes(row.status) && stopReason(row.control, now())) {
      row.control.reason = stopReason(row.control, now())
      db.prepare("UPDATE activities SET status='stopped',control_json=?,completed_at=? WHERE id=?").run(json(row.control), now(), id)
      row.status = 'stopped'
    }
    return row
  }
  const active = scope => {
    const row = db.prepare("SELECT id FROM activities WHERE scope=? AND status='active'").get(scope)
    const activity = row && get(scope, row.id)
    return activity?.status === 'active' ? activity : null
  }
  function save(activity, state, status) {
    const at = now()
    const completed = ['completed', 'aborted'].includes(status) ? at : null
    db.prepare('UPDATE activities SET state_json=?, status=?, updated_at=?, completed_at=? WHERE id=?')
      .run(json(state), status, at, completed, activity.id)
    return get(activity.scope, activity.id)
  }
  return {
    active, get,
    peekActive(scope) {
      const row = db.prepare("SELECT type, created_at, updated_at, control_json FROM activities WHERE scope=? AND status='active'").get(scope)
      if (!row) return null
      const { control_json, ...activity } = row
      return stopReason({ ...goalPolicy(), ...JSON.parse(control_json) }, now()) ? null : activity
    },
    start(scope, { type, title, budget }, state = { round: 0 }) {
      return transaction(db, () => {
        requireThat(!active(scope), '请先暂停或结束当前活动')
        const at = now()
        const id = randomUUID()
        db.prepare('INSERT INTO activities (id,scope,type,title,status,state_json,created_at,updated_at,completed_at,control_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)')
          .run(id, scope, str(type, 'type', 60), str(title, 'title'), 'active', json(state), at, at, json(goalPolicy(budget)))
        return get(scope, id)
      })
    },
    change(scope, id, action, args = {}) {
      get(scope, id) // Expiry is durable even when the requested transition is refused.
      return transaction(db, () => {
        const activity = get(scope, str(id, 'id'))
        requireThat(activity, '找不到活动')
        const { state, status } = activity
        if (['active', 'paused'].includes(status) && stopReason(activity.control, now(), args.observedCondition) === 'stop_condition') {
          activity.control.reason = 'stop_condition'
          db.prepare('UPDATE activities SET control_json=? WHERE id=?').run(json(activity.control), id)
          return save(activity, state, 'stopped')
        }
        if (action === 'stop') {
          requireThat(['active', 'paused'].includes(status), '活动已结束')
          activity.control.reason = 'user_stop'
          db.prepare('UPDATE activities SET control_json=? WHERE id=?').run(json(activity.control), id)
          return save(activity, state, 'stopped')
        }
        if (action === 'abort') {
          requireThat(['active', 'paused'].includes(status), '活动已结束')
          return save(activity, { ...state, reason: str(args.reason, 'reason') }, 'aborted')
        }
        if (action === 'resume') {
          requireThat(status === 'paused' && !active(scope), '需要暂停的活动和空闲会话')
          return save(activity, state, 'active')
        }
        requireThat(status === 'active', '活动必须处于进行中')
        if (action === 'pause') return save(activity, { ...state, pause_reason: str(args.reason, 'reason') }, 'paused')
        requireThat(activity.type !== 'game', '游戏状态只能由游戏工具结算')
        if (action === 'finish') return save(activity, { ...state, summary: str(args.summary, 'summary'),
          outcome: args.outcome ?? null }, 'completed')
        requireThat(action === 'step', '未知活动操作')
        const control = advanceGoal(activity.control, { completeSubgoal: args.completeSubgoal === true })
        db.prepare('UPDATE activities SET control_json=? WHERE id=?').run(json(control), id)
        return save(activity, { ...state, ...object(args.delta_state ?? {}), round: (state.round ?? 0) + 1,
          action_summary: str(args.action_summary, 'action_summary') },
        control.subgoals.length && control.subgoals.every(item => item.done) ? 'completed' : 'active')
      })
    },
    game(scope, transition) {
      const current = active(scope)
      requireThat(current, '当前没有进行中的游戏')
      return transaction(db, () => {
        const activity = active(scope)
        requireThat(activity?.type === 'game', '当前没有进行中的游戏')
        const { state, done = false, status = 'completed', feedback } = transition(activity.state)
        db.prepare('UPDATE activities SET control_json=? WHERE id=?').run(json(advanceGoal(activity.control)), activity.id)
        return { ...save(activity, state, done ? status : 'active'), feedback }
      })
    },
  }
}
