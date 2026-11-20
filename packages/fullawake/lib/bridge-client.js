import { EventEmitter, once } from 'node:events'
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

function wavDuration(audio) {
  if (audio.length < 12 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') return null
  let byteRate = 0
  let dataBytes = 0
  for (let offset = 12; offset + 8 <= audio.length;) {
    const size = audio.readUInt32LE(offset + 4)
    if (size > audio.length - offset - 8) return null
    const kind = audio.toString('ascii', offset, offset + 4)
    if (kind === 'fmt ' && size >= 16) byteRate = audio.readUInt32LE(offset + 16)
    if (kind === 'data') dataBytes += size
    offset += 8 + size + (size % 2)
  }
  return byteRate > 0 && dataBytes > 0 ? dataBytes * 1000 / byteRate : null
}

export class FullAwakeBridgeClient extends EventEmitter {
  #connection = null
  #running = false
  #retry
  #backoff = 1000
  #task = null
  #lastInterrupt = null

  constructor(gatewayUrl, authToken, { heartVersion = () => '0.21.3', retryMs = 1000, capture = false } = {}) {
    super()
    const url = new URL(gatewayUrl)
    if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || url.pathname !== '/ws/bridge' ||
        url.username || url.password || url.search || url.hash) throw new Error('VOICE_BRIDGE_LOOPBACK_REQUIRED')
    this.url = url.href
    this.authToken = authToken
    this.heartVersion = heartVersion
    this.retryMs = Math.min(retryMs, 5000)
    this.capture = capture
    this.#backoff = this.retryMs
    this.sessionId = `watch-session-${Date.now()}-${randomUUID()}`
  }

  get ready() {
    return this.#connection?.ready === true && this.#connection.socket.readyState === WebSocket.OPEN
  }

  get turnLifecycle() {
    return this.ready && this.#connection.turnLifecycle
  }

  get gameVoiceScope() { return this.turnLifecycle && typeof this.#connection.gameVoice === 'boolean' }

  get breezeDirect() { return this.gameVoiceScope && this.#connection.gameVoice === true }

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

  cancelCurrent() { this.#task?.controller.abort('conversation_cancelled') }

  replyDesktop(kind, requestId, active, accepted) {
    return this.ready && this.#send(this.#connection, `${kind}.state`, { requestId, active, accepted })
  }

  consumeLastInterrupt(agentId) {
    const repair = this.#lastInterrupt
    if (!repair || (agentId !== undefined && repair.agentId !== agentId)) return null
    this.#lastInterrupt = null
    if (performance.now() - repair.at > 60_000) return null
    const { spokenText, remainingText } = repair
    return { spokenText, remainingText }
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
        ...(this.capture ? { capture: true } : {}),
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
    this.#backoff = Math.min(this.#backoff * 2, 5_000)
  }

  #drop(connection) {
    if (connection !== this.#connection) return
    this.#connection = null
    this.#lastInterrupt = null
    connection.gameRequest?.settle(null)
    connection.callRequest?.settle(null)
    this.emit('disconnected')
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
          !shape(payload, ['status', 'initialEpoch', 'vadSupported'], ['gatewayVersion', 'turnLifecycle', 'gameVoice']) ||
          payload.status !== 'ready' || !integer(payload.initialEpoch, 1, MAX_EPOCH - 1) ||
          typeof payload.vadSupported !== 'boolean' ||
          (Object.hasOwn(payload, 'gatewayVersion') && !text(payload.gatewayVersion, 40)) ||
          (Object.hasOwn(payload, 'turnLifecycle') && typeof payload.turnLifecycle !== 'boolean') ||
          (Object.hasOwn(payload, 'gameVoice') && typeof payload.gameVoice !== 'boolean')) {
        this.#drop(connection)
        return
      }
      clearTimeout(connection.timer)
      connection.epoch = payload.initialEpoch
      connection.received = frame.commandSeq
      connection.ready = true
      connection.turnLifecycle = payload.turnLifecycle === true
      connection.gameVoice = payload.gameVoice
      this.#backoff = this.retryMs
      this.emit('ready', payload)
      return
    }
    connection.received = frame.commandSeq
    if (frame.type === 'voice.call.status' && shape(payload, ['requestId', 'active']) &&
        text(payload.requestId, 80) && typeof payload.active === 'boolean') {
      if (connection.callRequest?.id === payload.requestId) connection.callRequest.settle(payload)
      return
    }
    if (frame.type === 'game.watch.status' && shape(payload, ['requestId', 'status', 'watchId']) &&
        text(payload.requestId, 80) && (payload.status === 'started' ? text(payload.watchId, 80) :
          ['stopped', 'unavailable'].includes(payload.status) && payload.watchId === null)) {
      if (connection.gameRequest?.id === payload.requestId) connection.gameRequest.settle(payload)
      return
    }
    if (frame.type === 'game.watch.event' && shape(payload, ['watchId', 'eventId', 'kind', 'outcome', 'remainingMs']) &&
        text(payload.watchId, 80) && text(payload.eventId, 80) && integer(payload.remainingMs, 1, 2500) &&
        (payload.kind === 'victory' ? ['win', 'loss'].includes(payload.outcome) :
          ['death', 'recall'].includes(payload.kind) && payload.outcome === null)) {
      this.emit('game-watch-event', payload)
      return
    }
    if (frame.type === 'game.watch.ended' && shape(payload, ['watchId', 'reason']) &&
        text(payload.watchId, 80) && ['locked', 'away', 'stopped'].includes(payload.reason)) {
      this.emit('game-watch-ended', payload)
      return
    }
    const task = this.#task
    if (frame.type === 'pc.call_request' && shape(payload, ['requestId', 'enabled', 'source']) &&
        text(payload.requestId, 64) && typeof payload.enabled === 'boolean' && payload.source === 'pc_desktop_app') {
      this.emit('pc-call-request', payload)
      return
    }
    if (frame.type === 'pc.watch_request' && shape(payload, ['requestId', 'action', 'mode', 'targetLabel']) &&
        text(payload.requestId, 64) && ['start', 'stop'].includes(payload.action) &&
        payload.mode === 'desktop' && text(payload.targetLabel, 240)) {
      this.emit('pc-watch-request', payload)
      return
    }
    if (frame.type === 'pc.sync_request' && shape(payload, ['requestId', 'source']) &&
        text(payload.requestId, 64) && payload.source === 'pc_desktop_app') {
      this.emit('pc-sync-request', payload)
      return
    }
    if (this.capture && frame.type === 'audio.capture' && shape(payload, ['turnId', 'audio_epoch']) &&
        integer(payload.audio_epoch, 1) && (payload.turnId === null || text(payload.turnId, 80))) {
      this.emit('capture', payload)
      return
    }
    if (this.capture && frame.type === 'audio.transcript' && shape(payload, ['turnId', 'audio_epoch', 'text', 'is_final']) &&
        integer(payload.audio_epoch, 1) && text(payload.turnId, 80) && text(payload.text, 1500) && typeof payload.is_final === 'boolean') {
      this.emit('transcript', payload)
      return
    }
    if (frame.type === 'audio.interrupt' &&
        shape(payload, ['abortedEpoch', 'utteranceId', 'reason', 'localAudioStopped', 'elapsedAudioMs']) &&
        integer(payload.abortedEpoch, 1, MAX_EPOCH) && text(payload.utteranceId, 80) &&
        payload.reason === 'near_end_speech' && typeof payload.localAudioStopped === 'boolean' &&
        integer(payload.elapsedAudioMs, 0, 60_000)) {
      if (!task || task.epoch !== payload.abortedEpoch || task.utteranceId !== payload.utteranceId) return
      connection.epoch = Math.max(connection.epoch, payload.abortedEpoch) + 1
      // Abort before listeners or I/O so a matching task always gets the
      // interruption reason, even if the socket closes while sending the ACK.
      this.#lastInterrupt = null
      if (payload.localAudioStopped && task.spokenFullText) {
        const characters = [...task.spokenFullText]
        const ratio = Math.min(1, payload.elapsedAudioMs / Math.max(400, task.estimatedDurationMs))
        const cut = Math.round(characters.length * ratio)
        const remainingText = characters.slice(cut).join('')
        if ([...remainingText].length >= 2) this.#lastInterrupt = { agentId: task.agentId, at: performance.now(),
          spokenText: characters.slice(0, cut).join(''), remainingText }
      }
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

  async watchGame(action, { signal } = {}) {
    if (!['start', 'stop'].includes(action) || signal?.aborted) return null
    if (action === 'start' && !this.ready && this.#running) {
      const deadline = AbortSignal.timeout(2500)
      try { await once(this, 'ready', { signal: signal ? AbortSignal.any([signal, deadline]) : deadline }) } catch { return null }
    }
    const connection = this.#connection
    if (!this.breezeDirect || connection.gameRequest || signal?.aborted) return null
    const { promise, resolve } = Promise.withResolvers()
    const id = randomUUID()
    const abort = () => this.#drop(connection)
    const timer = setTimeout(abort, 2500)
    timer.unref?.()
    const settle = value => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      connection.gameRequest = null
      resolve(value)
    }
    connection.gameRequest = { id, settle }
    signal?.addEventListener('abort', abort, { once: true })
    if (!this.#send(connection, 'game.watch', { action, requestId: id })) settle(null)
    return promise
  }

  setCallActive(active, { signal } = {}) {
    const connection = this.#connection
    if (!this.turnLifecycle || !this.capture || connection.callRequest || signal?.aborted || typeof active !== 'boolean') return null
    const { promise, resolve } = Promise.withResolvers()
    const id = randomUUID()
    const abort = () => this.#drop(connection)
    const timer = setTimeout(abort, 2500)
    timer.unref?.()
    const settle = value => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      connection.callRequest = null
      resolve(value)
    }
    connection.callRequest = { id, settle }
    signal?.addEventListener('abort', abort, { once: true })
    if (!this.#send(connection, 'voice.call', { requestId: id, active })) settle(null)
    return promise
  }

  begin({ signal, cue, gameProcess, gameEventId, agentId } = {}) {
    if (!this.turnLifecycle || (gameEventId !== undefined && (!this.breezeDirect || !text(gameEventId, 80) || cue || gameProcess))) return null
    const task = this.#newTask('preparing', signal, TURN_MS)
    if (!task) return null
    task.agentId = agentId
    if (!this.#send(task.connection, 'audio.prepare', { ...this.#identity(task), ...(cue && {
      watchSessionId: cue.watchSessionId, cueId: cue.cueId,
    }), ...(this.gameVoiceScope && text(gameProcess, 128) && { gameProcess }), ...(gameEventId && { gameEventId }) })) {
      this.#finish(task, 'cancelled', 'bridge_disconnected')
    }
    return task.handle
  }

  speak({ text: words, voiceProfile, instructions, pitchShift, deadlineMs = 4000 } = {}, handle) {
    const profile = voiceProfile ?? (this.breezeDirect && handle ? 'breezeblue' : 'feiyu-rvc-v1')
    const direct = profile === 'breezeblue'
    const shift = pitchShift ?? (direct ? 0 : -4)
    if (!text(words, direct ? 120 : 200) || !words.trim() ||
        (direct ? !handle || !this.breezeDirect || (instructions !== undefined && !text(instructions, 200)) : profile !== 'feiyu-rvc-v1') ||
        ![0, -4].includes(shift) || !integer(deadlineMs, 1, 30_000)) return null
    const task = handle ? this.#task : this.#newTask('prepared', undefined, deadlineMs + 13_000)
    if (!task || task.phase !== 'prepared' || (handle && task.handle !== handle)) return null
    task.phase = 'audio'
    task.spokenFullText = words
    task.estimatedDurationMs = [...words].length * 240
    task.prepared.resolve(true)
    if (!this.#send(task.connection, 'audio.speak', { ...this.#identity(task), text: words, voiceProfile: profile, pitchShift: shift, deadlineMs,
      ...(direct && instructions && { instructions }) })) {
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

  playAudio({ text: words, audio }, handle) {
    const task = this.#task
    if (!task || task.handle !== handle || task.phase !== 'prepared' || !text(words, 40) ||
        !Buffer.isBuffer(audio) || !audio.length || audio.length > 1024 * 1024) return false
    task.phase = 'audio'
    task.spokenFullText = words
    task.estimatedDurationMs = wavDuration(audio) ?? [...words].length * 240
    const sent = this.#send(task.connection, 'audio.play', {
      ...this.#identity(task), text: words, audioBase64: audio.toString('base64'), deadlineMs: 15_000,
    })
    if (!sent) this.#finish(task, 'cancelled', 'bridge_disconnected')
    return sent
  }
}
