import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { apply, inject, name } from '../lib/index.js'
import { createWake } from '../lib/wake.js'

const hour = 3_600_000
const noon = Date.parse('2026-11-12T12:00:00+08:00')

function turn(number, callId = 'call', message) {
  return [
    { type: 'turn/start', data: { turn: number } },
    ...(message ? [{ type: 'user/message', data: message }] : []),
    { type: 'tool/call', data: { turn: number, callId } },
  ]
}

function makeAgent(id = 'main', number = 0) {
  const messages = []
  return {
    id, status: 'running', messages, session: { id: `session-${id}`, events: turn(number) },
    followup(message) { messages.push(message) },
  }
}

function fixture(t, ctx = {}, at = noon) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'dsh-heart-wake-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return {
    dataDir, file: path.join(dataDir, 'wake.sqlite'),
    create: () => createWake(ctx, { dataDir, now: () => at }),
    setTime(value) { at = value },
  }
}

test('passes the complete scheduled UserMessage to exec.agent without consulting the fallback', async t => {
  const f = fixture(t, { get agents() { assert.fail('should not look up a different session') } })
  const agent = makeAgent()
  const result = await f.create()('继续检查这条推理。', { agent, callId: 'nested', rootCallId: 'call' })
  assert.equal(result.ok, true)
  assert.match(result.messageId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.deepEqual(agent.messages, [{
    id: result.messageId, role: 'user',
    content: [{ type: 'text', text: '继续检查这条推理。' }], source: { kind: 'schedule' },
  }])
})

test('fallback picks the running agent, or an idle session when there is no active turn', async t => {
  const idle = makeAgent('idle')
  idle.status = 'idle'
  idle.session.events = []
  const running = makeAgent()
  const agents = [idle, running]
  const wake = fixture(t, { agents: { list: () => agents } }).create()
  assert.equal((await wake('继续')).ok, true)
  agents.pop()
  assert.equal((await wake('另一个会话')).ok, true)
  assert.equal(running.messages.length, 1)
  assert.equal(idle.messages.length, 1)
})

test('persists same-turn and 15-second locks across instances, even across tool calls', async t => {
  const f = fixture(t)
  const agent = makeAgent()
  assert.equal((await f.create()('第一条', { agent, callId: 'call' })).ok, true)
  f.setTime(noon + hour)
  agent.session.events.push({ type: 'tool/call', data: { turn: 0, callId: 'another' } })
  assert.equal((await f.create()('同轮', { agent, callId: 'another' })).reason, 'same_turn')

  f.setTime(noon + 14_999)
  agent.session.events = turn(1)
  assert.equal((await f.create()('还在冷却', { agent, callId: 'call' })).reason, 'cooldown')
  f.setTime(noon + 15_000)
  assert.equal((await f.create()('新轮已过冷却', { agent, callId: 'call' })).ok, true)
  assert.equal(agent.messages.length, 2)
})

test('blocks a turn opened by this plugin even after the cooldown', async t => {
  const f = fixture(t)
  const agent = makeAgent()
  await f.create()('继续', { agent })
  agent.session.events = turn(1, 'call', agent.messages[0])
  f.setTime(noon + 60_000)
  assert.equal((await f.create()('递归', { agent, callId: 'call' })).reason, 'wake_loop')
  assert.equal(agent.messages.length, 1)
})

test('quiet time is Shanghai 01:00 inclusive through 07:00 exclusive', async t => {
  const f = fixture(t)
  const agent = makeAgent()
  const wake = f.create()
  for (const hour of ['01:00:00', '06:59:59']) {
    f.setTime(Date.parse(`2026-11-12T${hour}+08:00`))
    assert.deepEqual(await wake('继续', { agent }), {
      ok: false, reason: 'quiet_hours', message: '深夜静音期休息中，不执行自唤醒',
    })
  }
  assert.throws(() => readFileSync(f.file), { code: 'ENOENT' })
  f.setTime(Date.parse('2026-11-12T07:00:00+08:00'))
  assert.equal((await wake('早上继续', { agent })).ok, true)
})

test('enforces global rolling-hour and Shanghai-calendar daily quotas across sessions and restarts', async t => {
  const f = fixture(t)
  const run = id => f.create()('继续', { agent: makeAgent(id) })
  for (let index = 0; index < 3; index++) {
    f.setTime(noon + index * hour)
    assert.equal((await run(`${index}-a`)).ok, true)
    assert.equal((await run(`${index}-b`)).ok, true)
    f.setTime(noon + (index + 1) * hour - 1)
    assert.equal((await run(`${index}-third`)).reason, 'hourly_cap')
  }
  f.setTime(noon + 3 * hour)
  assert.equal((await run('seventh')).reason, 'daily_cap')
  f.setTime(Date.parse('2026-11-13T00:00:00+08:00'))
  assert.equal((await run('next-day')).ok, true)
})

test('reserves before concurrent followups and retains the attempt on ambiguous host failure', async t => {
  const f = fixture(t)
  const agent = makeAgent()
  const released = Promise.withResolvers()
  const entered = Promise.withResolvers()
  agent.followup = async function (message) {
    this.messages.push(message)
    entered.resolve()
    await released.promise
    throw new Error('Inbox state uncertain')
  }
  const first = f.create()('第一条', { agent })
  await entered.promise
  assert.equal((await f.create()('并发', { agent })).reason, 'same_turn')
  released.resolve()
  assert.equal((await first).reason, 'followup_failed')
  assert.equal((await f.create()('重试', { agent })).reason, 'same_turn')
  assert.equal(agent.messages.length, 1)
})

test('refuses malformed input, stale context, cancellation, and corrupt quota storage', async t => {
  const f = fixture(t)
  const agent = makeAgent()
  const wake = f.create()
  assert.equal((await wake('   ', { agent })).reason, 'invalid_text')
  assert.equal((await wake('继续', { agent, callId: 'stale' })).reason, 'turn_unavailable')
  assert.equal((await wake('继续', { agent: { id: 'broken' } })).reason, 'no_agent')
  assert.equal((await wake('继续', { agent, signal: AbortSignal.abort() })).reason, 'cancelled')
  const corrupt = 'not a sqlite database'
  writeFileSync(f.file, corrupt)
  assert.equal((await wake('继续', { agent })).reason, 'quota_unavailable')
  assert.equal(readFileSync(f.file, 'utf8'), corrupt)
  assert.deepEqual(agent.messages, [])
})

test('honors the host Heart activity gate without modifying its quota ledger', async t => {
  const agent = makeAgent()
  const f = fixture(t, { get(key) {
    assert.equal(key, 'heart')
    return { evaluateActivity(intent) {
      assert.deepEqual(intent, { intent: 'heart_wake' })
      return { suitable: false }
    } }
  } })
  assert.equal((await f.create()('继续', { agent })).reason, 'heart_blocked')
  assert.deepEqual(agent.messages, [])
  assert.throws(() => readFileSync(f.file), { code: 'ENOENT' })
})

test('registers a Cordis tool with JSON output and routes execution through the guards', async t => {
  const f = fixture(t)
  const registered = []
  assert.equal(name, 'dsh-heart-wake')
  assert.deepEqual(inject, ['tools', 'agents'])
  apply({ tools: { register: tool => registered.push(tool) } }, { dataDir: f.dataDir })
  const [tool] = registered
  assert.equal(tool.name, 'heart_wake')
  assert.deepEqual(tool.parameters.required, ['text'])
  const result = await tool.execute({ text: '继续' }, { signal: AbortSignal.abort() })
  assert.equal(result.reason, 'cancelled')
  assert.deepEqual(tool.output.render({}, result), [{ type: 'text', text: result.message }])
})
