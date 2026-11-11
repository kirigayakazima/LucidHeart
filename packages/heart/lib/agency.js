/** Discrete, side-effect-free scoring. State describes the selected response, not delivery. */
export const AGENCY_STATES = Object.freeze({
  SLEEPING: 'SLEEPING',
  IDLE: 'IDLE',
  OBSERVING: 'OBSERVING',
  ENGAGED: 'ENGAGED',
})

export const AGENCY_ACTIONS = Object.freeze({
  SILENCE: 'SILENCE',
  OBSERVE_MORE: 'OBSERVE_MORE',
  MICRO_GESTURE: 'MICRO_GESTURE',
  SPEAK: 'SPEAK',
})

const { SLEEPING, IDLE, OBSERVING, ENGAGED } = AGENCY_STATES
const { SILENCE, OBSERVE_MORE, MICRO_GESTURE, SPEAK } = AGENCY_ACTIONS

function score(action, interest, contextFit, fatigue, disruption) {
  return { action, interest, contextFit, fatigue, disruption, score: 2 * interest + contextFit - fatigue - disruption }
}

function sceneInterest(change) {
  if (change >= 0.4) return 4
  if (change >= 0.2) return 3
  if (change >= 0.1) return 2
  return 1
}

export class AgencyArbiter {
  #state = IDLE

  evaluate(snapshot = {}, sensorContext = {}) {
    const previousState = this.#state
    const { mood, idle, agency } = snapshot
    const presence = snapshot.presence?.status ?? snapshot.presence
    const cooldownRemainingMs = Math.max(0, Math.ceil(agency?.cooldownRemainingMs || 0))
    const quotaRemaining = Number.isFinite(idle?.totalCap) && Number.isFinite(idle?.totalUsed)
      ? Math.max(0, idle.totalCap - idle.totalUsed - (idle.totalReserved || 0))
      : 0
    const result = (state, action, reason, winner = null, scores = []) => {
      this.#state = state
      return { previousState, state, action, reason, score: winner?.score ?? null, scores, cooldownRemainingMs, quotaRemaining }
    }

    const active = sensorContext.active === true
    const resting = active ? OBSERVING : IDLE
    if (presence === 'asleep') return result(SLEEPING, SILENCE, 'asleep')
    if (agency?.quietHours === true) return result(SLEEPING, SILENCE, 'quiet-hours')
    if (cooldownRemainingMs > 0) return result(resting, SILENCE, 'interrupt-cooldown')
    if (quotaRemaining === 0) return result(resting, SILENCE, 'daily-cap')
    if (!active) return result(IDLE, SILENCE, 'no-active-scene')

    const change = sensorContext.sceneChange
    if (!Number.isFinite(change) || change < 0 || change > 1) {
      return result(OBSERVING, OBSERVE_MORE, 'insufficient-scene-evidence')
    }

    const interest = sceneInterest(change)
    const energy = Number.isFinite(mood?.energy) ? Math.min(1, Math.max(0, mood.energy)) : 0.6
    const fatigue = Math.max(mood?.state === 'tired' ? 3 : 0, Math.round((1 - energy) * 4))
    const present = presence === 'present'
    const contextFit = present ? 3 : 1
    // Ordered conservatively so a tie never upgrades the action.
    const scores = [
      score(SILENCE, fatigue >= 3 ? 4 : 0, 3, 0, 0),
      score(OBSERVE_MORE, Math.min(interest, 2), 2, 0, 0),
    ]
    if (present) {
      scores.push(
        score(MICRO_GESTURE, interest, contextFit, Math.floor(fatigue / 2), 1),
        score(SPEAK, interest === 4 ? 5 : Math.max(0, interest - 1), contextFit, fatigue, 1),
      )
    }
    const winner = scores.reduce((best, candidate) => candidate.score > best.score ? candidate : best)
    const state = [SPEAK, MICRO_GESTURE].includes(winner.action) ? ENGAGED : OBSERVING
    return result(state, winner.action, 'scored', winner, scores)
  }
}
