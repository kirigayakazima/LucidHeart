import { ConversationChannels } from './schema.js';

const MAX_SNIPPET = 2000;
const CONTEXT_KINDS = new Set(['time-context', 'runtime-context', 'skill-catalog', 'tool']);
const identifier = value => typeof value === 'string' && value.trim() && value.length <= 256 ? value : null;

export function isInjectedMessage(message) {
  const source = message?.source;
  return CONTEXT_KINDS.has(source?.kind) || (source?.kind === 'plugin' && Boolean(source.form));
}

function boundedSnippet(text) {
  if (!text) return null;
  if (text.length <= MAX_SNIPPET) return text;
  const head = text.slice(0, MAX_SNIPPET);
  const lastBoundary = Math.max(...Array.from('。！？!?；;\n', mark => head.lastIndexOf(mark)));
  return lastBoundary < 0 ? null : head.slice(0, lastBoundary + 1);
}

/** QQ marks the actual inbound text inside the model-facing envelope. */
export function readQqUtterance(message) {
  const qq = message?.source?.qq;
  const block = message?.content?.[0];
  const speaker = identifier(qq?.speaker)?.trim();
  if (!ConversationChannels.includes(qq?.channel) || !speaker || block?.type !== 'text' ||
      typeof block.text !== 'string' || !Number.isSafeInteger(qq.start) || !Number.isSafeInteger(qq.length) ||
      qq.start < 0 || qq.length <= 0 || qq.start > block.text.length - qq.length) return;
  const text = block.text.slice(qq.start, qq.start + qq.length).trim();
  if (text) return { text, speaker, channel: qq.channel };
}

function currentEvent(events, callId) {
  let turnStart;
  let rootCall;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === 'turn/end' || event?.type === 'session/end-seed') return null;
    if (event?.type === 'turn/start') {
      turnStart = i;
      break;
    }
    if (rootCall === undefined && callId && event?.type === 'tool/call' && event.data?.callId === callId) rootCall = i;
  }
  if (turnStart === undefined || (callId && rootCall === undefined)) return null;
  const turn = events[turnStart].data?.turn;
  if (rootCall !== undefined && events[rootCall].data?.turn !== turn) return null;

  for (let i = (rootCall ?? events.length) - 1; i > turnStart; i--) {
    const event = events[i];
    if (event?.type !== 'user/message') continue;
    if (isInjectedMessage(event.data)) continue;
    return event;
  }
  return null;
}

function sourceOrigin(kind) {
  if (kind === 'user') return 'user_request';
  if (kind === 'schedule' || kind === 'plugin') return 'autonomous';
  if (kind === 'external') return 'external';
  return 'unknown';
}

/** Resolve the current consumed message from the host, never from tool arguments. */
export function resolveHostContext(exec, acceptedEvent) {
  const agent = exec?.agent;
  const session = agent?.session;
  const sessionId = identifier(session?.id) ?? identifier(session?.header?.id) ?? identifier(agent?.id);
  let event;
  if (session && !exec.signal?.aborted) {
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events;
      if (Array.isArray(events)) {
        event = currentEvent(events, exec.rootCallId ?? exec.callId);
      } else if (acceptedEvent?.type === 'user/message') {
        // Older hosts can expose the event to the listener without a readable log.
        event = acceptedEvent;
      }
    } catch {}
  }
  const message = event?.data;
  const origin = sourceOrigin(message?.role === 'user' ? message.source?.kind : null);
  const qq = origin === 'user_request' ? readQqUtterance(message) : null;
  const observedAt = typeof event?.time === 'number' && event.time > 0 ? new Date(event.time) : null;
  const plain = origin === 'user_request' && !message?.source?.qq && Array.isArray(message?.content)
    ? message.content.find(block => block?.type === 'text' && typeof block.text === 'string')?.text.trim()
    : null;
  return {
    sessionId,
    channel: qq?.channel ?? null,
    speaker: qq?.speaker ?? null,
    messageId: identifier(message?.id),
    observedAt: observedAt && Number.isFinite(observedAt.getTime()) ? observedAt.toISOString() : null,
    rawSnippet: boundedSnippet(qq?.text ?? plain),
    origin,
  };
}
