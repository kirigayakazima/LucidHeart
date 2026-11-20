import { CHECKPOINT_AT, FOLD_AT, ContextHygiene, contextHealth, sessionEvents } from './context_hygiene.js';
import { estimateTokens } from './budget.js';
import { collectExchanges, continuityIdentity, continuityKey, renderWorkingMemory, workingExchanges } from './working_memory.js';
import { getZonedParts } from './store.js';

const IDLE_MS = 15 * 60 * 1000;
const sessionId = session => session?.id ?? session?.header?.id;
const messagesFor = session => session?.deriveMessages?.() ?? session?.messages ?? sessionEvents(session).flatMap(event =>
  ['user/message', 'assistant/message', 'tool/result'].includes(event.type) && event.data
    ? [event.data.message ?? event.data] : []);

function get(ctx, name) {
  try { return ctx?.get?.(name) ?? ctx?.[name]; } catch { return undefined; }
}

export class ContextBudgetGuard {
  #states = new Map();
  #closed = false;

  constructor(ctx, workingMemory, scope, { retainFact } = {}) {
    this.ctx = ctx;
    this.workingMemory = workingMemory;
    this.scope = scope;
    this.retainFact = retainFact;
  }

  #state(agent) {
    const session = agent?.session;
    const id = sessionId(session);
    if (!id || this.#closed) return null;
    const existing = this.#states.get(id);
    if (existing?.session === session) return existing;
    clearTimeout(existing?.timer);
    const state = { agent, session, hygiene: new ContextHygiene(), fixedTokens: 0, injected: false, notes: new Map() };
    this.#states.set(id, state);
    return state;
  }

  sessionStarted(agent, source) {
    const state = this.#state(agent);
    if (state && ['clear', 'compact'].includes(source)) this.#reset(state);
  }

