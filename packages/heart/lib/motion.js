export const motionIntents = Object.freeze(['nod', 'smile', 'wave']);

export function motionState(snapshot) {
  const presence = snapshot?.presence?.status;
  return {
    mode: ['asleep', 'resting'].includes(presence) ? 'resting' : presence === 'present' ? 'listening' : 'idle',
    energy: Math.min(1, Math.max(0, snapshot?.mood?.energy ?? 0.5)),
  };
}

export class PlaybackMotion {
  #rms = 0;
  #level = 0;
  #utteranceId = null;
  #lastPosition = 0;

  update(utteranceId, positionMs, samples) {
    if (utteranceId !== this.#utteranceId || positionMs < this.#lastPosition) this.reset();
    this.#utteranceId = utteranceId;
    this.#lastPosition = positionMs;
    let power = 0;
    for (const sample of samples) power += sample * sample;
    const rms = Math.sqrt(power / samples.length);
    this.#rms += (rms - this.#rms) * (rms > this.#rms ? 0.55 : 0.24);
    const low = this.#level === 0 ? 0.018 : 0.012;
    const high = this.#level === 2 ? 0.055 : 0.08;
    this.#level = this.#rms >= high ? 2 : this.#rms >= low ? 1 : 0;
    return { mode: 'speaking', utteranceId, positionMs: Math.round(positionMs), mouth: this.#level };
  }

  reset() {
    this.#rms = 0;
    this.#level = 0;
    this.#utteranceId = null;
    this.#lastPosition = 0;
  }
}

export function connectMotion(ctx, service, url) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/clock') {
    throw new Error('Widget clock must be a local /clock WebSocket');
  }
  let socket;
  let timer;
  let closed = false;
  let thinking = false;
  let lastIntent = -Infinity;
  const send = (value) => {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 2048) socket.send(JSON.stringify(value));
  };
  const refresh = () => {
    const state = motionState(service.getSnapshot());
    send(thinking && state.mode !== 'resting' ? { ...state, mode: 'thinking' } : state);
  };
  function connect() {
    socket = new WebSocket(endpoint);
    socket.addEventListener('open', refresh);
    socket.addEventListener('close', () => {
      if (!closed) timer = setTimeout(connect, 2000).unref();
    });
    socket.addEventListener('error', () => socket.close());
  }
  const offState = ctx.on('heart/state-changed', refresh);
  const activeTurns = new Set();
  const offTurn = ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') activeTurns.add(session);
    else if (event.type === 'turn/end') activeTurns.delete(session);
    else return;
    thinking = activeTurns.size > 0;
    refresh();
  }, { global: true });
  const offIntent = ctx.on('heart/motion-intent', intent => {
    const now = performance.now();
    if (motionIntents.includes(intent) && now - lastIntent >= 3000) {
      lastIntent = now;
      send({ intent });
    }
  });
  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket.close();
    offState?.();
    offTurn?.();
    offIntent?.();
  };
}
