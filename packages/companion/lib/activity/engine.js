import { randomUUID } from 'node:crypto'
import { json, object, requireThat, str, transaction } from '../db.js'

export const activitySchema = `
CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','completed','aborted')),
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
  const active = scope => decode(db.prepare("SELECT * FROM activities WHERE scope=? AND status='active'").get(scope))
  const get = (scope, id) => decode(db.prepare('SELECT * FROM activities WHERE scope=? AND id=?').get(scope, id))
  function save(activity, state, status) {
    const at = now()
    const completed = ['completed', 'aborted'].includes(status) ? at : null
    db.prepare('UPDATE activities SET state_json=?, status=?, updated_at=?, completed_at=? WHERE id=?')
      .run(json(state), status, at, completed, activity.id)
    return get(activity.scope, activity.id)
  }
  return {
    active, get,
    start(scope, { type, title }, state = { round: 0 }) {
      return transaction(db, () => {
        requireThat(!active(scope), '请先暂停或结束当前活动')
        const at = now()
        const id = randomUUID()
        db.prepare('INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)')
          .run(id, scope, str(type, 'type', 60), str(title, 'title'), 'active', json(state), at, at)
        return get(scope, id)
      })
    },
    change(scope, id, action, args = {}) {
      return transaction(db, () => {
        const activity = get(scope, str(id, 'id'))
        requireThat(activity, '找不到活动')
        const { state, status } = activity
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
        return save(activity, { ...state, ...object(args.delta_state ?? {}), round: (state.round ?? 0) + 1,
          action_summary: str(args.action_summary, 'action_summary') }, 'active')
      })
    },
    game(scope, transition) {
      return transaction(db, () => {
        const activity = active(scope)
        requireThat(activity?.type === 'game', '当前没有进行中的游戏')
        const { state, done = false, status = 'completed', feedback } = transition(activity.state)
        return { ...save(activity, state, done ? status : 'active'), feedback }
      })
    },
  }
}
