import { randomUUID } from 'node:crypto';
import { AudioLifecycle } from './lifecycle.js';
import { FRAME_MS, FRAME_SAMPLES, VadStream } from './vad_stream.js';
export { FRAME_MS, FRAME_SAMPLES };

export const FRAME_BYTES = FRAME_SAMPLES * 4;
const LEASE_MS = 1500;

export class DuplexSession {
  lifecycle = new AudioLifecycle();
  #client = null;
  #playback = null;
  #vad = new VadStream();
  #lastFrame = 0;
  #sequence = -1;
  #dropped = 0;

  connect(now = performance.now()) {
    this.#client = randomUUID();
    this.lifecycle.advance('new connection');
    this.#sequence = -1;
    this.#dropped = 0;
    this.#lastFrame = now;
    this.#playback = null;
    this.#vad.reset();
    return { client: this.#client, epoch: this.#epoch };
  }

  isCurrent(client) {
    return this.#client !== null && this.#client === client;
  }

  accepts(client, epoch, sequence, now = performance.now()) {
    return this.isCurrent(client) && epoch === this.#epoch && sequence > this.#sequence && now - this.#lastFrame < LEASE_MS;
  }

  play(client, epoch, utteranceId, now = performance.now()) {
    if (!this.isCurrent(client) || epoch !== this.#epoch || now - this.#lastFrame >= LEASE_MS) return { status: 'stale', epoch: this.#epoch };
    if (this.#vad.listening) return { status: 'listening', epoch: this.#epoch };
    this.#playback = { utteranceId, at: now };
    return { status: 'playing', epoch };
  }

  get #epoch() { return this.lifecycle.epoch; }

  stop(client, epoch, utteranceId, ended = false) {
    if (this.isCurrent(client) && epoch === this.#epoch && utteranceId === this.#playback?.utteranceId) {
      this.#playback = null;
      if (!ended) this.cancel();
    }
    return { epoch: this.#epoch };
  }

  cancel() {
    this.#playback = null;
    this.#vad.reset();
    return this.lifecycle.advance('user cancelled audio');
  }

  disconnect(client) {
    if (!this.isCurrent(client)) return null;
    this.#client = null;
    return this.cancel();
  }

  feed({ client, epoch, sequence, pcm, probability, echo = false }, now = performance.now()) {
    if (!this.accepts(client, epoch, sequence, now)) return { status: 'stale', epoch: this.#epoch };
    this.#dropped += sequence - this.#sequence - 1;
    this.#sequence = sequence;
    this.#lastFrame = now;
    let interrupt = null;
    const { complete, turnId, draft } = this.#vad.feed(pcm, probability, { echo, onStart: () => {
      if (this.#playback) {
        interrupt = { utteranceId: this.#playback.utteranceId, playbackMs: Math.round(now - this.#playback.at) };
        this.#playback = null;
      }
      this.lifecycle.advance(interrupt ? 'barge-in' : 'new turn');
    } });
    return {
      status: 'ok', epoch: this.#epoch, listening: this.#vad.listening,
      turnId, interrupt, complete, draft,
      droppedFrames: this.#dropped,
    };
  }
}

export function asWav(pcm) {
  const bytes = pcm.length / 2;
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const audio = Buffer.allocUnsafe(bytes);
  for (let offset = 0; offset < pcm.length; offset += 4) {
    const sample = Math.max(-1, Math.min(1, pcm.readFloatLE(offset)));
    audio.writeInt16LE(Math.round(sample * 32767), offset / 2);
  }
  return Buffer.concat([header, audio]);
}
