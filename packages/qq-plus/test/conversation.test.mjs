import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, reportWakeToHeart } from '../lib/index.js'
import { splitForQQ } from '../lib/split.js'

function harness(config = {}) {
  const calls = [], cleanups = [], services = new Map()
  const sender = { async sendMarkdown(target, content, opts) { calls.push({ target, content, opts }); return { ok: true } } }
  const ctx = new Proxy({ qqbotSender: sender, get: name => services.get(name),
    effect(fn) { cleanups.push(fn()) }, on() {} }, {
    get(target, key) { if (key === 'heart') throw new Error('cannot get property heart without inject'); return Reflect.get(target, key) },
  })
  apply(ctx, { persona: 'xiaoman', ignoreLocalFile: true, split: { minChars: 100, targetChars: 100, delayMs: 0 }, ...config })
  return { sender, ctx, calls, services, dispose: () => cleanups.forEach(f => f?.()) }
}
const target = { scope: 'c2c', targetId: 'synthetic' }

test('strict Cordis get resolves late Heart, snapshot and wake observation; unload restores sender', async () => {
  const h = harness(); let snapshots = 0, observations = 0
  await h.sender.sendMarkdown(target, '第一次没有Heart。')
  h.services.set('heart', { getSnapshot() { snapshots++; return { mood: { energy: .1 } } },
    async observe() { observations++; return { accepted: true } }, getExpressionPolicy() { return { enabled: true, mode: 'auto', version: 'test', chars: 100 } } })
  await h.sender.sendMarkdown(target, '第二次Heart已就绪。')
  assert.ok(snapshots > 0)
  assert.equal((await reportWakeToHeart(h.ctx, {})).accepted, true)
  assert.equal(observations, 1)
  assert.equal(h.sender.describeConversation(target).expressionEnabled, true)
  assert.equal(h.sender.conversationDiagnostics().heart, 'available')
  h.dispose(); assert.equal(h.sender.cancelConversation, undefined)
})

test('short semantic paragraphs stay distinct; code and tables remain intact', async () => {
  const h = harness()
  await h.sender.sendMarkdown(target, '你回来啦。\n\n今天怎么样？')
  assert.deepEqual(h.calls.map(c => c.content), ['你回来啦。', '今天怎么样？'])
  const code = '说明。\n\n```js\nconst a = 1;\n\nconsole.log(a)\n```'
  const parts = splitForQQ(code, { semanticParagraphs: true, minChars: 1000, targetChars: 1000, maxSegments: 4 })
  assert.equal(parts.length, 2); assert.ok(parts[1].includes('const a = 1;\n\nconsole.log(a)'))
})

test('stream updates buffer locally, retry replaces text, complete sends once, abort never completes text', async () => {
  const h = harness()
  const stream = h.sender.openStream(target)
  await stream.update('过期草稿'); await stream.update('最终回答。\n\n补充一句。')
  assert.equal(h.calls.length, 0)
  await stream.complete(); await stream.complete()
  assert.deepEqual(h.calls.map(c => c.content), ['最终回答。', '补充一句。'])
  const cancelledStream = h.sender.openStream(target)
  await cancelledStream.update('不该发出的内容'); cancelledStream.abort(); await cancelledStream.complete()
  assert.equal(h.calls.length, 2)
  assert.equal(h.sender.conversationDiagnostics().activeStreams, 0)
})

test('cancellation stops remaining bubbles, pending work and waits but keeps other peers usable', async () => {
  const h = harness({ split: { minChars: 1, targetChars: 8, delayMs: 1000 } })
  const task = h.sender.sendMarkdown(target, '第一句。\n\n第二句。')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.calls.length, 1)
  const pending = h.sender.sendMarkdown(target, '也是过期的排队内容。')
  h.sender.cancelConversation(target)
  assert.equal((await task).cancelled, true)
  assert.equal((await pending).cancelled, true)
  await h.sender.sendMarkdown({ scope: 'c2c', targetId: 'another' }, '另一个会话。')
  assert.equal(h.calls.length, 2)
  assert.equal(h.sender.conversationDiagnostics().queueTargets, 0)
})

test('external abort and unload stop future sends; partial send failure propagates', async () => {
  const h = harness({ split: { minChars: 1, targetChars: 8, delayMs: 1000 } })
  const controller = new AbortController()
  const task = h.sender.sendMarkdown(target, '第一句。\n\n第二句。', { signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  assert.equal((await task).cancelled, true); assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].opts.signal, undefined)
  const stream = h.sender.openStream(target); await stream.update('卸载后不要发')
  h.dispose(); await stream.complete(); assert.equal(h.calls.length, 1)
  const bad = harness()
  // A separate underlying sender throws: the wrapper must not convert failure to success.
  const ctx = { qqbotSender: { async sendMarkdown() { throw new Error('send failed') } }, effect: fn => fn(), get() {} }
  apply(ctx, { persona: 'xiaoman', ignoreLocalFile: true })
  await assert.rejects(ctx.qqbotSender.sendMarkdown(target, '文字'), /send failed/)
  const falseSender = { async sendMarkdown() { return { ok: false, error: 'negative receipt' } } }
  apply({ qqbotSender: falseSender, effect: fn => fn(), get() {} }, { persona: 'xiaoman', ignoreLocalFile: true })
  await assert.rejects(falseSender.sendMarkdown(target, '文字'), /negative receipt/)
  const literalFalse = { async sendMarkdown() { return false } }
  apply({ qqbotSender: literalFalse, effect: fn => fn(), get() {} }, { persona: 'xiaoman', ignoreLocalFile: true })
  await assert.rejects(literalFalse.sendMarkdown(target, '文字'), /reported failure/)
  bad.dispose()
})

test('native-stream is explicit and does not also emit semantic bubbles', async () => {
  let updates = 0, completes = 0
  const sender = { async sendMarkdown() { throw new Error('must not duplicate') },
    openStream() { return { async update() { updates++ }, async complete() { completes++ } } } }
  apply({ qqbotSender: sender, effect: fn => fn(), get() {} }, { persona: 'xiaoman', ignoreLocalFile: true, deliveryMode: 'native-stream' })
  const stream = sender.openStream(target); await stream.update('流式内容'); await stream.complete()
  assert.equal(updates, 1); assert.equal(completes, 1)
  assert.equal(sender.conversationDiagnostics().nativeStreams, 1)
})
