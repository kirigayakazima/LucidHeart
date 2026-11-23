import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_STATE_FILE = path.join(os.homedir(), '.dsh', 'fullawake-active-target.json')

const normalizeId = id => (typeof id === 'string' ? id.trim().replace(/^session-/, '') : '')

function idCandidates(id) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (!raw) return []
  const bare = normalizeId(raw)
  return raw.startsWith('session-') ? [raw, bare] : [raw, `session-${bare}`]
}

function getAgentById(agents, id) {
  if (!agents || typeof agents.get !== 'function') return null
  for (const candidate of idCandidates(id)) {
    try {
      const found = agents.get(candidate)
      if (found) return found
    } catch {}
  }
  return null
}

function getService(ctx, name) {
  try { return ctx.get?.(name) ?? ctx?.[name] } catch { return null }
}

const sessionIdOf = agent => agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
const groupId = id => /(?:^|[:-])group(?:[:-]|$)/i.test(String(id ?? ''))

function qqScope(ctx, agent) {
  const sender = getService(ctx, 'qqbotMediaSender')
  try {
    return sender?.resolveTargetForSession?.(sessionIdOf(agent))?.scope
  } catch { return null }
}

function isGroupSession(ctx, agent) {
  return qqScope(ctx, agent) === 'group' || groupId(sessionIdOf(agent))
}

function isDirectC2c(ctx, agent) {
  const sender = getService(ctx, 'qqbotMediaSender')
  const sessionId = agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id
  try {
    return sender?.resolveTargetForSession?.(sessionId)?.scope === 'c2c'
  } catch {
    return false
  }
}

export class ActiveTargetStore {
  #lastAgentId = ''
  #homeAgentId = ''

  constructor(config = {}, { stateFile = DEFAULT_STATE_FILE } = {}) {
    this.config = config
    this.stateFile = stateFile
    this.#load()
  }

  get currentId() {
    return this.#lastAgentId || this.config?.duplexTarget || ''
  }

  /** Home needs positive private-chat evidence and must never persist a fallback. */
  privateScope(ctx) {
    const agent = getAgentById(getService(ctx, 'agents'), this.#homeAgentId || this.currentId)
    const sessionId = sessionIdOf(agent)
    if (!normalizeId(sessionId) || groupId(sessionId)) return null
    const scope = qqScope(ctx, agent)
    if (scope === 'group') return null
    const allowed = this.config?.duplexQqSessions
    if (scope === 'c2c' && allowed?.length &&
        !allowed.some(value => normalizeId(value) === normalizeId(sessionId))) return null
    return sessionId
  }

  #load() {
    if (!this.stateFile) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (typeof raw?.agentId === 'string' && raw.agentId.trim()) {
        this.#lastAgentId = raw.agentId.trim()
      }
    } catch {}
  }

  #save(agentId) {
    if (!agentId || typeof agentId !== 'string') return
    const trimmed = agentId.trim()
    if (!trimmed) return
    this.#lastAgentId = trimmed
    if (!this.stateFile) return
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ agentId: trimmed, updatedAt: new Date().toISOString() }) + '\n', 'utf8')
      fs.renameSync(tmp, this.stateFile)
    } catch {}
  }

  /** Record the most recently active authorized direct (non-group) user session. */
  observe(agent, message, ctx) {
    if (!agent?.id || message?.source?.kind !== 'user') return false
    const qq = message.source?.qq
    if (qq && qq.channel !== 'direct') return false
    if (this.config?.duplexQqSessions?.length) {
      const id = normalizeId(agent.session?.id ?? agent.session?.header?.id ?? agent.id)
      const allowed = this.config.duplexQqSessions.some(value => normalizeId(value) === id)
      if (!allowed) {
        // Native conversations can update Home without changing the authorized voice target.
        if (ctx && !qq && !groupId(sessionIdOf(agent)) && !qqScope(ctx, agent)) this.#homeAgentId = agent.id
        return false
      }
    }
    this.#homeAgentId = agent.id
    this.#save(agent.id)
    return true
  }

  /** Pick the best available direct (non-group) agent from ctx.agents. */
  #pickFallback(ctx) {
    const agents = getService(ctx, 'agents')
    if (!agents || typeof agents.list !== 'function') return null
    const list = agents.list().filter(agent => agent?.id && !isGroupSession(ctx, agent))
    if (!list.length) return null
    const allowed = this.config?.duplexQqSessions?.length
      ? list.filter(agent => {
          const id = normalizeId(agent.session?.id ?? agent.session?.header?.id ?? agent.id)
          return this.config.duplexQqSessions.some(value => normalizeId(value) === id)
        })
      : list
    const candidates = allowed.length ? allowed : list
    return (
      candidates.find(agent => isDirectC2c(ctx, agent) && agent.status === 'running') ||
      candidates.find(agent => isDirectC2c(ctx, agent)) ||
      candidates.find(agent => agent.status === 'running') ||
      candidates[candidates.length - 1] ||
      null
    )
  }

  /** Resolve target agent: explicit config.duplexTarget -> observed/persisted active direct session -> fallback active direct session. */
  resolve(ctx) {
    this.#load()
    const agents = getService(ctx, 'agents')
    if (!agents) return null
    if (this.config?.duplexTarget) {
      const explicit = getAgentById(agents, this.config.duplexTarget)
      if (explicit) return explicit
    }
    if (this.#lastAgentId) {
      const remembered = getAgentById(agents, this.#lastAgentId)
      if (remembered && !isGroupSession(ctx, remembered)) return remembered
    }
    const fallback = this.#pickFallback(ctx)
    if (fallback?.id) this.#save(fallback.id)
    return fallback
  }

  /** Explicitly synchronize to the currently active direct session and persist it. */
  sync(ctx) {
    const agents = getService(ctx, 'agents')
    const agent = (this.#lastAgentId && getAgentById(agents, this.#lastAgentId)) ||
      this.#pickFallback(ctx) ||
      (this.config?.duplexTarget ? getAgentById(agents, this.config.duplexTarget) : null)
    if (agent?.id && !isGroupSession(ctx, agent)) {
      this.#homeAgentId = agent.id
      this.#save(agent.id)
      return { agent, agentId: agent.id }
    }
    return { agent: null, agentId: '' }
  }
}
