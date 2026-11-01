import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAgent, resolveAgent, sessionIdCandidates } from '../lib/target.js'

function fakeAgents(entries) {
  return {
    get: (id) => entries.find((agent) => agent.id === id),
    list: () => entries.slice(),
  }
}

const a = { id: 'session-aaa', status: 'idle' }
const b = { id: 'session-bbb', status: 'idle' }

test('会话 id 带不带 session- 前缀都能找到', () => {
  const agents = fakeAgents([a, b])
  assert.equal(resolveAgent(agents, 'session-bbb'), b)
  assert.equal(resolveAgent(agents, 'bbb'), b)
  assert.deepEqual(sessionIdCandidates('bbb'), ['bbb', 'session-bbb'])
  assert.deepEqual(sessionIdCandidates('session-bbb'), ['session-bbb', 'bbb'])
  assert.deepEqual(sessionIdCandidates('  '), [])
})

test('指定了窗口但找不到：返回 null，不退回 list[0]', () => {
  const agents = fakeAgents([a, b])
  assert.equal(pickAgent(agents, 'ccc'), null)
  assert.equal(pickAgent(agents, 'session-ccc'), null)
})

test('agents.get 抛错时当作找不到，不把节律带崩', () => {
  const agents = {
    get: () => {
      throw new Error('bad id')
    },
    list: () => [a],
  }
  assert.equal(resolveAgent(agents, 'whatever'), null)
})

test('没指定窗口：优先正在跑的，否则列表第一个', () => {
  const running = { id: 'session-run', status: 'running' }
  assert.equal(pickAgent(fakeAgents([a, running])), running)
  assert.equal(pickAgent(fakeAgents([a, b])), a)
  assert.equal(pickAgent(null), null)
})
