// Read host-owned session metadata, never tool arguments or message text.
// Unknown provenance stays subject to autonomous activity quotas.
const CONTEXT_SOURCES = new Set(['time-context', 'runtime-context', 'skill-catalog'])

function fromMessages(messages, events = false) {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (events ? item?.type !== 'user/message' : item?.role !== 'user') continue
    const message = events ? item.data : item
    const kind = message?.source?.kind
    if (CONTEXT_SOURCES.has(kind)) continue
    if (kind === 'user') return 'user_request'
    if (kind === 'schedule' || kind === 'plugin') return 'autonomous'
    // Do not look past a new, unrecognized trigger to an older human message.
    return 'unknown'
  }
  return 'unknown'
}

export function activityOrigin(execution) {
  try {
    const session = execution?.agent?.session
    if (!session) return 'unknown'
    // DSH 0.2 hosts expose snapshotEvents; older hosts expose events.
    const events = typeof session.snapshotEvents === 'function'
      ? session.snapshotEvents() : session.events
    const origin = fromMessages(events, true)
    if (origin !== null) return origin
    const messages = typeof session.deriveMessages === 'function'
      ? session.deriveMessages() : session.messages
    return fromMessages(messages) || 'unknown'
  } catch {
    return 'unknown'
  }
}
