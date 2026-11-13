const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', dateStyle: 'short' })
export const shanghaiDay = at => day.format(at)
export const scopeOf = agent => agent?.session?.id ?? agent?.session?.header?.id ?? agent?.id

export function userEvidence(exec) {
  if (exec?.signal?.aborted) return null
  const session = exec?.agent?.session
  const events = session?.snapshotEvents?.() ?? session?.events
  const call = exec?.rootCallId ?? exec?.callId
  if (!Array.isArray(events) || !call) return null
  const start = events.findLastIndex(event => ['turn/start', 'turn/end'].includes(event.type))
  if (events[start]?.type !== 'turn/start') return null
  const index = events.findLastIndex(event => event.type === 'tool/call' &&
    event.data.callId === call && event.data.turn === events[start].data.turn)
  if (index <= start) return null
  const input = events.slice(start + 1, index).findLast(event =>
    event.type === 'user/message' && ['user', 'schedule', 'external'].includes(event.data?.source?.kind))?.data
  if (input?.role !== 'user' || input.source.kind !== 'user' || typeof input.id !== 'string' || !input.id) return null
  const qq = input.source.qq
  const text = input.content?.find(block => block.type === 'text')?.text
  if (typeof text !== 'string') return null
  if (qq) {
    if (!Number.isSafeInteger(qq.start) || !Number.isSafeInteger(qq.length) ||
        qq.start < 0 || qq.length <= 0 || qq.start > text.length - qq.length) return null
    return { id: input.id, text: text.slice(qq.start, qq.start + qq.length).trim(), channel: qq.channel ?? null }
  }
  return { id: input.id, text: text.trim(), channel: null }
}

export function service(ctx, name) {
  return typeof ctx.get === 'function' ? ctx.get(name) : ctx[name]
}
