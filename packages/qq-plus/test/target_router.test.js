import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTargetRouter } from '../lib/target_router.js'

test('TargetRouter: isolates concurrent C2C and Group media routes', () => {
  const router = createTargetRouter()

  const c2cRoute = router.createRoute({
    sessionId: 'session_c2c_001',
    scope: 'c2c',
    targetId: 'user_alice',
    mediaType: 'voice',
  })

  const groupRoute = router.createRoute({
    sessionId: 'session_grp_002',
    scope: 'group',
    targetId: 'group_rock_fans',
    mediaType: 'song',
  })

  assert.equal(router.activeRouteCount, 2)

  // Validate dispatch targets strictly match
  const c2cValid = router.validateDispatch(c2cRoute.routeId, { scope: 'c2c', targetId: 'user_alice' })
  assert.equal(c2cValid.allowed, true)

  // Accidental cross-talk attempt: dispatching C2C route to Group
  const crosstalkAttempt = router.validateDispatch(c2cRoute.routeId, { scope: 'group', targetId: 'group_rock_fans' })
  assert.equal(crosstalkAttempt.allowed, false)
  assert.equal(crosstalkAttempt.reason, 'TARGET_MISMATCH')

  // Group dispatch to Group valid
  const grpValid = router.validateDispatch(groupRoute.routeId, { scope: 'group', targetId: 'group_rock_fans' })
  assert.equal(grpValid.allowed, true)

  router.dispose()
})

test('TargetRouter: cancelSession terminates only correlated in-flight routes without leaking to other sessions', () => {
  const router = createTargetRouter()

  const r1 = router.createRoute({ sessionId: 'session_A', scope: 'c2c', targetId: 'user_alice' })
  const r2 = router.createRoute({ sessionId: 'session_A', scope: 'c2c', targetId: 'user_alice' })
  const r3 = router.createRoute({ sessionId: 'session_B', scope: 'group', targetId: 'group_dev' })

  let abortedCount = 0
  r1.signal.addEventListener('abort', () => abortedCount++)
  r2.signal.addEventListener('abort', () => abortedCount++)
  r3.signal.addEventListener('abort', () => abortedCount++)

  // Cancel session A only
  const cancelledCount = router.cancelSession('session_A', 'User switched conversation')
  assert.equal(cancelledCount, 2)
  assert.equal(abortedCount, 2)
  assert.equal(r1.signal.aborted, true)
  assert.equal(r2.signal.aborted, true)
  assert.equal(r3.signal.aborted, false)

  // Validating cancelled route fails
  const valCancelled = router.validateDispatch(r1.routeId, { scope: 'c2c', targetId: 'user_alice' })
  assert.equal(valCancelled.allowed, false)
  assert.equal(valCancelled.reason, 'ROUTE_CANCELLED')

  // Session B still intact and dispatchable
  const valIntact = router.validateDispatch(r3.routeId, { scope: 'group', targetId: 'group_dev' })
  assert.equal(valIntact.allowed, true)

  router.dispose()
})

test('TargetRouter: tracks unconfirmed delivery status for reconciliation', () => {
  const router = createTargetRouter()

  const route = router.createRoute({ sessionId: 'session_X', scope: 'c2c', targetId: 'user_bob' })
  router.markInFlight(route.routeId)
  assert.equal(router.getRoute(route.routeId).status, 'in_flight')

  // Ambiguous delivery outcome (socket reset / timeout)
  router.markUnconfirmed(route.routeId, new Error('ECONNRESET while uploading voice attachment'))
  const state = router.getRoute(route.routeId)
  assert.equal(state.status, 'unconfirmed')
  assert.match(state.error, /ECONNRESET/)

  router.dispose()
})

test('TargetRouter: dispose cleans up all active routes with cancellation signals', () => {
  const router = createTargetRouter()
  const r = router.createRoute({ sessionId: 'session_Z', scope: 'group', targetId: 'grp_test' })

  let aborted = false
  r.signal.addEventListener('abort', () => { aborted = true })

  router.dispose()
  assert.equal(aborted, true)
  assert.equal(router.activeRouteCount, 0)
})
