import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DuplexSession, FRAME_BYTES, asWav } from '../lib/session.js';
import { Silero } from '../lib/silero.js';
import { matchesPlayback } from '../web/echo.js';

test('an echo preserves playback, speech cuts the epoch, and late frames cannot finish a turn', () => {
  const duplex = new DuplexSession();
  const { client, epoch } = duplex.connect(0);
  assert.deepEqual(duplex.play(client, epoch, 'song', 1), { status: 'playing', epoch });
  const pcm = Buffer.alloc(FRAME_BYTES);
  pcm.writeFloatLE(.5, 0);
  const send = (sequence, probability, options = {}) => duplex.feed({
    client, epoch, sequence, pcm, probability, ...options,
  }, 32 * (sequence + 1));
  assert.equal(send(0, .99, { echo: true }).interrupt, null);
  const cut = send(1, .99);
  assert.equal(cut.interrupt.utteranceId, 'song');
  assert.equal(cut.epoch, epoch + 1);
  assert.equal(send(2, .99).status, 'stale');
  for (let seq = 2; seq < 9; seq++) assert.equal(send(seq, 0, { epoch: cut.epoch }).complete, null);
  const final = send(9, 0, { epoch: cut.epoch });
  assert.equal(final.complete.turnId, cut.turnId);
  const wav = asWav(final.complete.pcm);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readInt16LE(44), 0);
  assert.equal(wav.readInt16LE(44 + 1024), 16384);
  assert.equal(duplex.play(client, cut.epoch, 'late', 2000).status, 'stale');
  const reconnected = duplex.connect(2000);
  assert.equal(duplex.isCurrent(client), false);
  assert.equal(duplex.play(reconnected.client, reconnected.epoch, 'new', 2001).status, 'playing');
});

test('residual echo guard matches delayed correlated audio and passes unrelated speech energy', () => {
  const reference = Float32Array.from({ length: 8192 }, (_, i) => .3 * Math.sin(i * .123) * Math.sin(i * .019));
  const mic = reference.slice(3000, 3512).map(sample => sample * .3);
  assert.equal(matchesPlayback(mic, reference, 3640), true);
  const other = Float32Array.from({ length: 512 }, (_, i) => .3 * Math.sin(i * .751));
  assert.equal(matchesPlayback(other, reference, 3640), false);
});

const { DUPLEX_TEST_PYTHON: python, DUPLEX_TEST_MODEL: model,
  DUPLEX_TEST_SHA256: sha256, DUPLEX_TEST_SPEECH: speech } = process.env;
test('real Silero ONNX separates silence from speech and cuts a real audio-frame stream', {
  skip: !(python && model && sha256 && speech) && 'Supply local Silero weights and a speech WAV',
}, async t => {
  const vad = new Silero({ python, model, sha256 });
  t.after(() => vad.close());
  await vad.ready;
  assert.ok(await vad.score(Buffer.alloc(FRAME_BYTES)) < .2);
  await vad.reset();
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', speech, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-']);
  const duplex = new DuplexSession();
  const { client, epoch } = duplex.connect(0);
  duplex.play(client, epoch, 'playback', 1);
  for (let offset = 0; offset + FRAME_BYTES <= pcm.length; offset += FRAME_BYTES) {
    const chunk = pcm.subarray(offset, offset + FRAME_BYTES);
    const probability = await vad.score(chunk);
    const sequence = offset / FRAME_BYTES;
    const frame = duplex.feed({ client, epoch, sequence, probability, pcm: chunk }, (sequence + 1) * 32);
    if (frame.interrupt) {
      assert.equal(frame.interrupt.utteranceId, 'playback');
      assert.equal(frame.epoch, epoch + 1);
      return;
    }
  }
  assert.fail('No speech detected in the local speech recording');
});
