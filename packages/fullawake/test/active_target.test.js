import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ActiveTargetStore } from '../lib/active_target.js'

function makeAgents(list) {
  const map = new Map(list.map(a => [a.id, a]))
  return {
    get: id => map.get(id) ?? null,
    list: () => list,
  }
}

test('ActiveTargetStore observes direct user sessions, ignores group sessions, and persists across instances', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullawake-target-'))
  const stateFile = path.join(dir, 'target.json')
  try {
    const store = new ActiveTargetStore({}, { stateFile })
    const directAgent = { id: 'session-direct-1', status: 'running', session: { id: 'session-direct-1' } }
    const groupAgent = { id: 'session-group-9', status: 'running', session: { id: 'session-group-9' } }

    assert.equal(store.observe(groupAgent, { source: { kind: 'user', qq: { channel: 'group' } } }), false)
    assert.equal(store.observe(directAgent, { source: { kind: 'user', qq: { channel: 'direct' } } }), true)

    const reloaded = new ActiveTargetStore({}, { stateFile })
    const ctx = { agents: makeAgents([groupAgent, directAgent]) }
    assert.equal(reloaded.resolve(ctx)?.id, 'session-direct-1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ActiveTargetStore falls back to active C2C direct session when duplexTarget is unset and sync persists it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fullawake-target-'))
  const stateFile = path.join(dir, 'target.json')
  try {
    const store = new ActiveTargetStore({}, { stateFile })
    const groupAgent = { id: 'agent-group', status: 'running', session: { id: 'agent-group' } }
    const c2cAgent = { id: 'agent-c2c', status: 'idle', session: { id: 'agent-c2c' } }
    const ctx = {
      agents: makeAgents([groupAgent, c2cAgent]),
      qqbotMediaSender: {
        resolveTargetForSession: id => (id === 'agent-group' ? { scope: 'group' } : { scope: 'c2c' }),
      },
    }

    assert.equal(store.resolve(ctx)?.id, 'agent-c2c')
    const synced = store.sync(ctx)
    assert.equal(synced.agentId, 'agent-c2c')
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).agentId, 'agent-c2c')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
