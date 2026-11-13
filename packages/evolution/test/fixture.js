import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createEvolution } from '../lib/index.js'

export const noon = Date.parse('2026-11-13T12:00:00+08:00')
export const secret = 'test-shared-key-'.repeat(3)
export const direct = { scope: 'owner', storageScope: 'owner', channel: 'direct', ownerDirect: true,
  messageId: 'm1', utterance: '我们一起吃桂花糕', at: noon - 1 }
export const group = { scope: 'group', storageScope: 'group', channel: 'group', coreGroup: true,
  messageId: 'g1', utterance: '公开记录：桂花糕', at: noon - 1 }
export const chatArgs = { dimension: 'shared_joke', title: '桂花糕', observation: '桂花糕',
  evidence_type: 'chat_cue', evidence_snippet: '桂花糕' }

export function sandbox(t, prefix = 'evolution-', close = () => {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(async () => {
    await close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return dataDir
}

export function fixture(t, options = {}) {
  const dataDir = sandbox(t, 'evolution-', () => instance?.close())
  let instance
  let at = noon
  const now = () => at
  instance = createEvolution({ dataDir, now, ...options })
  return { ...instance, dataDir, now, advance(ms) { at += ms } }
}

export function execution(surface = direct, { kind = 'user', prefix = '' } = {}) {
  const text = surface.utterance
  return { agent: { id: surface.scope, session: { id: surface.scope, events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', time: surface.at, data: { id: surface.messageId, role: 'user',
      source: { kind, qq: { channel: surface.channel, start: prefix.length, length: text.length } },
      content: [{ type: 'text', text: prefix + text }] } },
    { type: 'tool/call', data: { callId: 'root', turn: 1 } },
  ] } }, rootCallId: 'root', signal: new AbortController().signal }
}
