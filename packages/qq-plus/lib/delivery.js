// Per-target ordered delivery with cancellation, including waits and queued work.
export const targetKey = (target) => `${target?.scope || ''}:${target?.targetId || ''}`
export const cancelled = () => Object.assign(new Error('Reply delivery cancelled'), { name: 'AbortError' })
export function waitForDelay(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancelled())
  if (!(ms > 0)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(cancelled()) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, ms)
    signal?.addEventListener('abort', abort, { once: true })
  })
}
export function createDeliveryQueue() {
  const targets = new Map()
  let disposed = false
  return {
    enqueue(target, run, externalSignal) {
      if (disposed) return Promise.reject(cancelled())
      const key = targetKey(target)
      let state = targets.get(key)
      if (!state) { state = { tail: Promise.resolve(), controllers: new Set() }; targets.set(key, state) }
      const controller = new AbortController()
      state.controllers.add(controller)
      const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal
      const result = state.tail.then(() => { if (signal.aborted) throw cancelled(); return run(signal) })
      state.tail = result.catch(() => {})
      const cleanup = () => { state.controllers.delete(controller); if (!state.controllers.size && targets.get(key) === state) targets.delete(key) }
      result.then(cleanup, cleanup)
      return result
    },
    cancel(target) { for (const controller of targets.get(targetKey(target))?.controllers || []) controller.abort() },
    dispose() { disposed = true; for (const state of targets.values()) for (const controller of state.controllers) controller.abort() },
    get size() { return targets.size },
  }
}
