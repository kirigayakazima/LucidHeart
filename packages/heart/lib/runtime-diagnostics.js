// Local-only process evidence. Monitoring never swallows a fatal exception,
// restarts the host, sends a message, or changes autonomous activity quotas.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HEART_CORE_VERSION } from '../contracts/types.js'

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
