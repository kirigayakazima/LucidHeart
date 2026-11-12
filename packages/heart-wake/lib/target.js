function pickAgent(agents, target) {
  if (target) return agents?.get?.(target) ?? null
  const list = agents?.list?.()
  if (!Array.isArray(list)) return null
  return list.find(agent => agent?.status === 'running') ?? list[0] ?? null
}

export function resolveWakeTarget(ctx, exec) {
  return exec?.agent ?? pickAgent(ctx.agents, '')
}

export function resolveWakeTurn(agent, exec) {
  const session = agent.session
  const rawId = session?.id ?? session?.header?.id ?? agent.id
  if (typeof rawId !== 'string') return null
  const sessionId = rawId.trim().replace(/^session-/, '')
  if (!sessionId) return null
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : session?.events
  if (!Array.isArray(events)) return null

  const start = events.findLastIndex(event => event?.type === 'turn/start' || event?.type === 'turn/end')
  if (events[start]?.type !== 'turn/start') {
    return !exec?.agent && agent.status === 'idle' ? { sessionId, turn: null, scheduledIds: [] } : null
  }
  const turn = events[start].data?.turn
  if (!Number.isSafeInteger(turn) || turn < 0) return null

  const current = events.slice(start + 1)
  const callId = exec?.agent && (exec.rootCallId ?? exec.callId)
  const call = callId ? current.findIndex(event =>
    event?.type === 'tool/call' && event.data?.callId === callId && event.data.turn === turn) : current.length
  if (call < 0) return null
  const scheduledIds = current.slice(0, call).flatMap(event => {
    const message = event?.data
    return event?.type === 'user/message' && message?.role === 'user' &&
      message.source?.kind === 'schedule' && typeof message.id === 'string' ? [message.id] : []
  })
  return { sessionId, turn, scheduledIds }
}
