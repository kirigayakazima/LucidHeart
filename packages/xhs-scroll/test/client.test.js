import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createXhsClient } from '../lib/client.js'
import { apply } from '../lib/index.js'

const id = '67de21b90000000012009abc'
const url = `https://www.xiaohongshu.com/discovery/item/${id}`
const short = 'https://xhslink.com/a/shared'
const cookie = 'web_session=fixture-session; a1=fixture-a1; internal=omit'
const fallbackCard = { title: '卡片标题', description: '这里是前段' }
const html = `<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"${id}":{"note":{"title":"网页标题"}}}}}</script>`

test('missing or expired credentials use the share card with zero web requests', async () => {
  for (const options of [{}, { cookie, expiresAt: 100, now: () => 101 }]) {
    const client = createXhsClient({ ...options, fetcher: () => assert.fail('unexpected fetch') })
    assert.equal((await client.status()).loggedIn, false)
    const result = await client.read(url, { fallbackCard })
    assert.equal(result.reason, 'anti_bot_fallback')
    assert.equal(result.note.title, fallbackCard.title)
    assert.equal(result.degraded, true)
  }
})

test('manual redirect sends cookies to the verified note and strips unknown cookies', async () => {
  const calls = []
  const client = createXhsClient({ cookie, fetcher: async (target, options) => {
    calls.push([String(target), options.headers.Cookie])
    assert.equal(options.redirect, 'manual')
    return String(target) === short ? new Response('', { status: 302, headers: { location: url } }) : new Response(html)
  } })
  assert.equal((await client.read(short)).note.title, '网页标题')
  assert.deepEqual(calls, [[short, undefined], [url, 'web_session=fixture-session; a1=fixture-a1']])
})

test('challenge redirect never follows the challenge and uses the fallback card', async () => {
  let calls = 0
  const client = createXhsClient({ cookie, fetcher: async () => {
    calls++
    return new Response('', { status: 302, headers: { location: 'https://www.xiaohongshu.com/website-login/captcha' } })
  } })
  assert.equal((await client.read(url, { fallbackCard })).reason, 'anti_bot_fallback')
  assert.equal(calls, 1)
})

test('valid profile reports user and blocked or guest probes remain unverified', async () => {
  const client = createXhsClient({ cookie, expiresAt: 500, now: () => 499,
    fetcher: async () => Response.json({ code: 0, data: { userId: 'self', nickname: '小舟' } }) })
  assert.deepEqual(await client.status(), { loggedIn: true, user: '小舟', expiresAt: 500 })
  const blocked = createXhsClient({ cookie, fetcher: async () => new Response('', { status: 406 }) })
  assert.equal((await blocked.status()).reason, 'probe_unverified')
  const guest = createXhsClient({ cookie, fetcher: async () => Response.json({ code: 0, data: { userId: 'x', nickname: 'x', guest: true } }) })
  assert.equal((await guest.status()).loggedIn, false)
})

test('bounded HTML and network errors degrade without exposing credentials', async () => {
  for (const fetcher of [async () => new Response('a'.repeat(3 * 1024 * 1024 + 1)), async () => { throw new Error(cookie) }]) {
    const result = await createXhsClient({ cookie, fetcher }).read(url, { fallbackCard })
    assert.equal(result.reason, 'anti_bot_fallback')
    assert(!JSON.stringify(result).includes('fixture-session'))
  }
})

test('image requests never carry credentials or follow redirects', async () => {
  const client = createXhsClient({ cookie, fetcher: async (_target, options) => {
    assert.equal(options.headers.Cookie, undefined)
    assert.equal(options.redirect, 'manual')
    return new Response('', { status: 302, headers: { location: 'https://localhost/internal' } })
  } })
  await assert.rejects(client.image('https://x.xhscdn.com/a.png'), /image_unavailable/)
  await assert.rejects(client.image('https://localhost/internal'), /image_host/)
})

test('host reads only a link in the current user message and never renders raw source images', async () => {
  const tools = new Map(), signal = new AbortController().signal
  let reads = 0
  apply({ tools: { register: tool => tools.set(tool.name, tool) } }, {}, { client: {
    async read() { reads++; return { ok: true, note: { title: '链接', images: ['https://x.xhscdn.com/a.png'] } } },
  }, engine: {} })
  const source = { kind: 'schedule' }
  const exec = { callId: 'call', signal, agent: { session: { events: [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { role: 'user', source, content: [{ type: 'text', text: url }] } },
    { type: 'tool/call', data: { callId: 'call', turn: 1 } },
  ] } } }
  const tool = tools.get('xhs_read')
  assert.equal((await tool.execute({ url }, exec)).reason, 'user_link_required')
  source.kind = 'user'
  const result = await tool.execute({ url }, exec)
  assert.equal(reads, 1)
  assert.equal(result.imageStatus, 'unavailable')
  assert.deepEqual(tool.output.render({}, result).map(block => block.type), ['text'])
  assert(!JSON.stringify(result).includes('xhscdn'))
})
