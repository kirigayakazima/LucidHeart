import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { ContextBudgetGuard } from '../../memory/lib/context_guard.js'

test('the DSH SDK provider sees folded history without rewriting the session or system prefix', async t => {
  const ctx = new Context()
  const runtime = new LlmRuntime(ctx)
  const guard = new ContextBudgetGuard(ctx, { load: () => null }, 'xiaoman_private')
  let received
  const unregister = runtime.registerAdapter(['fixture'], new class extends LlmAdapter {
    async *stream(options) {
      received = options
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  t.after(unregister)
  t.after(() => guard.close())
  ctx.on('llm/stream', (options, next) => guard.stream(options, next), { global: true })
  const old = Object.freeze({ id: 'old', role: 'user', source: { kind: 'user' }, content: [
    { type: 'image', attachment: { id: 'old-image' } },
  ] })
  const user = Object.freeze({ id: 'user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: 'a'.repeat(112_000) }] })
  const session = { id: 'sdk-session', events: [
    { type: 'turn/start' }, { type: 'user/message', data: old },
    { type: 'turn/start' }, { type: 'turn/start' }, { type: 'user/message', data: user },
  ] }
  guard.claim({ session }, user)
  const route = { provider: 'fixture', model: 'fixture' }
  const prepared = await runtime.prepareCall(route)
  const frozen = Object.freeze([old, user])
  const options = { ...route, system: 'STATIC PREFIX', sessionId: session.id, messages: frozen }
  for await (const _ of prepared.stream(options)) {}
  assert.equal(received.system, 'STATIC PREFIX')
  assert.match(received.messages[0].content[0].text, /历史画面已折叠/u)
  assert.strictEqual(received.messages[1], user)
  assert.equal(session.events[1].data.content[0].type, 'image')
  assert.equal(frozen[0].content[0].type, 'image')
  for await (const _ of runtime.stream({ ...options, purpose: 'compaction', messages: frozen })) {}
  assert.equal(received.messages[0].content[0].type, 'image')
})
