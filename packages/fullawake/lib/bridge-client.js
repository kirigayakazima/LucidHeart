import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import pkg from '../package.json' with { type: 'json' }

const PROTOCOL = 'lucid.voice/1'
const HANDSHAKE_MS = 5000
const TURN_MS = 45_000
const MAX_EPOCH = Number.MAX_SAFE_INTEGER - 1
const text = (value, max) => typeof value === 'string' && value.length > 0 && [...value].length <= max
const integer = (value, min, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max
const shape = (value, required, optional = []) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key))

export class FullAwakeBridgeClient extends EventEmitter {
  #connection = null
  #running = false
  #retry
  #backoff = 1000
  #task = null

  constructor(gatewayUrl, authToken, { heartVersion = () => '0.21.3', retryMs = 1000 } = {}) {
    super()
    const url = new URL(gatewayUrl)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/ws/bridge' ||
        url.username || url.password || url.search || url.hash) throw new Error('VOICE_BRIDGE_LOOPBACK_REQUIRED')
    this.url = url.href
    this.authToken = authToken
    this.heartVersion = heartVersion
    this.retryMs = retryMs
    this.#backoff = retryMs
    this.sessionId = `watch-session-${Date.now()}-${randomUUID()}`
  }

  get ready() {
    return this.#connection?.ready === true && this.#connection.socket.readyState === WebSocket.OPEN
  }

  get turnLifecycle() {
    return this.ready && this.#connection.turnLifecycle
  }

  connect() {
    if (this.#running) return
    this.#running = true
    this.#open()
  }

  stop() {
    this.#running = false
    clearTimeout(this.#retry)
    if (this.#connection) this.#drop(this.#connection)
    this.#backoff = this.retryMs
  }

  #open() {
    let socket
    try {
      socket = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.authToken}` } })
    } catch {
      this.#reconnect()
      return
    }
    const connection = { socket, id: `conn-${randomUUID()}`, seq: 0, received: 0, ready: false, epoch: 0 }
    this.#connection = connection
    connection.timer = setTimeout(() => this.#drop(connection), HANDSHAKE_MS)
    connection.timer.unref?.()
    socket.addEventListener('open', () => {
      if (this.#connection !== connection) return
      let heartVersion
      try { heartVersion = this.heartVersion() } catch {}
      this.#send(connection, 'session.handshake', {
        clientVersion: pkg.version, heartVersion: text(heartVersion, 40) ? heartVersion : '0.21.3',
        device: 'redmi-note12turbo',
      })
    })
    socket.addEventListener('message', event => this.#receive(connection, event.data))
    socket.addEventListener('error', () => this.#drop(connection))
    socket.addEventListener('close', () => this.#drop(connection))
  }

  #reconnect() {
    if (!this.#running) return
    this.#retry = setTimeout(() => this.#open(), this.#backoff)
    this.#retry.unref?.()
    this.#backoff = Math.min(this.#backoff * 2, 15_000)
  }

  #drop(connection) {
    if (connection !== this.#connection) return
    this.#connection = null
    clearTimeout(connection.timer)
    if (this.#task) this.#finish(this.#task, 'cancelled', 'bridge_disconnected')
    connection.socket.close()
    this.#reconnect()
  }

  #send(connection, type, payload) {
    if (connection !== this.#connection || connection.socket.readyState !== WebSocket.OPEN) return false
    try {
      connection.socket.send(JSON.stringify({ protocol: PROTOCOL, type, sessionId: this.sessionId,
        connectionId: connection.id, commandSeq: ++connection.seq, payload }))
      return true
    } catch {
      this.#drop(connection)
      return false
    }
  }

  #receive(connection, raw) {
    if (connection !== this.#connection) return
    let frame
    try { if (typeof raw === 'string' && raw.length <= 4096) frame = JSON.parse(raw) } catch {}
    if (!shape(frame, ['protocol', 'type', 'sessionId', 'connectionId', 'commandSeq', 'payload']) ||
        frame.protocol !== PROTOCOL || frame.sessionId !== this.sessionId || frame.connectionId !== connection.id ||
        !integer(frame.commandSeq, 1)) {
      this.#drop(connection)
      return
    }
    if (frame.commandSeq <= connection.received) return
    const { payload } = frame
    if (!connection.ready) {
      if (frame.type !== 'session.handshake_ack' || frame.commandSeq !== 1 ||
          !shape(payload, ['status', 'initialEpoch', 'vadSupported'], ['gatewayVersion', 'turnLifecycle']) ||
          payload.status !== 'ready' || !integer(payload.initialEpoch, 1, MAX_EPOCH - 1) ||
          typeof payload.vadSupported !== 'boolean' ||
          (Object.hasOwn(payload, 'gatewayVersion') && !text(payload.gatewayVersion, 40)) ||
          (Object.hasOwn(payload, 'turnLifecycle') && typeof payload.turnLifecycle !== 'boolean')) {
        this.#drop(connection)
        return
      }
      clearTimeout(connection.timer)
      connection.epoch = payload.initialEpoch
      connection.received = frame.commandSeq
      connection.ready = true
      connection.turnLifecycle = payload.turnLifecycle === true
      this.#backoff = this.retryMs
      this.emit('ready', payload)
      return
    }
    connection.received = frame.commandSeq
    const task = this.#task
    if (frame.type === 'audio.interrupt' &&
        shape(payload, ['abortedEpoch', 'utteranceId', 'reason', 'localAudioStopped', 'elapsedAudioMs']) &&
        integer(payload.abortedEpoch, 1, MAX_EPOCH) && text(payload.utteranceId, 80) &&
        payload.reason === 'near_end_speech' && typeof payload.localAudioStopped === 'boolean' &&
        integer(payload.elapsedAudioMs, 0, 10_000)) {
      if (!task || task.epoch !== payload.abortedEpoch || task.utteranceId !== payload.utteranceId) return
      connection.epoch = Math.max(connection.epoch, payload.abortedEpoch) + 1
      // Abort before listeners or I/O so a matching task always gets the
      // interruption reason, even if the socket closes while sending the ACK.
      this.#finish(task, 'interrupted', 'user_interrupt')
      this.#send(connection, 'audio.interrupt_ack', { abortedEpoch: payload.abortedEpoch, currentEpoch: connection.epoch })
      this.emit('interrupt', payload)
      return
    }
    if (frame.type === 'audio.prepared' && shape(payload, ['epoch', 'utteranceId']) &&
        integer(payload.epoch, 1, MAX_EPOCH) && text(payload.utteranceId, 80)) {
      if (task?.epoch === payload.epoch && task.utteranceId === payload.utteranceId && task.phase === 'preparing') {
        task.phase = 'prepared'
        task.prepared.resolve(true)
      }
      return
    }
    if (frame.type === 'audio.result' && shape(payload, ['epoch', 'utteranceId', 'status']) &&
        integer(payload.epoch, 1, MAX_EPOCH) && text(payload.utteranceId, 80) &&
        ['played', 'text_delivered', 'discarded', 'cancelled'].includes(payload.status)) {
      if (task?.epoch === payload.epoch && task.utteranceId === payload.utteranceId &&
          (payload.status !== 'played' || task.phase === 'audio') &&
          (payload.status !== 'text_delivered' || task.phase === 'text')) {
        this.#finish(task, payload.status, ['played', 'text_delivered'].includes(payload.status) ? null : 'bridge_discarded')
      }
      return
    }
    this.#drop(connection)
  }

  #newTask(phase, signal, timeout) {
    if (!this.ready || this.#task || signal?.aborted || this.#connection.epoch >= MAX_EPOCH) return null
    const connection = this.#connection
    const task = { connection, phase, epoch: ++connection.epoch, utteranceId: `utt-${randomUUID()}`,
      controller: new AbortController(), prepared: Promise.withResolvers(), done: Promise.withResolvers() }
    const forwardAbort = () => task.controller.abort(signal.reason)
    const cancel = () => {
      if (this.#task !== task) return
      this.#finish(task, 'cancelled')
      if (connection.turnLifecycle) this.#send(connection, 'audio.cancel', this.#identity(task))
    }
    signal?.addEventListener('abort', forwardAbort, { once: true })
    task.controller.signal.addEventListener('abort', cancel, { once: true })
    task.cleanup = () => {
      signal?.removeEventListener('abort', forwardAbort)
      task.controller.signal.removeEventListener('abort', cancel)
    }
    task.timer = setTimeout(() => task.controller.abort('bridge_deadline'), timeout)
    task.timer.unref?.()
    this.#task = task
    task.handle = Object.freeze({ ...this.#identity(task), controller: task.controller, signal: task.controller.signal,
      prepared: task.prepared.promise, done: task.done.promise })
    return task
  }

  #identity(task) {
    return { epoch: task.epoch, utteranceId: task.utteranceId }
  }

  #finish(task, status, reason) {
    if (this.#task !== task) return
    this.#task = null
    clearTimeout(task.timer)
    task.cleanup()
    if (reason) task.controller.abort(reason)
    task.prepared.resolve(false)
    task.done.resolve({ status })
  }

  begin({ signal, cue } = {}) {
    if (!this.turnLifecycle) return null
    const task = this.#newTask('preparing', signal, TURN_MS)
    if (!task) return null
    if (!this.#send(task.connection, 'audio.prepare', { ...this.#identity(task), ...(cue && {
      watchSessionId: cue.watchSessionId, cueId: cue.cueId,
    }) })) this.#finish(task, 'cancelled', 'bridge_disconnected')
    return task.handle
  }

  speak({ text: words, voiceProfile = 'feiyu-rvc-v1', pitchShift = -4, deadlineMs = 4000 } = {}, handle) {
    if (!text(words, 200) || !words.trim() || voiceProfile !== 'feiyu-rvc-v1' ||
        ![0, -4].includes(pitchShift) || !integer(deadlineMs, 1, 30_000)) return null
    const task = handle ? this.#task : this.#newTask('prepared', undefined, deadlineMs + 13_000)
    if (!task || task.phase !== 'prepared' || (handle && task.handle !== handle)) return null
    task.phase = 'audio'
    task.prepared.resolve(true)
    if (!this.#send(task.connection, 'audio.speak', { ...this.#identity(task), text: words, voiceProfile, pitchShift, deadlineMs })) {
      this.#finish(task, 'cancelled', 'bridge_disconnected')
    }
    return task.handle
  }

  showText(handle, words, intent) {
    const task = this.#task
    if (!task || task.handle !== handle || task.phase !== 'prepared' || !text(words, 120) ||
        !['nod', 'smile', 'wave', 'shock'].includes(intent)) return false
    task.phase = 'text'
    const sent = this.#send(task.connection, 'pet.text', { ...this.#identity(task), text: words, intent })
    if (!sent) this.#finish(task, 'cancelled', 'bridge_disconnected')
    return sent
  }
}
