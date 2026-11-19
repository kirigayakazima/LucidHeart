import { requireThat, str } from './db.js'

export function goalPolicy({ maxSteps = 100, maxAutonomousNudges = 2, deadlineAt = null,
  stopCondition = 'user_stop', subgoals = [] } = {}) {
  requireThat(Number.isSafeInteger(maxSteps) && maxSteps >= 1 && maxSteps <= 1000 &&
    Number.isSafeInteger(maxAutonomousNudges) && maxAutonomousNudges >= 0 && maxAutonomousNudges <= 6 &&
    (deadlineAt === null || Number.isSafeInteger(deadlineAt)) && Array.isArray(subgoals) && subgoals.length <= 50,
  '目标预算或子目标无效')
  return { maxSteps, maxAutonomousNudges, deadlineAt, stopCondition: str(stopCondition, '停止条件'),
    subgoals: subgoals.map((title, index) => ({ index: index + 1, title: str(title, '子目标'), done: false })),
    steps: 0, nudges: 0, reason: null }
}

export function stopReason(control, now, observedCondition) {
  if (observedCondition && observedCondition === control.stopCondition) return 'stop_condition'
  return control.reason || (control.deadlineAt !== null && now >= control.deadlineAt ? 'deadline' :
    control.steps >= control.maxSteps ? 'step_budget' : control.nudges >= control.maxAutonomousNudges ? 'nudge_budget' : null)
}

export function advanceGoal(control, { nudge = false, completeSubgoal = false } = {}) {
  const next = structuredClone(control)
  if (nudge) next.nudges++
  else next.steps++
  if (completeSubgoal) {
    const item = next.subgoals.find(item => !item.done)
    if (item) item.done = true
  }
  return next
}
