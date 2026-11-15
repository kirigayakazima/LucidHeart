import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DuplexSession, FRAME_BYTES, asWav } from './session.js';
import { Silero } from './silero.js';
import { PCM16_BYTES, toFloat32 } from './vad_stream.js';
import { matchesPlayback } from './aec_guard.js';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript'],
  '/capture.js': ['capture.js', 'text/javascript'],
  '/echo.js': ['../lib/aec_guard.js', 'text/javascript'],
};

function json(res, status, result) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(result));
}

async function body(req, length) {
  if (Number(req.headers['content-length']) !== length) return null;
  const data = Buffer.alloc(length);
  let offset = 0;
  for await (const chunk of req) {
    if (offset + chunk.length > length) return null;
    chunk.copy(data, offset);
    offset += chunk.length;
  }
  return offset === length ? data : null;
}

const { values: options } = parseArgs({
  options: { port: { type: 'string', default: '8767' }, python: { type: 'string' }, model: { type: 'string' }, sha256: { type: 'string' } },
});
if (!options.python || !options.model || !/^[a-f0-9]{64}$/i.test(options.sha256 ?? '')) {
  throw new Error('Usage: node lib/server.js --python <onnxruntime Python> --model <Silero ONNX> --sha256 <digest> [--port 8767]');
}
const origin = `http://127.0.0.1:${options.port}`;
const token = randomBytes(24).toString('base64url');
const session = new DuplexSession();
const vad = new Silero(options);
const asrUrl = process.env.DUPLEX_ASR_URL ? new URL(process.env.DUPLEX_ASR_URL) : null;
if (asrUrl && (asrUrl.protocol !== 'http:' || asrUrl.hostname !== '127.0.0.1' || asrUrl.pathname !== '/v1/voice/asr')) {
  vad.close();
  throw new Error('ASR must use the local FullAwake /v1/voice/asr endpoint');
}
let busy = false;
let transcription = null;
let pendingAsr = null;
let captureUpdate;
let captureTail = Promise.resolve();
const hostCapture = process.env.DUPLEX_FORWARD_TO_HOST === '1' && asrUrl;
const route = process.env.DUPLEX_AUDIO_ROUTE === 'headphone' ? 'headphone' : 'speaker';
const asrAuth = `Bearer ${process.env.DUPLEX_ASR_TOKEN ?? ''}`;
let playbackReference;
let referenceRequest = false;
async function refreshReference() {
  if (referenceRequest) return;
  referenceRequest = true;
  const sent = performance.now();
  try {
    const response = await fetch(new URL('/v1/voice/capture/reference', asrUrl), {
      headers: { Authorization: asrAuth }, redirect: 'error', signal: AbortSignal.timeout(250),
    });
    if (!response.ok) return;
    const result = await response.json();
    playbackReference = null;
    if (result.active && result.pcm) {
      const pcm = Buffer.from(result.pcm, 'base64');
      const samples = Float32Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2) / 32768);
      playbackReference = { samples, offset: result.offset, at: (sent + performance.now()) / 2 };
    }
  } catch {
    playbackReference = null;
  } finally { referenceRequest = false; }
}
const referenceTimer = hostCapture && route === 'speaker' ? setInterval(refreshReference, 120) : null;
referenceTimer?.unref();

function publishCapture(client, epoch, turnId = '') {
  if (!hostCapture) return;
  const url = new URL('/v1/voice/capture', asrUrl);
  url.search = new URLSearchParams({ capture: client, audio_epoch: epoch, turn_id: turnId });
  const request = captureTail.then(() => fetch(url, { method: 'POST', headers: { Authorization: asrAuth },
    redirect: 'error', signal: AbortSignal.timeout(2000) })).then(response => response.ok, () => false);
  captureTail = request;
  captureUpdate = { epoch, request };
}

