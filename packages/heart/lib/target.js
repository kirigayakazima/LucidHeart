// 会话路由：把一句待发的话送回它被说出来的那个窗口。
//
// 这里放两件容易出错、又必须单独测的事：
//   1. 会话 id 有两种写法：日志/目录里是 `session-<uuid>`，人和 URL 常只写 `<uuid>`；
//   2. 「指定了窗口但找不到」绝不能退回 `agents.list()[0]`——那往往是最老的窗口，
//      话会跑进用户没在看的会话里（0.8.2 及以前就是这样投错的）。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 一个 id 的所有合法写法，先原样再补/去前缀。 */
export function sessionIdCandidates(id) {
  const raw = String(id ?? '').trim()
  if (!raw) return []
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  return raw.startsWith('session-') ? [raw, bare] : [raw, `session-${bare}`]
}

/** 按任意一种写法找 agent；找不到返回 null，不抛错。 */
export function resolveAgent(agents, id) {
  if (!agents || typeof agents.get !== 'function') return null
  for (const candidate of sessionIdCandidates(id)) {
    try {
      const found = agents.get(candidate)
      if (found) return found
    } catch {
      // 非法 id 只跳过：宁可这一轮不说，也不能把话投进错的窗口
    }
  }
  return null
}

/**
 * 选一个 agent 来开口。
 * @param agents - `ctx.agents`
 * @param target - 明确指定的会话；给了就必须找到，找不到返回 null（让话继续排队）
 */
export function pickAgent(agents, target) {
  if (!agents) return null
  if (target) return resolveAgent(agents, target)
  const list = typeof agents.list === 'function' ? agents.list() : []
  return list.find((agent) => agent && agent.status === 'running') || list[0] || null
}

function getDirSessionMtime(dirPath) {
  let latest = 0
  try {
    const files = fs.readdirSync(dirPath)
    for (const f of files) {
      if (f.startsWith('session') && (f.endsWith('.jsonl') || f.endsWith('.zstd'))) {
        try {
          const stat = fs.statSync(path.join(dirPath, f))
          if (stat.mtimeMs > latest) latest = stat.mtimeMs
        } catch {}
      }
    }
    if (latest === 0) {
      const stat = fs.statSync(dirPath)
      latest = stat.mtimeMs
    }
  } catch {}
  return latest
}

let cachedMtimes = null
let cachedAt = 0
let cachedRoot = null

export function clearSessionMtimesCache() {
  cachedMtimes = null
  cachedAt = 0
  cachedRoot = null
}

/**
 * 扫描会话目录，返回 sessionId -> 最新会话文件 mtimeMs 的映射。
 * 兼容两级目录 ~/.dsh/sessions/<workspace>/<sessionId>/ 与一级目录 ~/.dsh/sessions/<sessionId>/。
 * 带 10 秒短期缓存，避免同一节律 tick 重复全量扫盘。
 */
export function findSessionMtimes(sessionsRoot, { force = false } = {}) {
  const root = sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
  const now = Date.now()
  if (!force && cachedMtimes && cachedRoot === root && now - cachedAt < 10000) {
    return cachedMtimes
  }

  const map = new Map()
  if (!root || !fs.existsSync(root)) return map

  const recordMtime = (name, mtime) => {
    if (mtime <= 0) return
    for (const cand of sessionIdCandidates(name)) {
      const cur = map.get(cand) || 0
      if (mtime > cur) map.set(cand, mtime)
    }
  }

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const entryPath = path.join(root, entry.name)

      let hasSubDirs = false
      try {
        const subEntries = fs.readdirSync(entryPath, { withFileTypes: true })
        for (const sub of subEntries) {
          if (sub.isDirectory()) {
            hasSubDirs = true
            const sPath = path.join(entryPath, sub.name)
            const mtime = getDirSessionMtime(sPath)
            recordMtime(sub.name, mtime)
          }
        }
      } catch {}

      if (!hasSubDirs) {
        const mtime = getDirSessionMtime(entryPath)
        recordMtime(entry.name, mtime)
      }
    }
  } catch {}

  cachedMtimes = map
  cachedAt = now
  cachedRoot = root

  return map
}

/**
 * 在 ctx.agents.list() 里找 session 文件 mtime 最新的那个。
 * 找不到或并列返回 null，绝不退回 list()[0]。
 */
export function findActiveAgent(agents, sessionsRoot) {
  if (!agents || typeof agents.list !== 'function') return null
  const list = agents.list()
  if (!Array.isArray(list) || !list.length) return null

  const root = sessionsRoot || path.join(os.homedir(), '.dsh', 'sessions')
  const mtimes = findSessionMtimes(root)
  if (!mtimes || mtimes.size === 0) return null

  let bestAgent = null
  let maxMtime = -1
  let isTie = false

  for (const agent of list) {
    if (!agent || !agent.id) continue
    const candidates = sessionIdCandidates(agent.id)
    let agentMtime = -1
    for (const cand of candidates) {
      const mt = mtimes.get(cand)
      if (mt !== undefined && mt > agentMtime) {
        agentMtime = mt
      }
    }

    if (agentMtime <= 0) continue

    if (agentMtime > maxMtime) {
      maxMtime = agentMtime
      bestAgent = agent
      isTie = false
    } else if (agentMtime === maxMtime) {
      isTie = true
    }
  }

  if (isTie || !bestAgent) {
    return null
  }
  return bestAgent
}
