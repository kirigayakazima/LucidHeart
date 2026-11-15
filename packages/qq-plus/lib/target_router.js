import { randomUUID } from 'node:crypto'
import { targetKey, cancelled } from './delivery.js'

export class TargetRouter {
  #routes = new Map()       // routeId -> RouteEntry
  #bySession = new Map()    // sessionId -> Set<routeId>
  #byTarget = new Map()     // targetKey -> Set<routeId>
  #closed = false

  constructor(options = {}) {
    this.maxRoutes = options.maxRoutes || 256
    this.onRouteCancelled = options.onRouteCancelled || (() => {})
  }

  get activeRouteCount() {
    return this.#routes.size
  }

  createRoute({ sessionId, scope, targetId, mediaType = 'audio' }) {
    if (this.#closed) throw cancelled()
    if (!sessionId || typeof sessionId !== 'string') throw new TypeError('sessionId is required')
    if (!scope || !targetId) throw new TypeError('Valid target with scope and targetId is required')

    // Evict oldest closed/unconfirmed routes if capacity exceeded
    if (this.#routes.size >= this.maxRoutes) {
      this.#pruneOldest()
    }

    const routeId = randomUUID()
    const target = { scope, targetId }
    const key = targetKey(target)
    const controller = new AbortController()

    const entry = {
      routeId,
      sessionId,
      target,
      targetKey: key,
      mediaType,
      status: 'pending',     // pending | in_flight | delivered | unconfirmed | cancelled | failed
      createdAt: Date.now(),
      updatedAt: Date.now(),
      controller,
      error: null,
      deliveryReceipt: null,
    }

    this.#routes.set(routeId, entry)

    if (!this.#bySession.has(sessionId)) this.#bySession.set(sessionId, new Set())
    this.#bySession.get(sessionId).add(routeId)

    if (!this.#byTarget.has(key)) this.#byTarget.set(key, new Set())
    this.#byTarget.get(key).add(routeId)

    return {
      routeId,
      signal: controller.signal,
      target,
    }
  }

  getRoute(routeId) {
    const entry = this.#routes.get(routeId)
    if (!entry) return null
    return {
      routeId: entry.routeId,
      sessionId: entry.sessionId,
      target: { ...entry.target },
      mediaType: entry.mediaType,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      error: entry.error,
      deliveryReceipt: entry.deliveryReceipt,
    }
  }

  validateDispatch(routeId, candidateTarget) {
    const entry = this.#routes.get(routeId)
    if (!entry) return { allowed: false, reason: 'ROUTE_NOT_FOUND' }
    if (entry.status === 'cancelled') return { allowed: false, reason: 'ROUTE_CANCELLED' }

    const expectedKey = entry.targetKey
    const actualKey = targetKey(candidateTarget)

    if (expectedKey !== actualKey) {
      return {
        allowed: false,
        reason: 'TARGET_MISMATCH',
        expected: entry.target,
        actual: candidateTarget,
      }
    }

    return { allowed: true, target: entry.target }
  }

  markInFlight(routeId) {
    const entry = this.#routes.get(routeId)
    if (!entry || entry.status === 'cancelled') return false
    entry.status = 'in_flight'
    entry.updatedAt = Date.now()
    return true
  }

  markDelivered(routeId, receipt = null) {
    const entry = this.#routes.get(routeId)
    if (!entry) return false
    if (entry.status === 'cancelled') return false
    entry.status = 'delivered'
    entry.deliveryReceipt = receipt
    entry.updatedAt = Date.now()
    return true
  }

  markUnconfirmed(routeId, error = null) {
    const entry = this.#routes.get(routeId)
    if (!entry || entry.status === 'cancelled') return false
    entry.status = 'unconfirmed'
    entry.error = error?.message || String(error)
    entry.updatedAt = Date.now()
    return true
  }

  markFailed(routeId, error = null) {
    const entry = this.#routes.get(routeId)
    if (!entry) return false
    entry.status = 'failed'
    entry.error = error?.message || String(error)
    entry.updatedAt = Date.now()
    return true
  }

  cancelRoute(routeId, reason = 'Route cancelled') {
    const entry = this.#routes.get(routeId)
    if (!entry || entry.status === 'cancelled') return false
    entry.status = 'cancelled'
    entry.updatedAt = Date.now()
    entry.error = reason
    entry.controller.abort(cancelled())
    this.onRouteCancelled(entry)
    return true
  }

  cancelSession(sessionId, reason = 'Session cancelled') {
    const routeIds = this.#bySession.get(sessionId)
    if (!routeIds || !routeIds.size) return 0
    let count = 0
    for (const routeId of Array.from(routeIds)) {
      if (this.cancelRoute(routeId, reason)) count++
    }
    return count
  }

  cancelTarget(target, reason = 'Target cancelled') {
    const key = targetKey(target)
    const routeIds = this.#byTarget.get(key)
    if (!routeIds || !routeIds.size) return 0
    let count = 0
    for (const routeId of Array.from(routeIds)) {
      if (this.cancelRoute(routeId, reason)) count++
    }
    return count
  }

  dispose() {
    this.#closed = true
    for (const entry of this.#routes.values()) {
      if (entry.status === 'pending' || entry.status === 'in_flight') {
        entry.status = 'cancelled'
        entry.controller.abort(cancelled())
      }
    }
    this.#routes.clear()
    this.#bySession.clear()
    this.#byTarget.clear()
  }

  #pruneOldest() {
    for (const [routeId, entry] of this.#routes.entries()) {
      if (entry.status === 'delivered' || entry.status === 'cancelled' || entry.status === 'failed') {
        this.#bySession.get(entry.sessionId)?.delete(routeId)
        this.#byTarget.get(entry.targetKey)?.delete(routeId)
        this.#routes.delete(routeId)
        if (this.#routes.size < this.maxRoutes) break
      }
    }
  }
}

export function createTargetRouter(options) {
  return new TargetRouter(options)
}
