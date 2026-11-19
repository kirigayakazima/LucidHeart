import { randomUUID } from 'node:crypto'
import { json, requireThat, transaction } from './db.js'

export const strategySchema = `CREATE TABLE IF NOT EXISTS strategy_runs (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, parameters TEXT NOT NULL, trace TEXT NOT NULL
) STRICT;`

/** A deterministic resource environment owns the feedback; a proposed success is never accepted. */
export function resourceRound({ stock, cost }, action) {
  requireThat([stock, cost, action].every(Number.isSafeInteger) && stock >= 0 && cost > 0 && action >= 0, '资源回合无效')
  return { success: action >= cost && action <= stock, cost, stockAfter: action >= cost && action <= stock ? stock - action : stock }
}

export function strategyLoop(db) {
  const read = (scope, id) => {
    const row = db.prepare('SELECT * FROM strategy_runs WHERE scope=? AND id=?').get(scope, id)
    requireThat(row, '找不到策略实验')
    return { id, scope, parameters: JSON.parse(row.parameters), trace: JSON.parse(row.trace) }
  }
  return {
    read,
    start(scope, { estimatedCost = 1 } = {}) {
      requireThat(Number.isSafeInteger(estimatedCost) && estimatedCost > 0 && estimatedCost <= 100, '成本估计无效')
      const id = randomUUID()
      db.prepare('INSERT INTO strategy_runs VALUES (?,?,?,?)').run(id, scope, json({ estimatedCost }), '[]')
      return read(scope, id)
    },
    step(scope, id, environment) {
      return transaction(db, () => {
        const run = read(scope, id)
        requireThat(run.trace.length < 50, '实验预算耗尽')
        const action = run.parameters.estimatedCost
        const expectation = { success: environment.stock >= action }
        const observation = resourceRound(environment, action)
        const mismatch = expectation.success !== observation.success
        const revision = mismatch ? { estimatedCost: observation.cost } : null
        run.trace.push({ expectation, action, observation, mismatch, revision })
        if (revision) run.parameters = revision
        db.prepare('UPDATE strategy_runs SET parameters=?,trace=? WHERE id=?').run(json(run.parameters), json(run.trace), id)
        return read(scope, id)
      })
    },
  }
}
