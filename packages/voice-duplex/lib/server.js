import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DuplexSession, FRAME_BYTES, asWav } from './session.js';
import { Silero } from './silero.js';

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript'],
  '/capture.js': ['capture.js', 'text/javascript'],
  '/echo.js': ['echo.js', 'text/javascript'],
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

function transcribe(client, epoch, complete) {
  if (!asrUrl) return;
  pendingAsr?.abort();
  const controller = new AbortController();
  pendingAsr = controller;
  transcription = null;
  const { turnId, pcm } = complete;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]);
  const headers = { 'Content-Type': 'audio/wav', Authorization: `Bearer ${process.env.DUPLEX_ASR_TOKEN ?? ''}` };
  void fetch(asrUrl, { method: 'POST', headers, body: asWav(pcm), signal, redirect: 'error' })
    .then(async response => {
      if (!response.ok) throw new Error(`ASR returned ${response.status}`);
      const result = await response.json();
      if (!controller.signal.aborted && session.isCurrent(client)) {
        const text = result.ok && typeof result.text === 'string' ? result.text.slice(0, 1500) : '';
        transcription = { turnId, epoch, status: text ? 'final' : 'unclear', text };
      }
    }).catch(() => {
      if (!controller.signal.aborted && session.isCurrent(client)) transcription = { turnId, epoch, status: 'unavailable' };
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
    if (url.pathname === '/stop') return json(res, 200, session.stop(client, epoch, utterance));
    if (url.pathname !== '/frame' && url.pathname !== '/connect') return json(res, 404, { status: 'missing' });
    if (busy) return json(res, 409, { status: 'busy' });
    busy = true;
    try {
      if (url.pathname === '/connect') {
        pendingAsr?.abort();
        transcription = null;
        await vad.reset();
        return json(res, 200, session.connect());
      }
      const sequence = Number(url.searchParams.get('seq'));
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !session.accepts(client, epoch, sequence)) {
        return json(res, 409, { status: 'stale' });
      }
      const pcm = await body(req, FRAME_BYTES);
      if (!pcm) return json(res, 400, { status: 'invalid_frame' });
      const echo = url.searchParams.get('echo') === '1';
      const probability = await vad.score(echo ? Buffer.alloc(FRAME_BYTES) : pcm);
      const { complete, ...event } = session.feed({ client, epoch, sequence, pcm, probability, echo });
      if (event.listening) {
        pendingAsr?.abort();
        transcription = null;
      }
      if (complete) transcribe(client, event.epoch, complete);
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
    server.close();
    vad.close();
  });
}
