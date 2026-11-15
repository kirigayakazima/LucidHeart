import { randomUUID } from 'node:crypto'

export const FRAME_MS = 32
export const FRAME_SAMPLES = 512
export const PCM16_BYTES = FRAME_SAMPLES * 2

export function toFloat32(pcm) {
  if (pcm.length !== PCM16_BYTES) throw new RangeError('Expected one 512-sample PCM16 frame')
  const result = Buffer.allocUnsafe(FRAME_SAMPLES * 4)
  for (let i = 0; i < FRAME_SAMPLES; i++) result.writeFloatLE(pcm.readInt16LE(i * 2) / 32768, i * 4)
  return result
}

export class VadStream {
  #turn = null
  #preRoll = []

  get listening() { return this.#turn !== null }

  reset() {
    this.#turn = null
    this.#preRoll = []
  }

  feed(pcm, probability, { echo = false, onStart } = {}) {
    const voiced = !echo && probability >= (this.listening ? .35 : .55)
    const frame = echo ? Buffer.alloc(pcm.length) : pcm
    if (voiced && !this.#turn) {
      this.#turn = { turnId: randomUUID(), frames: this.#preRoll, silence: 0 }
      this.#preRoll = []
      onStart?.()
    }
    if (!this.#turn) {
      this.#preRoll.push(frame)
      if (this.#preRoll.length > 4) this.#preRoll.shift()
      return { turnId: null, complete: null }
    }
    const turn = this.#turn
    turn.frames.push(frame)
    turn.silence = voiced ? 0 : turn.silence + FRAME_MS
    if (turn.silence < 200 && turn.frames.length < Math.floor(15000 / FRAME_MS)) {
      const draft = turn.frames.length === 25 ? Buffer.concat(turn.frames) : null
      return { turnId: turn.turnId, complete: null, draft }
    }
    this.#turn = null
    return { turnId: turn.turnId, complete: { turnId: turn.turnId, pcm: Buffer.concat(turn.frames) } }
  }
}

export function createTranscriptGate(lifecycle, { onDraft = () => {}, onFinal }) {
  let turn
  return {
    open(turnId, audio_epoch) {
      if (lifecycle.accepts(audio_epoch)) turn = { turnId, audio_epoch, ended: false, delivered: false }
    },
    end(turnId) { if (turn?.turnId === turnId) turn.ended = true },
    async receive({ turnId, audio_epoch, text, is_final }) {
      if (turn?.turnId !== turnId || turn.audio_epoch !== audio_epoch || turn.delivered ||
          !lifecycle.accepts(audio_epoch) || typeof text !== 'string' || typeof is_final !== 'boolean') return false
      const value = text.trim().slice(0, 1500)
      if (!is_final) {
        if (!turn.ended && turn.draft !== value) {
          turn.draft = value
          onDraft({ turnId, audio_epoch, text: value, is_final: false })
        }
        return false
      }
      if (!turn.ended || !value) return false
      turn.delivered = true
      await onFinal({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: value }], source: { kind: 'user' } },
        lifecycle.capture())
      return true
    },
  }
}
