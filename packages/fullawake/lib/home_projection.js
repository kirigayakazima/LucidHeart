const MOODS = new Set(['calm', 'engaged', 'cheerful', 'excited', 'tired'])
const PRESENCES = new Set(['present', 'away', 'asleep', 'resting', 'unknown'])
const HEARTBEAT_MS = 60_000
const TTL_MS = 180_000
const ALBUM_REFRESH_MS = 300_000
const SESSION_BATCH_MS = 400
const scopeId = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
const TOOLS = [
  [/^(bili_|video_|storyboard_|xhs_)/u, 'browsing_video', '在刷视频'],
  [/^(memory_|album_)/u, 'reading_memory', '在翻共同记忆'],
  [/^(pc_snapshot$|pc_read_file$|pc_list_dir$|pc_watch|game_watch)/u, 'viewing_pc', '在看你的电脑'],
  [/^(sticker_|rvc_)/u, 'thinking', '在准备回复'],
]
const ALBUM_LABELS = {
  video_storyboard: ['共同看过的视频', '来自共同观看的视频分镜。'],
  game_moment: ['一起见证的游戏时刻', '来自共同陪看的游戏画面。'],
  user_photo: ['一起看过的照片', '来自共同查看的照片。'],
}

function optionalService(ctx, name) {
  try { return ctx.get?.(name) ?? ctx?.[name] } catch { return null }
}

export class HomeProjection {
  #pending = false
  #forced = false
  #running = false
  #sequence = 0
  #generatedAt = 0
  #lastState
  #album = { scope: null, readAt: -Infinity, entries: [] }
  #lifetime = new AbortController()
  #liveActivity = null
  #batchTimer
  #expiryTimer

  constructor(ctx, { gatewayUrl, authToken, bridge, now = Date.now, send = fetch, privateScope = () => null }) {
    this.ctx = ctx
    this.url = gatewayUrl + '/v1/home/snapshot'
    this.authToken = authToken
    this.bridge = bridge
    this.now = now
    this.send = send
    this.privateScope = privateScope
  }

