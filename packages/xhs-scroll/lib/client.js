import { imageUrl, noteUrl, parseNote, plain } from './parser.js'

const profileUrl = 'https://edith.xiaohongshu.com/api/sns/web/v2/user/me'
const pageLimit = 3 * 1024 * 1024
const imageLimit = 12 * 1024 * 1024
const unavailable = '小红书网页登录态已过期或触发风控，满宝先根据分享卡片读了前段~ 可以去电脑端刷新一下 cookie 噢'

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

function cookieHeader(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return ''
  const cleaned = raw.replace(/[\r\n]+/g, '; ')
  const selected = new Map()
  for (const field of cleaned.split(';')) {
    const trimmed = field.trim()
    if (!trimmed) continue
    const match = /^([a-zA-Z0-9_-]+)=([\x21-\x7e]*)$/.exec(trimmed)
    if (match) {
      const key = match[1]
      const val = match[2]
      if (['web_session', 'a1', 'webId', 'gid', 'xsecappid'].includes(key)) {
        selected.set(key, val)
      }
    }
  }
  if (!selected.has('web_session')) return ''
  return [...selected].map(([key, value]) => `${key}=${value}`).join('; ')
}

async function readBounded(response, limit) {
  if (!response.body || Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('response_size')
  }
  const reader = response.body.getReader(), chunks = []
  let bytes = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return Buffer.concat(chunks, bytes)
      bytes += value.length
      if (bytes > limit) throw new Error('response_size')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function degraded(fallback, id, reason) {
  const title = plain(fallback?.title, 200), desc = plain(fallback?.description ?? fallback?.desc, 4000)
  const cover = imageUrl(fallback?.imageUrl ?? fallback?.cover ?? fallback?.image)
  const ok = Boolean(title || desc || cover)
  return { ok, degraded: true, reason: ok && reason !== 'invalid_url' ? 'anti_bot_fallback' : reason,
    note: ok ? { id: id ?? null, title, desc, author: '', tags: [], likes: null, saves: null, images: cover ? [cover.href] : [] } : null,
    message: ok ? (reason === 'invalid_url' ? '链接无效，满宝先读了分享卡片。' : unavailable) : '暂时读不到这篇小红书笔记。' }
}

export function createXhsClient({ fetcher = fetch, cookie, getCookie, expiresAt, timeoutMs = 8000, now = Date.now } = {}) {
  const resolveCredentials = () => {
    if (typeof getCookie === 'function') {
      const dynamic = getCookie()
      if (dynamic) return cookieHeader(dynamic)
    }
    return cookieHeader(cookie)
  }
  const expiry = Number.isSafeInteger(expiresAt) && expiresAt > 0 ? expiresAt : 0
  const usable = () => {
    const creds = resolveCredentials()
    return Boolean(creds && (!expiry || expiry > now()))
  }
  const timed = signal => AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  const request = async (url, signal, headers = {}) => fetcher(url, { redirect: 'manual', signal, headers: { ...BROWSER_HEADERS, ...headers } })
  const failure = signal => signal?.throwIfAborted()

  return {
    async status(signal) {
      failure(signal)
      const credentials = resolveCredentials()
      const out = { loggedIn: false, user: '', expiresAt: expiry }
      if (!credentials || (expiry && expiry <= now())) return { ...out, reason: credentials ? 'expired' : 'missing_cookie' }
      try {
        const response = await request(profileUrl, timed(signal), { Accept: 'application/json', Cookie: credentials })
        if (!response.ok) {
          await response.body?.cancel()
          return { ...out, reason: 'probe_unverified' }
        }
        const result = JSON.parse((await readBounded(response, 64 * 1024)).toString())
        const user = plain(result?.data?.nickname ?? result?.data?.nickName, 100)
        const id = plain(result?.data?.user_id ?? result?.data?.userId, 100)
        const loggedIn = (result?.success === true || result?.code === 0) && result?.data?.guest !== true && Boolean(user && id)
        return loggedIn ? { loggedIn, user, expiresAt: expiry } : { ...out, reason: 'probe_unverified' }
      } catch { failure(signal); return { ...out, reason: 'probe_unavailable' } }
    },
    async read(value, { fallbackCard, signal } = {}) {
      failure(signal)
      let target = noteUrl(value)
      if (!target) return degraded(fallbackCard, undefined, 'invalid_url')
      const credentials = resolveCredentials()
      if (!credentials || (expiry && expiry <= now())) return degraded(fallbackCard, target.id, 'not_logged_in')
      const deadline = timed(signal)
      try {
        for (let hop = 0; hop < 5; hop++) {
          const response = await request(target.url, deadline, {
            Accept: 'text/html,application/xhtml+xml', ...(target.short ? {} : { Cookie: credentials }),
          })
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            await response.body?.cancel()
            const next = location && noteUrl(new URL(location, target.url))
            if (!next || (target.id && next.id !== target.id)) break
            target = next
            continue
          }
          if (!response.ok || target.short) {
            await response.body?.cancel()
            break
          }
          const note = parseNote((await readBounded(response, pageLimit)).toString(), target.id)
          if (note) return { ok: true, degraded: false, note }
          break
        }
      } catch { failure(signal) }
      return degraded(fallbackCard, target.id, 'web_unavailable')
    },
    async image(value, signal) {
      const url = imageUrl(value)
      if (!url) throw new Error('image_host')
      const response = await request(url, timed(signal), { Accept: 'image/jpeg,image/png,image/webp' })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error('image_unavailable')
      }
      return readBounded(response, imageLimit)
    },
  }
}
