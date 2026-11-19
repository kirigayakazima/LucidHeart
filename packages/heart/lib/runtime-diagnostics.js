// Local-only process evidence. Monitoring never swallows a fatal exception,
// restarts the host, sends a message, or changes autonomous activity quotas.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HEART_CORE_VERSION } from '../contracts/types.js'

export const CAPABILITIES = Object.freeze(['pc_bridge', 'pc_voice_pet', 'breezeblue_tts', 'local_rvc',
  'video_storyboard', 'xhs_scroll', 'bili_scroll', 'voice_duplex'])
const states = ['available', 'degraded', 'offline', 'unknown']

/** Evidence expires. A loaded plugin alone never proves its provider is usable. */
export function capabilityProfile({ now = Date.now, ttlMs = 60_000 } = {}) {
  const evidence = new Map()
  return {
    record(name, status, reason = 'probe') {
      if (!CAPABILITIES.includes(name) || !states.includes(status)) throw new TypeError('Invalid capability state')
      const row = { name, status, checkedAt: new Date(now()).toISOString(), reason: String(reason).slice(0, 200) }
      evidence.set(name, row)
      return { ...row }
    },
    failure(name, reason = 'tool_failed') { return this.record(name, 'degraded', reason) },
    snapshot() {
      return CAPABILITIES.map(name => {
        const row = evidence.get(name)
        const fresh = row && now() >= Date.parse(row.checkedAt) && now() - Date.parse(row.checkedAt) < ttlMs
        const status = fresh ? row.status : 'unknown'
        return { name, status, checkedAt: row?.checkedAt ?? null,
          known: fresh ? [`最近核验状态为 ${status}`, row.reason] : [],
          inferred: [], unknown: fresh ? ['当前任务是否能成功仍需执行确认'] : ['当前可用性尚未核验'],
          nextStep: status === 'available' ? '先执行一次最小请求并核对回执' : '请检查连接或配置，再做一次只读探测' }
      })
    },
  }
}

export async function refreshCapabilities(ctx, profile) {
  const get = key => { try { return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key] } catch { return null } }
  const bridge = get('pcBridge')
  if (!bridge) {
    profile.record('pc_bridge', 'offline', 'pcBridge service absent')
    profile.record('pc_voice_pet', 'offline', 'pcBridge service absent')
  } else {
    try {
      const checked = await bridge.checkNow?.()
      const online = checked?.online ?? bridge.isOnline?.()
      profile.record('pc_bridge', online === true ? 'available' : online === false ? 'offline' : 'unknown')
      profile.record('pc_voice_pet', online === false ? 'offline' : bridge.isPetVoiceReady?.() === true ? 'available' : 'degraded')
    } catch { profile.failure('pc_bridge', 'probe_failed'); profile.failure('pc_voice_pet', 'probe_failed') }
  }
  for (const [name, key] of [['breezeblue_tts', 'breezeblue'], ['local_rvc', 'rvc'],
    ['video_storyboard', 'videoStoryboard'], ['xhs_scroll', 'xhsScroll'], ['bili_scroll', 'biliScroll'], ['voice_duplex', 'voiceDuplex']]) {
    const provider = get(key)
    if (typeof provider?.diagnostics !== 'function') continue
    try {
      const row = await provider.diagnostics()
      profile.record(name, states.includes(row?.status) ? row.status : 'unknown', row?.reason ?? 'provider_probe')
    } catch { profile.failure(name, 'probe_failed') }
  }
  return profile.snapshot()
}

function append(file, entry, maxBytes, archives = 2) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const line = JSON.stringify(entry) + '\n'
    let size = 0
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.nlink !== 1) return false
      size = stat.size
    } catch (error) { if (error.code !== 'ENOENT') return false }
    if (size + Buffer.byteLength(line) > maxBytes) {
      for (let i = archives; i >= 1; i--) {
        const target = `${file}.${i}`
        const source = i === 1 ? file : `${file}.${i - 1}`
        if (fs.existsSync(target)) fs.unlinkSync(target)
        if (fs.existsSync(source)) fs.renameSync(source, target)
      }
    }
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch { return false }
}

export function faultDetails(error, origin) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const name = typeof error?.name === 'string' ? error.name : ''
  const service = /cannot get property ["']([A-Za-z0-9_.-]{1,80})["'] without inject/.exec(message)?.[1]
  // Exclude the message and stack header: either can contain private tool input.
  const sites = String(error?.stack || '').split('\n').slice(1, 9).flatMap(line => {
    const site = /(?:\(|\bat )((?:file:\/\/\/|\/|[A-Za-z]:[\\/])[^()\s]+:\d+:\d+)\)?$/.exec(line)?.[1]
    if (!site) return []
    const coordinate = /:\d+:\d+$/.exec(site)[0]
    return [site.slice(0, -coordinate.length).split(/[?#]/, 1)[0] + coordinate]
  })
  return {
    origin: ['uncaughtException', 'unhandledRejection'].includes(origin) ? origin : 'unknown',
    errorClass: /^[A-Za-z][A-Za-z0-9_.]{0,79}$/.test(name) ? name : 'Error',
    kind: service ? 'cordis-uninjected-service' : 'uncaught-exception',
    ...(service ? { service } : {}),
    sites,
  }
}

export function installRuntimeDiagnostics(root, { intervalMs = 60000, maxBytes = 2 * 1024 * 1024 } = {}) {
  const id = randomUUID()
  const home = path.join(path.resolve(root), 'logs')
  const runtimeFile = path.join(home, 'runtime.jsonl')
  const faultFile = path.join(home, 'runtime-faults.jsonl')
  const write = (event, detail = {}) => append(runtimeFile, {
    at: new Date().toISOString(), event, id, pid: process.pid, ppid: process.ppid, ...detail,
  }, maxBytes)
  const sample = () => {
    try {
      let availableKiB = null
      try { availableKiB = Number(/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]) || null } catch {}
      const memory = process.memoryUsage()
      write('sample', { uptimeSeconds: Math.round(process.uptime()), rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed, memAvailableKiB: availableKiB })
    } catch {}
  }
  const fault = (error, origin) => {
    try {
      const detail = faultDetails(error, origin)
      const entry = { at: new Date().toISOString(), event: 'fatal', id, pid: process.pid, ...detail }
      append(faultFile, entry, 256 * 1024, 1)
      write('fatal', detail)
    } catch {}
  }
  const exit = code => { write('exit', { code }) }
  write('loaded', { heartVersion: HEART_CORE_VERSION, node: process.version })
  sample()
  const timer = setInterval(sample, intervalMs)
  timer.unref()
  process.on('uncaughtExceptionMonitor', fault)
  process.on('exit', exit)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    process.off('uncaughtExceptionMonitor', fault)
    process.off('exit', exit)
    write('unloaded')
  }
}
