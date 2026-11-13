import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { apply } from '../lib/index.js'
import { httpTransport, signature, sisterPath } from '../lib/collaboration/sister_channel.js'
import { direct, execution, fixture, sandbox, secret } from './fixture.js'

test('signed HTTP relay, durable retry and idempotent handling', async t => {
  const receiver = fixture(t)
  const server = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const result = receiver.sister.ingest(Buffer.concat(chunks).toString(), req.headers['x-sister-signature'], secret)
      res.end(JSON.stringify(result))
    } catch {
      res.writeHead(400).end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const relay = httpTransport(`http://127.0.0.1:${server.address().port}${sisterPath}`, secret)
  let online = false
  const sender = fixture(t, { role: 'axing', transport: async (...args) => {
    if (!online) throw Error('offline')
    return relay(...args)
  } })
  const packet = await sender.sister.send({ type: 'care_relay', summary: '提醒喝水', payload: { delay_minutes: 10 } })
  assert.equal(packet.delivery, 'queued')
  online = true
  assert.equal(await sender.sister.flush(), 1)
  assert.equal(receiver.sister.receive()[0].id, packet.id)
  assert.equal(receiver.sister.markHandled({ id: packet.id, result_note: '完成' }).handled, true)
  await relay(packet)
  assert.equal(receiver.sister.receive().length, 0)
  assert.equal(receiver.sister.receive({ unhandled_only: false })[0].resultNote, '完成')
})

test('relay refuses arbitrary payload fields, stale packets, or a misrouted recipient', async t => {
  const sender = fixture(t, { role: 'axing' })
  const receiver = fixture(t)
  await assert.rejects(sender.sister.send({ type: 'whisper', summary: '问候', payload: { journal: '禁止' } }), /字段/)
  const packet = await sender.sister.send({ type: 'whisper', summary: '问候' })
  const body = JSON.stringify(packet)
  assert.throws(() => sender.sister.ingest(body, signature(body, secret), secret), /目标/)
  receiver.advance(86_400_000)
  assert.throws(() => receiver.sister.ingest(body, signature(body, secret), secret), /过期/)
})

test('Cordis route rejects unsigned HTTP and its inbox tool reads authenticated traffic', async t => {
  const previous = process.env.DSH_EVOLUTION_SISTER_SECRET
  process.env.DSH_EVOLUTION_SISTER_SECRET = secret
  const cleanup = []
  const tools = new Map()
  let route
  const root = sandbox(t, 'evolution-http-', () => cleanup.forEach(dispose => dispose?.()))
  try {
    apply({ tools: { register: tool => tools.set(tool.name, tool) }, effect: fn => cleanup.push(fn()),
      webServer: { register: value => { route = value } } },
    { role: 'xiaoman', dataDir: root, ownerDirectSessions: ['owner'] })
  } finally {
    if (previous === undefined) delete process.env.DSH_EVOLUTION_SISTER_SECRET
    else process.env.DSH_EVOLUTION_SISTER_SECRET = previous
  }
  assert.equal(route.path, sisterPath)
  const server = createServer(route.handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}${route.path}`
  const forged = await fetch(url, { method: 'POST', body: '{}' })
  assert.equal(forged.status, 400)
  await forged.body.cancel()
  const sender = fixture(t, { role: 'axing', now: Date.now, transport: httpTransport(url, secret) })
  const packet = await sender.sister.send({ type: 'status_sync', summary: '暂时忙碌', payload: { state: '忙碌' } })
  assert.equal(packet.delivery, 'sent')
  assert.equal((await tools.get('sister_receive').execute({}, execution(direct))).data[0].id, packet.id)
})
