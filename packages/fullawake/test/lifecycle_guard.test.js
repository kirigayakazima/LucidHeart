import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLifecycleGuard } from '../lib/lifecycle_guard.js'

test('LifecycleGuard: drops late-arriving callbacks across epoch transitions', () => {
  const guard = createLifecycleGuard({ name: 'voice_pipeline' })
  assert.equal(guard.epoch, 1)

  let executedCount = 0
  let staleObserved = null

  // Capture callback in epoch 1
  const epoch1Callback = guard.wrapCallback(
    guard.epoch,
    (result) => { executedCount++; return result },
    (staleInfo) => { staleObserved = staleInfo }
  )

  // Invoke immediately in epoch 1 -> executes
  const res1 = epoch1Callback('ok1')
  assert.equal(res1, 'ok1')
  assert.equal(executedCount, 1)
  assert.equal(staleObserved, null)

  // Now a new turn or cancellation occurs: advance epoch
  guard.nextEpoch()
  assert.equal(guard.epoch, 2)

  // Late arriving callback from epoch 1 fires -> discarded
  const res2 = epoch1Callback('ok2_late')
  assert.equal(res2, undefined)
  assert.equal(executedCount, 1) // Did not increment!
  assert.notEqual(staleObserved, null)
  assert.equal(staleObserved.epoch, 1)
  assert.equal(staleObserved.currentEpoch, 2)

  guard.dispose()
})

test('LifecycleGuard: managed timers and abort controllers are wiped on dispose', async () => {
  const guard = createLifecycleGuard({ name: 'sensory_watch' })

  let timerFired = false
  guard.setTimeout(() => { timerFired = true }, 50)

  const controller = guard.createAbortController()
  assert.equal(controller.signal.aborted, false)

  let cleanupRan = false
  guard.registerCleanup(() => { cleanupRan = true })

  assert.equal(guard.activeHandlesCount, 3)

  // Dispose before timer fires
  guard.dispose()

  assert.equal(guard.isDisposed, true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(cleanupRan, true)
  assert.equal(guard.activeHandlesCount, 0)

  // Wait 70ms to ensure the timer did not fire after dispose
  await new Promise(r => setTimeout(r, 70))
  assert.equal(timerFired, false)
})
