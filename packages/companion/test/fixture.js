import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply, createCompanion } from '../lib/index.js'

export const noon = Date.parse('2026-11-13T12:00:00+08:00')
export const evidence = (text, id = text) => ({ text, id })

export function fixture(t, options = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-'))
  let at = noon
  const opts = { dataDir, now: () => at, ...options }
  const instances = []
  function reopen() {
    const instance = createCompanion(opts)
    instances.push(instance)
    return instance
  }
  const instance = reopen()
  t.after(() => {
    for (const value of instances) value.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { ...instance, dataDir, reopen, advance(ms) { at += ms } }
}

export function host(t, services = {}, execute) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'companion-host-'))
  const tools = new Map()
  const listeners = new Map()
  const cleanup = []
  const observations = []
  apply({
    tools: { register: tool => tools.set(tool.name, tool), execute },
    get: name => services[name] ?? (name === 'heart' ? {
      getSnapshot: () => ({ presence: { status: 'present' } }),
      evaluateActivity: () => ({ suitable: true }),
      observe: item => observations.push(item),
    } : undefined),
    on: (name, listener) => listeners.set(name, listener),
    effect: effect => cleanup.push(effect()),
  }, { dataDir })
  t.after(() => {
    for (const dispose of cleanup) dispose()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { observations, listeners, tools,
    run(suffix, args, exec = execution()) { return tools.get('companion_' + suffix).execute(args, exec) } }
}

export function execution(text = '用户请求', { scope = 'chat', id = 'message-1', kind = 'user' } = {}) {
  const message = { id, role: 'user', source: { kind }, content: [{ type: 'text', text }] }
  return {
    agent: { id: scope, session: { id: scope, events: [
      { type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: message },
      { type: 'tool/call', data: { turn: 1, callId: 'call-1' } },
    ] } }, rootCallId: 'call-1', token: {}, signal: new AbortController().signal,
  }
}