function transcribe(client, epoch, complete, isFinal) {
  if (!asrUrl) return;
  pendingAsr?.abort();
  const controller = new AbortController();
  pendingAsr = controller;
  transcription = null;
  const { turnId, pcm } = complete;
  const signal = AbortSignal.any([controller.signal, session.lifecycle.capture().signal, AbortSignal.timeout(5000)]);
  const headers = { 'Content-Type': 'audio/wav', Authorization: asrAuth };
  const update = captureUpdate;
  void Promise.resolve(update?.epoch === epoch && update.request).then(linked => {
    signal.throwIfAborted();
    if (linked) Object.assign(headers, { 'X-FullAwake-Capture': client, 'X-FullAwake-Capture-Epoch': String(epoch),
      'X-FullAwake-ASR-Final': isFinal ? '1' : '0' });
    return fetch(asrUrl, { method: 'POST', headers, body: asWav(pcm), signal, redirect: 'error' });
  })
    .then(async response => {
      if (!response.ok) throw new Error(`ASR returned ${response.status}`);
      const result = await response.json();
      if (!signal.aborted && session.isCurrent(client) && session.lifecycle.accepts(epoch)) {
        const text = result.ok && typeof result.text === 'string' ? result.text.slice(0, 1500) : '';
        transcription = { turnId, epoch, status: text ? (isFinal ? 'final' : 'draft') : 'unclear', text,
          is_final: Boolean(text && isFinal) };
      }
    }).catch(() => {
      if (!controller.signal.aborted && session.isCurrent(client) && session.lifecycle.accepts(epoch)) {
        transcription = { turnId, epoch, status: 'unavailable', is_final: false };
      }
    }).finally(() => {
      if (pendingAsr === controller) pendingAsr = null;
    });
}

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { status: 'forbidden' });
    const url = new URL(req.url, origin);
    const asset = Object.hasOwn(assets, url.pathname) && assets[url.pathname];
    if (req.method === 'GET' && asset) {
      const [file, contentType] = asset;
      const content = await readFile(new URL(`../web/${file}`, import.meta.url));
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(content);
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers.authorization !== `Bearer ${token}`) {
      return json(res, 403, { status: 'forbidden' });
    }
    const client = url.searchParams.get('client');
    const epoch = Number(url.searchParams.get('epoch'));
    const utterance = url.searchParams.get('utterance');
    if (url.pathname === '/play' && /^[a-f0-9-]{36}$/i.test(utterance ?? '')) {
      return json(res, 200, session.play(client, epoch, utterance));
    }
    if (url.pathname === '/stop') {
      const stopped = session.stop(client, epoch, utterance, url.searchParams.get('ended') === '1');
      if (session.isCurrent(client) && stopped.epoch === epoch + 1) publishCapture(client, stopped.epoch);
      return json(res, 200, stopped);
    }
    if (url.pathname === '/disconnect') {
      const stopped = session.disconnect(client);
      if (!stopped) return json(res, 409, { status: 'stale' });
      pendingAsr?.abort();
      transcription = null;
      publishCapture(client, stopped.audio_epoch);
      return json(res, 200, { status: 'disconnected', epoch: stopped.audio_epoch });
    }
    if (url.pathname !== '/frame' && url.pathname !== '/connect') return json(res, 404, { status: 'missing' });
    if (busy) return json(res, 409, { status: 'busy' });
    busy = true;
    try {
      if (url.pathname === '/connect') {
        pendingAsr?.abort();
        transcription = null;
        await vad.reset();
        const connected = session.connect();
        publishCapture(connected.client, connected.epoch);
        return json(res, 200, connected);
      }
      const sequence = Number(url.searchParams.get('seq'));
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !session.accepts(client, epoch, sequence)) {
        return json(res, 409, { status: 'stale', epoch: session.lifecycle.epoch });
      }
      const pcm16 = url.searchParams.get('format') === 's16le';
      const input = await body(req, pcm16 ? PCM16_BYTES : FRAME_BYTES);
      if (!input) return json(res, 400, { status: 'invalid_frame' });
      const pcm = pcm16 ? toFloat32(input) : input;
      const reference = playbackReference;
      const elapsed = reference ? performance.now() - reference.at : Infinity;
      const echo = url.searchParams.get('echo') === '1' || (elapsed < 220 && matchesPlayback(
        Float32Array.from({ length: 512 }, (_, i) => pcm.readFloatLE(i * 4)), reference.samples,
        reference.offset + Math.round(elapsed * 16) - 512));
      const probability = await vad.score(echo ? Buffer.alloc(FRAME_BYTES) : pcm);
      const { complete, draft, ...event } = session.feed({ client, epoch, sequence, pcm, probability, echo });
      if (event.listening && event.epoch !== epoch) {
        pendingAsr?.abort();
        transcription = null;
        publishCapture(client, event.epoch, event.turnId);
      }
      if (complete) transcribe(client, event.epoch, complete, true);
      else if (draft) transcribe(client, event.epoch, { turnId: event.turnId, pcm: draft }, false);
      const final = transcription?.epoch === event.epoch ? transcription : null;
      if (final) transcription = null;
      return json(res, 200, { ...event, probability, echo, completed: Boolean(complete), transcription: final });
    } finally {
      busy = false;
    }
  } catch (error) {
    console.error('Duplex request failed:', error.message);
    if (!res.headersSent) json(res, 503, { status: 'unavailable' });
  }
});
server.requestTimeout = 3000;
try {
  await vad.ready;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(options.port), '127.0.0.1', resolve);
  });
} catch (error) {
  vad.close();
  throw error;
}
console.log(`Voice duplex sandbox: ${origin}/#${token}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    pendingAsr?.abort();
    if (referenceTimer) clearInterval(referenceTimer);
    server.close();
    vad.close();
  });
}
