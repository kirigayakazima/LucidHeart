import { matchesPlayback } from './echo.js';

const element = id => document.getElementById(id);
const token = location.hash.slice(1);
const pending = [];
const measurements = [];
let context;
let mic;
let worklet;
let session;
let playback;
let draining = false;
let dropped = 0;
let echoFrames = 0;
let peakQueue = 0;
let finalTurn = null;
let lastAck = 0;

async function post(route, params = {}, body) {
  const url = new URL(route, location.origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const reply = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body, signal: AbortSignal.timeout(1200),
  });
  if (!reply.ok) throw new Error((await reply.json()).status);
  return reply.json();
}

function updateMetrics() {
  const values = measurements.filter(row => row.interruptMs !== undefined).map(row => row.interruptMs).sort((a, b) => a - b);
  const percentile = p => values.length ? `${values[Math.ceil(values.length * p) - 1]} ms` : '—';
  element('metrics').textContent = `打断 ${values.length}/40 轮 · P50 ${percentile(0.50)} · P95 ${percentile(0.95)}\n队列峰值 ${peakQueue}/4 · 丢弃 ${dropped} 帧 · 回声抑制 ${echoFrames} 帧`;
}

function clearPlayback() {
  if (!playback) return;
  const current = playback;
  playback = null;
  current.node.stop();
  current.node.disconnect();
  element('stop').disabled = true;
  element('play').disabled = !session;
  return current;
}

function stop() {
  const current = clearPlayback();
  const active = session;
  if (current && active) void post('/stop', { ...active, utterance: current.id }).catch(error => {
    if (session === active) disconnect(error);
  });
}

function disconnect(error) {
  session = null;
  clearPlayback();
  pending.length = 0;
  mic?.getTracks().forEach(track => track.stop());
  worklet?.disconnect();
  if (context && context.state !== 'closed') void context.close();
  mic = worklet = context = null;
  element('connect').disabled = !token;
  element('disconnect').disabled = element('play').disabled = true;
  element('status').textContent = error?.message ? `连接已停止（${error.message}）` : '已断开';
}

async function drain() {
  if (draining || !session) return;
  const active = session;
  draining = true;
  try {
    while (session === active && pending.length) {
      const { samples, atFrame, sequence } = pending.shift();
      const current = playback;
      const echo = current && matchesPlayback(samples, current.reference, atFrame - current.startFrame);
      if (echo) echoFrames++;
      const result = await post('/frame', { ...active, seq: sequence, echo: echo ? 1 : 0 }, samples);
      if (session !== active) return;
      if (result.status !== 'ok') throw new Error(result.status);
      lastAck = performance.now();
      session.epoch = result.epoch;
      if (result.interrupt) {
        const stopped = playback?.id === result.interrupt.utteranceId ? clearPlayback() : null;
        dropped += pending.length;
        pending.length = 0;
        if (stopped) stopped.metric.interruptMs = Math.round((context.currentTime - atFrame / 16_000) * 1000);
      }
      if (result.completed) finalTurn = result.turnId;
      if (result.transcription?.turnId === finalTurn && result.transcription.epoch === session.epoch) {
        element('transcript').textContent = result.transcription.text || `ASR ${result.transcription.status}`;
      }
      element('status').textContent = result.listening ? `检测到讲话 · Epoch ${session.epoch}` : `正在监听 · Epoch ${session.epoch}`;
      updateMetrics();
    }
  } catch (error) {
    if (session === active) disconnect(error);
  } finally {
    draining = false;
    if (session && pending.length) void drain();
  }
}

element('connect').disabled = !token;
element('connect').onclick = async () => {
  element('connect').disabled = true;
  try {
    context = new AudioContext({ sampleRate: 16_000 });
    await context.resume();
    mic = await navigator.mediaDevices.getUserMedia({ audio: {
      channelCount: 1, echoCancellation: { exact: true }, noiseSuppression: true, autoGainControl: false,
    } });
    if (mic.getAudioTracks()[0].getSettings().echoCancellation !== true) throw new Error('当前音频设备未启用 AEC');
    await context.audioWorklet.addModule('/capture.js');
    session = await post('/connect');
    lastAck = performance.now();
    worklet = new AudioWorkletNode(context, 'capture-pcm');
    context.createMediaStreamSource(mic).connect(worklet).connect(context.destination);
    worklet.port.onmessage = ({ data }) => {
      if (!session) return;
      if (pending.length === 4) {
        pending.shift();
        dropped++;
      }
      pending.push(data);
      peakQueue = Math.max(peakQueue, pending.length);
      void drain();
    };
    worklet.onprocessorerror = () => disconnect(new Error('麦克风处理器停止'));
    mic.getAudioTracks()[0].onended = () => disconnect();
    element('disconnect').disabled = element('play').disabled = false;
    element('status').textContent = '麦克风已开启，设备 AEC 已确认';
  } catch (error) {
    disconnect(error);
  }
};
element('disconnect').onclick = () => disconnect();
element('stop').onclick = stop;
element('play').onclick = async () => {
  const file = element('file').files[0];
  if (!file || !session || playback) return;
  if (file.size > 30 * 1024 * 1024) {
    element('status').textContent = '请选择 30 MiB 以内的音频';
    return;
  }
  element('play').disabled = true;
  try {
    const audio = context;
    const active = session;
    const buffer = await audio.decodeAudioData(await file.arrayBuffer());
    const id = crypto.randomUUID();
    if (session !== active) return;
    const requested = performance.now();
    const result = await post('/play', { ...session, utterance: id });
    if (session !== active || result.epoch !== session.epoch || result.status !== 'playing') return;
    const node = audio.createBufferSource();
    node.buffer = buffer;
    node.connect(audio.destination);
    const start = audio.currentTime + 0.02;
    const reference = buffer.getChannelData(0).slice();
    if (buffer.numberOfChannels > 1) {
      const right = buffer.getChannelData(1);
      for (let i = 0; i < reference.length; i++) reference[i] = (reference[i] + right[i]) * 0.5;
    }
    const first = reference.findIndex(value => Math.abs(value) > 0.02);
    const metric = { utteranceId: id, firstAudibleEstimateMs: first < 0 ? null :
      Math.round(performance.now() - requested + (start - audio.currentTime + first / 16_000 + (audio.outputLatency ?? 0)) * 1000) };
    if (measurements.length === 200) measurements.shift();
    measurements.push(metric);
    playback = { node, id, reference, startFrame: Math.round(start * 16_000), metric };
    node.onended = () => { if (playback?.id === id) stop(); };
    node.start(start);
    element('stop').disabled = false;
  } catch (error) {
    disconnect(error);
  } finally {
    if (session && !playback) element('play').disabled = false;
  }
};
element('export').onclick = () => {
  const data = { sampleRate: 16000, frameMs: 32, echoFrames, peakQueue, dropped, measurements };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = 'voice-duplex-metrics.json';
  download.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
window.addEventListener('pagehide', () => disconnect());
setInterval(() => {
  if (session && performance.now() - lastAck >= 1500) disconnect(new Error('麦克风时钟租约已过期'));
}, 100);