  start() {
    const changed = () => this.refresh()
    const online = () => this.refresh(true)
    const off = this.ctx.on?.('heart/state-changed', changed)
    const offSession = this.ctx.on?.('session/event', (session, event) => {
      try { this.#sessionEvent(session, event) } catch { /* Home remains optional. */ }
    }, { global: true })
    this.bridge?.on('ready', online)
    const heartbeat = setInterval(online, HEARTBEAT_MS)
    heartbeat.unref?.()
    online()
    return () => {
      this.#lifetime.abort()
      clearInterval(heartbeat)
      clearTimeout(this.#batchTimer)
      clearTimeout(this.#expiryTimer)
      this.bridge?.off('ready', online)
      if (typeof off === 'function') off()
      if (typeof offSession === 'function') offSession()
    }
  }

  refresh(force = false) {
    if (this.#lifetime.signal.aborted) return
    this.#pending = true
    this.#forced ||= force
    if (this.#running) return
    this.#running = true
    queueMicrotask(() => void this.#drain())
  }

  followUserTurn(session, turn) {
    if (!this.#lifetime.signal.aborted && Number.isSafeInteger(turn)) {
      try { this.#sessionEvent(session, { type: 'turn/start', data: { turn } }) } catch {}
    }
  }

  #sessionEvent(session, event) {
    const scope = scopeId(this.privateScope())
    if (!scope || scope !== scopeId(session?.id ?? session?.header?.id)) return
    const turn = event.data?.turn
    const previous = this.#liveActivity
    if (['turn/end', 'turn/error', 'turn/abort'].includes(event.type)) {
      if (previous?.scope !== scope || (turn !== undefined && previous.turn !== undefined && turn !== previous.turn)) return
      this.#clearActivity()
      return
    }
    const now = this.now()
    let kind, label, ttl
    if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
      const match = TOOLS.find(([pattern]) => pattern.test(event.data.name))
      if (!match || (previous?.scope === scope && turn !== undefined && previous.turn !== undefined && turn !== previous.turn)) return
      [, kind, label] = match
      ttl = 30_000
    } else if (event.type === 'turn/start') {
      if (previous?.scope === scope && previous.turn === turn && previous.expiresAt > now) return
      kind = 'thinking'
      label = '正在想怎么回复你'
      ttl = 45_000
    } else return

    this.#liveActivity = { kind, label, scope, turn, startedAt: new Date(now).toISOString(), expiresAt: now + ttl }
    clearTimeout(this.#expiryTimer)
    this.#expiryTimer = setTimeout(() => this.#clearActivity(), ttl)
    this.#expiryTimer.unref?.()
    this.#batchTimer ??= setTimeout(() => {
      this.#batchTimer = undefined
      this.refresh()
    }, SESSION_BATCH_MS)
    this.#batchTimer.unref?.()
  }

  #clearActivity() {
    this.#liveActivity = null
    clearTimeout(this.#expiryTimer)
    clearTimeout(this.#batchTimer)
    this.#batchTimer = undefined
    this.refresh()
  }

  #activity(scope, now) {
    const idle = { kind: 'idle', label: '', source: 'heart', startedAt: null }
    if (!scope) return idle
    const live = this.#liveActivity
    if (live?.scope === scopeId(scope) && live.expiresAt > now) {
      return { kind: live.kind, label: live.label, source: 'session', startedAt: live.startedAt }
    }
    const companion = optionalService(this.ctx, 'companion')
    const recent = (item, maxAge) => item && Number.isFinite(item.created_at) && Number.isFinite(item.updated_at) &&
      item.created_at <= now && item.updated_at <= now && now - item.updated_at < maxAge
    const activity = (item, kind, label) => ({ kind, label, source: 'companion', startedAt: new Date(item.created_at).toISOString() })
    try {
      const songs = companion?.tasks?.active?.(scope)
      const singing = songs?.find(task => task.kind === 'singing' && task.status === 'processing' &&
        task.expires_at > now && recent(task, 30 * 60_000))
      if (singing) return activity(singing, 'singing', '正在准备歌曲')
      const current = companion?.activities?.peekActive?.(scope)
      if (recent(current, 30 * 60_000)) return activity(current, 'activity', '正在进行共同活动')
      const project = companion?.projects?.peekActive?.(scope)
      if (recent(project, 2 * 60 * 60_000)) return activity(project, 'project', '在推进共同小项目')
    } catch { /* An unavailable ledger is not activity evidence. */ }
    return idle
  }

  #recentAlbum(scope, now) {
    if (this.#album.scope !== scope) this.#album = { scope, readAt: -Infinity, entries: [] }
    if (!scope || now - this.#album.readAt < ALBUM_REFRESH_MS) return this.#album.entries
    try {
      const book = optionalService(this.ctx, 'memory')?.album
      if (!book?.search) return []
      const entries = book.search('', { limit: 8, scope: 'xiaoman_private' }).flatMap(item => {
        const timestamp = Date.parse(item.timestamp)
        if (item.scope !== 'xiaoman_private' || !item.source || !['direct', null].includes(item.source.channel) ||
            scopeId(item.source.sessionId) !== scopeId(scope) ||
            !/^alb_[a-f0-9]{8}$/.test(item.id) || !Object.hasOwn(ALBUM_LABELS, item.kind) ||
            !Number.isFinite(timestamp) || timestamp > now) return []
        const [title, summary] = ALBUM_LABELS[item.kind]
        return [{ id: item.id, kind: item.kind, title, summary, timestamp: new Date(timestamp).toISOString(),
          revision: Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : 0 }]
      })
      this.#album = { scope, readAt: now, entries }
    } catch { this.#album = { scope, readAt: now, entries: [] } }
    return this.#album.entries
  }

  #read(now) {
    const snapshot = optionalService(this.ctx, 'heart')?.getSnapshot?.()
    if (!snapshot) return null
    const presence = snapshot.presence?.status ?? snapshot.presence
    const state = snapshot.mood?.state
    const energy = snapshot.mood?.energy
    const scope = this.privateScope()
    return {
      presence: PRESENCES.has(presence) ? presence : 'unknown',
      mood: { state: MOODS.has(state) ? state : 'calm', energy: Number.isFinite(energy) ? Math.min(1, Math.max(0, energy)) : 0.6 },
      activity: this.#activity(scope, now),
      recentAlbum: this.#recentAlbum(scope, now),
    }
  }

  async #drain() {
    try {
      while (this.#pending && !this.#lifetime.signal.aborted) {
        const force = this.#forced
        this.#pending = this.#forced = false
        try {
          const now = this.now()
          const state = this.#read(now)
          if (!state) continue
          const signature = JSON.stringify(state)
          if (!force && signature === this.#lastState) continue
          const at = this.#generatedAt = Math.max(now, this.#generatedAt + 1)
          // A lost HTTP receipt must not pin a restarted publisher behind the gateway watermark.
          const sequence = this.#sequence = Math.max(this.#sequence + 1, at)
          const response = await this.send(this.url, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.authToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ schemaVersion: 1, actorId: 'xiaoman', sequence,
              generatedAt: new Date(at).toISOString(), expiresAt: new Date(at + TTL_MS).toISOString(), ...state }),
            redirect: 'error',
            signal: AbortSignal.any([this.#lifetime.signal, AbortSignal.timeout(2500)]),
          })
          if (response.ok) {
            this.#lastState = signature
          }
          await response.body?.cancel()
        } catch { /* The next Heart event, heartbeat or reconnect may deliver a fresh snapshot. */ }
      }
    } finally { this.#running = false }
  }
}
