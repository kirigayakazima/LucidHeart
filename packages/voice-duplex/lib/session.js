import { randomUUID } from 'node:crypto';

export const FRAME_SAMPLES = 512;
export const FRAME_MS = 32;
export const FRAME_BYTES = FRAME_SAMPLES * 4;
const TRAILING_SILENCE = 8;
const MAX_SPEECH_FRAMES = Math.floor(15_000 / FRAME_MS);
const LEASE_MS = 1500;

export class DuplexSession {
  #epoch = 0;
  #client = null;
  #playback = null;
  #speech = null;
  #preRoll = [];
  #lastFrame = 0;
  #sequence = -1;
  #dropped = 0;

  connect(now = performance.now()) {
    this.#client = randomUUID();
    this.#epoch++;
    this.#sequence = -1;
    this.#dropped = 0;
    this.#lastFrame = now;
    this.#playback = null;
    this.#speech = null;
    this.#preRoll = [];
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
    if (this.#speech) return { status: 'listening', epoch: this.#epoch };
    this.#playback = { utteranceId, at: now };
    return { status: 'playing', epoch };
  }

  stop(client, epoch, utteranceId) {
    if (this.isCurrent(client) && epoch === this.#epoch && utteranceId === this.#playback?.utteranceId) this.#playback = null;
    return { epoch: this.#epoch };
  }

  feed({ client, epoch, sequence, pcm, probability, echo = false }, now = performance.now()) {
    if (!this.accepts(client, epoch, sequence, now)) return { status: 'stale', epoch: this.#epoch };
    this.#dropped += sequence - this.#sequence - 1;
    this.#sequence = sequence;
    this.#lastFrame = now;
    const isVoice = !echo && probability >= (this.#speech ? 0.35 : 0.6);
    const audio = echo ? Buffer.alloc(FRAME_BYTES) : pcm;
    let interrupt = null;
    if (isVoice && !this.#speech) {
      if (this.#playback) {
        interrupt = { utteranceId: this.#playback.utteranceId, playbackMs: Math.round(now - this.#playback.at) };
        this.#playback = null;
        this.#epoch++;
      }
      this.#speech = { turnId: randomUUID(), frames: [...this.#preRoll], silence: 0 };
      this.#preRoll = [];
    }
    let complete = null;
    if (this.#speech) {
      this.#speech.frames.push(audio);
      this.#speech.silence = isVoice ? 0 : this.#speech.silence + 1;
      if (this.#speech.silence >= TRAILING_SILENCE || this.#speech.frames.length >= MAX_SPEECH_FRAMES) {
        const { turnId, frames } = this.#speech;
        complete = { turnId, pcm: Buffer.concat(frames) };
        this.#speech = null;
      }
    } else {
      this.#preRoll.push(audio);
      if (this.#preRoll.length > 4) this.#preRoll.shift();
    }
    return {
      status: 'ok', epoch: this.#epoch, listening: this.#speech !== null,
      turnId: this.#speech?.turnId ?? complete?.turnId ?? null, interrupt, complete,
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
