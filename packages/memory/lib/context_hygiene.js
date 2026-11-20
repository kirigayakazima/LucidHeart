import { estimateTokens, pruneToolOutput } from './budget.js';

export const FOLD_AT = 28_000;
export const CHECKPOINT_AT = 42_000;
const HEAVY_RECEIPTS = 6;
const LARGE_TOOL_TEXT = 400;
const imageCost = 384;
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
const measured = new WeakMap();

export function sessionEvents(session) {
  return session?.snapshotEvents?.() ?? session?.events ?? [];
}

function details(blocks, tool = false) {
  return (blocks ?? []).reduce((stats, block) => {
    if (block.type === 'image') stats.images++;
    if (block.type === 'text' || block.type === 'reasoning') {
      stats.text += estimateTokens(block.text);
      if (tool) stats.chars += block.text?.length ?? 0;
    }
    if (block.type === 'tool-call') stats.calls += estimateTokens(block.name) + estimateTokens(block.arguments);
    if (block.type === 'tool-result') {
      const nested = details(block.content, true);
      stats.tools += nested.text;
      stats.images += nested.images;
      stats.chars += nested.chars;
    }
    return stats;
  }, { text: 0, calls: 0, tools: 0, images: 0, chars: 0 });
}

function messageSize(message) {
  let result = measured.get(message);
  if (!result || !Object.isFrozen(message)) {
    result = details(message.content, message.source?.kind === 'tool');
    if (Object.isFrozen(message)) measured.set(message, result);
  }
  return result;
}

export function measureContext(messages, fixedTokens = 0) {
  const parts = { user: 0, assistant: 0, tools: 0, images: 0, other: fixedTokens };
  let imageCount = 0;
  for (const message of messages) {
    const size = messageSize(message);
    const category = message.source?.kind === 'tool' ? 'tools' : message.role === 'assistant' ? 'assistant'
      : message.role === 'user' ? 'user' : 'other';
    parts[category] += size.text;
    parts.tools += size.tools + size.calls;
    parts.images += size.images * imageCost;
    imageCount += size.images;
  }
  const tokens = Object.values(parts).reduce((sum, count) => sum + count, 0);
  return { tokens, parts, imageCount };
}

function indexEvents(events) {
  const messages = new Map(), tools = new Map();
  let turn = 0;
  for (const event of events) {
    if (event.type === 'turn/start') turn++;
    if (event.type === 'tool/call') tools.set(event.data?.callId, event.data?.name);
    if (['assistant/message', 'tool/result', 'user/message'].includes(event.type)) {
      const message = event.data?.message ?? event.data;
      if (message?.id) messages.set(message.id, { turn, time: event.time });
      for (const block of message?.content ?? []) {
        if (block.type === 'tool-call') tools.set(block.id, block.name);
      }
    }
  }
  return { messages, tools, turn };
}

function foldBlocks(blocks, tools, when, name = '用户或助手附件') {
  return blocks.map(block => {
    if (block.type === 'image') return { type: 'text', text: `[历史画面已折叠: ${name}${when}]` };
    if (block.type !== 'tool-result') return block;
    const tool = tools.get(block.toolCallId) || 'tool';
    const folded = foldBlocks(block.content, tools, when, tool);
    const isReceiptText = index => block.content[index].type === 'text';
    const longText = block.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (longText.length > LARGE_TOOL_TEXT) {
      const first = block.content.findIndex((_, index) => isReceiptText(index));
      return { ...block, content: folded.flatMap((item, index) => !isReceiptText(index) ? [item]
        : index === first ? [{ type: 'text', text: pruneToolOutput(longText, 280) }] : []) };
    }
    return { ...block, content: folded };
  });
}

/** A session-local projection. Batches replace model-facing blocks while preserving durable messages and call IDs. */
export class ContextHygiene {
  #folded = new Map();

  reset() { this.#folded.clear(); }

  view(messages) { return this.#folded.size ? messages.map(message => this.#folded.get(message.id) ?? message) : messages; }

  project(messages, events, fixedTokens = 0) {
    const view = this.view(messages);
    const usage = measureContext(view, fixedTokens);
    const indexed = indexEvents(events);
    const eligible = view.filter(message => {
      const item = indexed.messages.get(message.id);
      if (!item || item.turn === 0 || item.turn > indexed.turn - 2 || this.#folded.has(message.id)) return false;
      const size = messageSize(message);
      return size.images > 0 || size.chars > LARGE_TOOL_TEXT;
    });
    if (eligible.length < HEAVY_RECEIPTS && usage.tokens < FOLD_AT) return view;
    for (const message of eligible) {
      const time = indexed.messages.get(message.id).time;
      const when = Number.isFinite(time) ? ` @ ${clock.format(time)}` : '';
      const content = foldBlocks(message.content, indexed.tools, when);
      this.#folded.set(message.id, Object.freeze({ ...message, content }));
    }
    return eligible.length ? this.view(messages) : view;
  }
}

export function contextHealth(messages, projected, fixedTokens = 0) {
  const raw = measureContext(messages, fixedTokens);
  const current = projected === messages ? raw : measureContext(projected, fixedTokens);
  return {
    rawTokens: raw.tokens, projectedTokens: current.tokens, imageCount: current.imageCount, rawImageCount: raw.imageCount,
    parts: current.parts,
    percentages: Object.fromEntries(Object.entries(current.parts).map(([name, tokens]) =>
      [name, current.tokens ? Number((tokens * 100 / current.tokens).toFixed(1)) : 0])),
    tokensUntilFold: Math.max(0, FOLD_AT - current.tokens),
    tokensUntilCheckpoint: Math.max(0, CHECKPOINT_AT - current.tokens),
  };
}
