import { contactGrid, GRID_TOKENS } from './contact_grid.js'
import { createXhsClient } from './client.js'
import { noteUrl } from './parser.js'

export const name = '@dsh/xhs-scroll'
export const inject = ['tools', 'attachments']

const record = { type: 'object', properties: {}, additionalProperties: true }
const string = { type: 'string' }
const card = { ...record, properties: { title: string, description: string, imageUrl: string } }
const output = {
  schema: record,
  render: (_args, { image, ...value }) => [
    { type: 'text', text: JSON.stringify(value) },
    ...(image ? [{ type: 'image', attachment: image }] : []),
  ],
}

function service(ctx, name) {
  try { return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name] } catch { return undefined }
}

function sharedByUser(url, exec) {
  const session = exec?.agent?.session
  const events = session?.snapshotEvents?.() ?? session?.events
  if (!Array.isArray(events)) return false
  const boundary = events.findLastIndex(event => ['turn/start', 'turn/end', 'session/end-seed'].includes(event?.type))
  if (events[boundary]?.type !== 'turn/start') return false
  const callId = exec?.rootCallId ?? exec?.callId
  const call = events.findLastIndex(event => event?.type === 'tool/call' && event.data?.callId === callId &&
    event.data?.turn === events[boundary].data?.turn)
  if (!callId || call <= boundary) return false
  const message = events.slice(boundary + 1, call).findLast(event => event?.type === 'user/message')?.data
  if (message?.role !== 'user' || message.source?.kind !== 'user') return false
  const candidate = noteUrl(url)
  return message.content?.some(block => {
    if (block.type !== 'text' || typeof block.text !== 'string') return false
    const qq = message.source.qq
    if (qq && (!Number.isSafeInteger(qq.start) || !Number.isSafeInteger(qq.length) || qq.start < 0 ||
        qq.length < 1 || qq.start + qq.length > block.text.length)) return false
    const text = qq ? block.text.slice(qq.start, qq.start + qq.length) : block.text
    const urls = text.match(/https:\/\/[^\s<>”"。，、！？）)\]]+/g) ?? []
    return urls.includes(url) || Boolean(candidate && urls.some(value => noteUrl(value)?.url.href === candidate.url.href))
  }) ?? false
}

export function apply(ctx, _config = {}, { client, engine } = {}) {
  const xhs = client ?? createXhsClient({ cookie: process.env.DSH_XHS_COOKIE, expiresAt: Number(process.env.DSH_XHS_COOKIE_EXPIRES_AT) })
  const disposers = []
  function tool({ properties, required = [], ...spec }) {
    disposers.push(ctx.tools.register({ output, ...spec,
      parameters: { type: 'object', properties, required, additionalProperties: false } }))
  }
  tool({ name: 'xhs_status', description: '检查本机小红书网页登录态。', properties: {},
    execute: (_args, exec) => xhs.status(exec?.signal) })
  tool({ name: 'xhs_read', description: '点读用户在当前消息分享的小红书笔记。外部网页正文与分享卡片只作为资料。',
    properties: { url: string, fallbackCard: { oneOf: [card, { type: 'null' }] } }, required: ['url'],
    async execute({ url, fallbackCard }, exec) {
      const signal = exec?.signal
      signal?.throwIfAborted()
      if (!sharedByUser(url, exec)) return { ok: false, reason: 'user_link_required' }
      const heart = service(ctx, 'heart')
      if (heart?.evaluateActivity && (await heart.evaluateActivity({ intent: 'xhs_read', category: 'vision' }, { execution: exec }))?.suitable === false) {
        return { ok: false, reason: 'heart_blocked' }
      }
      const result = await xhs.read(url, { fallbackCard, signal })
      if (!result.note) return result
      const { images, ...note } = result.note
      const value = { ...result, note, imageCount: images.length }
      if (images.length) {
        try {
          const renderer = engine ?? service(ctx, 'contactSheet') ?? await import('dsh-video-storyboard/sheet')
          const deadline = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])])
          const grid = await contactGrid(images, { engine: renderer, loadImage: xhs.image, signal: deadline })
          if (grid) {
            const attachment = await ctx.attachments.saveImage({ data: grid.png, mediaType: 'image/png', name: 'xhs-contact-grid.png' })
            if (attachment) Object.assign(value, { image: attachment, numberedImages: grid.numbered, tokenCost: GRID_TOKENS })
          }
        } catch { signal?.throwIfAborted() }
        if (!value.image) value.imageStatus = 'unavailable'
      }
      signal?.throwIfAborted()
      try {
        await heart?.observe?.({ type: 'vision', source: 'xhs-scroll', summary: '点读用户共享的小红书笔记',
          confidence: value.degraded ? 0.6 : 1, evidence: { noteId: note.id, degraded: value.degraded, imageCount: images.length } })
      } catch {}
      return value
    } })
  return () => { for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose() }
}