  #reset(state) {
    state.injected = false;
    state.hygiene.reset();
    state.checkpoint = undefined;
  }

  release(agent) {
    const id = sessionId(agent.session);
    const state = this.#states.get(id);
    if (state?.agent !== agent) return;
    clearTimeout(state.timer);
    this.#states.delete(id);
  }

  close() {
    this.#closed = true;
    for (const state of this.#states.values()) clearTimeout(state.timer);
    this.#states.clear();
  }

  claim(agent, message) {
    const state = this.#state(agent);
    if (!state) return '';
    const identity = continuityIdentity(message, this.scope, sessionId(state.session));
    state.identity = identity;
    clearTimeout(state.timer);
    if (!identity) return '';
    if (state.injected) return '';
    const working = this.workingMemory.load(identity);
    if (!working) state.injected = true;
    return working ? renderWorkingMemory(working) : '';
  }

  markInjected(agent) {
    const state = this.#state(agent);
    if (state) state.injected = true;
  }

  rememberReference(agent, message, type, entryId, value) {
    const state = this.#state(agent);
    const key = continuityKey(continuityIdentity(message, this.scope, sessionId(state?.session)));
    if (!key) return;
    state.notes.set(entryId, { key, type, value, at: Date.now() });
    if (state.notes.size > 32) state.notes.delete(state.notes.keys().next().value);
  }

  forgetReference(agent, entryId) {
    this.#states.get(sessionId(agent?.session))?.notes.delete(entryId);
  }

  projectRequest(options) {
    const state = this.#states.get(options?.sessionId);
    if (!state || options.purpose || !Array.isArray(options.messages)) return options;
    if (state.system !== options.system || state.tools !== options.tools) {
      state.system = options.system;
      state.tools = options.tools;
      state.fixedTokens = estimateTokens(options.system) + estimateTokens(options.tools && JSON.stringify(options.tools));
    }
    const messages = state.hygiene.project(options.messages, sessionEvents(state.session), state.fixedTokens);
    return messages === options.messages ? options : { ...options, messages };
  }

  stream(options, next) {
    const projected = this.projectRequest(options);
    const state = this.#states.get(options?.sessionId);
    if (state && !options.purpose) {
      const writable = Object.getOwnPropertyDescriptor(options, 'messages')?.writable;
      const freshArray = Array.isArray(options.messages) && !Object.isFrozen(options.messages) && Object.isExtensible(options.messages);
      state.liveProjection = Boolean(writable || freshArray);
      if (projected !== options) {
        if (writable) options.messages = projected.messages;
        else if (freshArray) projected.messages.forEach((message, index) => { options.messages[index] = message; });
      }
    }
    return next();
  }

  health(session) {
    const state = this.#states.get(sessionId(session));
    const messages = messagesFor(session);
    const metrics = contextHealth(messages, state?.hygiene.view(messages) ?? messages, state?.fixedTokens);
    const actual = state?.liveProjection ? metrics.projectedTokens : metrics.rawTokens;
    return { ...metrics, estimatedInputTokens: actual, providerProjection: state?.liveProjection ?? false,
      tokensUntilFold: Math.max(0, FOLD_AT - actual),
      tokensUntilCheckpoint: Math.max(0, CHECKPOINT_AT - actual), checkpoint: state?.checkpoint ?? null };
  }

  event(session, event) {
    const state = this.#states.get(sessionId(session));
    if (!state || state.session !== session) return;
    if (event.surfaceOp?.op === 'replace') this.#reset(state);
    if (event.type !== 'turn/end' || !state.identity) return;
    clearTimeout(state.timer);
    const { hour } = getZonedParts(new Date());
    const checkpoint = this.health(session).estimatedInputTokens >= CHECKPOINT_AT;
    if (checkpoint && state.checkpoint) return;
    const wait = checkpoint || (hour >= 1 && hour < 7) ? 0 : IDLE_MS;
    const identity = state.identity;
    state.timer = setTimeout(() => {
      void this.#save(state, identity, checkpoint).catch(() => {
        this.ctx.logger?.warn?.('[Memory] 上下文检查点未完成');
      });
    }, wait);
    state.timer.unref?.();
  }

  async #save(state, identity, checkpoint) {
    if (this.#closed || state.identity !== identity || this.#states.get(sessionId(state.session)) !== state) return;
    const key = continuityKey(identity);
    const events = sessionEvents(state.session);
    const recent = collectExchanges(events, message =>
      continuityKey(continuityIdentity(message, this.scope, sessionId(state.session))) === key);
    if (!recent.length) return;
    const notes = [...state.notes.values()].filter(note => note.key === key && Date.now() - note.at < 86_400_000);
    this.workingMemory.save(identity, {
      current_focus: recent.slice(-2).map(item => item.user),
      recent_exchanges: workingExchanges(recent),
      ...(notes.some(note => note.type === 'media') && { recent_media: notes.filter(note => note.type === 'media').map(note => note.value) }),
      ...(notes.some(note => note.type === 'thread') && { open_threads: notes.filter(note => note.type === 'thread').map(note => note.value) }),
    });
    if (!checkpoint) return;
    const record = { status: 'saved', estimatedInputTokens: this.health(state.session).estimatedInputTokens, factRetained: false };
    try {
      record.factRetained = Boolean(this.retainFact?.(events, { scope: this.scope,
        sessionId: sessionId(state.session), messageId: recent.at(-1).messageId }));
    } catch {
      record.factWriteFailed = true;
    }
    state.checkpoint = record;
    const { agent } = state;
    await agent.whenIdle?.();
    if (this.#closed || state.checkpoint !== record || this.#states.get(sessionId(state.session)) !== state) return;
    if (state.identity !== identity) {
      state.checkpoint = undefined;
      if (state.identity && agent.status === 'idle') this.event(state.session, { type: 'turn/end' });
      return;
    }
    let presetCompaction;
    try { presetCompaction = await get(this.ctx, 'presets')?.serviceFor?.(agent, 'compaction'); } catch {}
    const compaction = presetCompaction ?? get(agent.ctx, 'compaction') ?? get(this.ctx, 'compaction');
    if (typeof compaction?.compactNow !== 'function' || typeof agent.runMaintenance !== 'function') {
      state.checkpoint.status = 'manual';
    } else {
      try {
        const result = await compaction.compactNow({
          session: state.session, options: agent.options, runMaintenance: agent.runMaintenance.bind(agent),
        }, AbortSignal.timeout(60_000));
        if (result?.shadowedSeqs?.length) this.#reset(state);
        else if (state.checkpoint) state.checkpoint.status = 'manual';
      } catch {
        if (state.checkpoint) state.checkpoint.status = 'manual';
      }
    }
    if (state.checkpoint?.status === 'manual') state.checkpoint.action = '使用宿主压缩命令（QQ：/compact）';
    this.ctx.logger?.info?.('[Memory] context checkpoint %j', state.checkpoint ?? { status: 'compacted' });
  }
}
