/**
 * FullAwake Lifecycle Guard:
 * Prevents handle leaks, cleans up dangling timers and listeners,
 * and discards late-arriving async callbacks across epoch transitions.
 */

export class LifecycleGuard {
  #epoch = 1
  #timers = new Set()
  #cleanups = new Set()
  #controllers = new Set()
  #disposed = false

  constructor(options = {}) {
    this.name = options.name || 'default'
  }

  get epoch() {
    return this.#epoch
  }

  get isDisposed() {
    return this.#disposed
  }

  get activeHandlesCount() {
    return this.#timers.size + this.#cleanups.size + this.#controllers.size
  }

  /**
   * Advance the monotonic lifecycle epoch (e.g. on new turn, cancel, or re-connection).
   * All pending callbacks tagged with the previous epoch will be safely discarded.
   */
  nextEpoch() {
    if (this.#disposed) return this.#epoch
    this.#epoch++
    return this.#epoch
  }

  /**
   * Wrap an async or sync callback with epoch validation.
   * If the epoch changed by the time the callback triggers, it is silently dropped or handled by onStale.
   */
  wrapCallback(epoch, callback, onStale = null) {
    return (...args) => {
      if (this.#disposed || epoch !== this.#epoch) {
        if (typeof onStale === 'function') {
          return onStale({ epoch, currentEpoch: this.#epoch, disposed: this.#disposed })
        }
        return undefined
      }
      return callback(...args)
    }
  }

  /**
   * Track a setTimeout timer, ensuring it clears automatically on dispose.
   */
  setTimeout(fn, delayMs) {
    if (this.#disposed) return null
    const wrappedEpoch = this.#epoch
    let timer
    const cleanup = () => {
      if (timer) this.#timers.delete(timer)
    }

    timer = setTimeout(() => {
      cleanup()
      if (!this.#disposed && this.#epoch === wrappedEpoch) {
        fn()
      }
    }, delayMs)

    if (typeof timer.unref === 'function') timer.unref()
    this.#timers.add(timer)
    return timer
  }

  /**
   * Track a setInterval loop, ensuring it clears automatically on dispose.
   */
  setInterval(fn, intervalMs) {
    if (this.#disposed) return null
    const timer = setInterval(() => {
      if (this.#disposed) {
        clearInterval(timer)
        this.#timers.delete(timer)
        return
      }
      fn()
    }, intervalMs)

    if (typeof timer.unref === 'function') timer.unref()
    this.#timers.add(timer)
    return timer
  }

  /**
   * Create a managed AbortController that automatically aborts on dispose.
   */
  createAbortController() {
    if (this.#disposed) {
      const c = new AbortController()
      c.abort(new Error('LifecycleGuard already disposed'))
      return c
    }
    const controller = new AbortController()
    this.#controllers.add(controller)
    return controller
  }

  /**
   * Register an arbitrary cleanup function (e.g. socket close, event unhook).
   */
  registerCleanup(cleanupFn) {
    if (typeof cleanupFn !== 'function') return () => {}
    if (this.#disposed) {
      try { cleanupFn() } catch {}
      return () => {}
    }
    this.#cleanups.add(cleanupFn)
    return () => this.#cleanups.delete(cleanupFn)
  }

  /**
   * Teardown all registered handles, timers, and abort controllers.
   */
  dispose() {
    if (this.#disposed) return
    this.#disposed = true

    for (const timer of this.#timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.#timers.clear()

    for (const controller of this.#controllers) {
      try {
        controller.abort(new Error('LifecycleGuard disposed'))
      } catch {}
    }
    this.#controllers.clear()

    for (const cleanup of this.#cleanups) {
      try {
        cleanup()
      } catch {}
    }
    this.#cleanups.clear()
  }
}

export function createLifecycleGuard(options) {
  return new LifecycleGuard(options)
}
