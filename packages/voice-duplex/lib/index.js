import { AudioLifecycle } from './lifecycle.js'
import { createTranscriptGate, VadStream, PCM16_BYTES } from './vad_stream.js'

export const name = '@dsh/voice-duplex'

export function apply(ctx) {
  const sessions = new Map()
  const idOf = agent => agent?.session?.id ?? agent?.id
  const service = {
    remote(agent, { showDraft } = {}) {
      const id = idOf(agent)
      if (!id || typeof agent.followup !== 'function') throw new TypeError('A configured voice agent is required')
      sessions.get(id)?.close()
      const life = new AudioLifecycle()
      let epoch = -1
      let closed = false
      const gate = createTranscriptGate(life, { onDraft: showDraft, onFinal: (message, { signal }) => {
        signal.throwIfAborted()
        return agent.followup(message)
      } })
      const listener = {
        cancel() { life.advance('conversation cancelled') },
        close() {
          if (closed) return
          closed = true
          sessions.delete(id)
          listener.cancel()
        },
        open(event) {
          if (closed || event.audio_epoch < epoch || (event.audio_epoch === epoch && event.turnId)) return
          epoch = event.audio_epoch
          life.advance('new desktop capture')
          if (event.turnId) gate.open(event.turnId, life.epoch)
        },
        receive(event) {
          if (closed || event.audio_epoch !== epoch) return false
          if (event.is_final) gate.end(event.turnId)
          return gate.receive({ ...event, audio_epoch: life.epoch })
        },
      }
      sessions.set(id, listener)
      return listener
    },
    attach(agent, { score, recognize, stopPlayback = () => {}, showDraft } = {}) {
      const id = idOf(agent)
      if (!id || typeof agent.followup !== 'function' || typeof score !== 'function' || typeof recognize !== 'function') {
        throw new TypeError('Voice capture requires a host agent, VAD and ASR')
      }
      sessions.get(id)?.close()
      const life = new AudioLifecycle()
      const vad = new VadStream()
      const gate = createTranscriptGate(life, { onDraft: showDraft, onFinal: (message, { signal }) => {
        signal.throwIfAborted()
        return agent.followup(message)
      } })
      let busy = false
      let sequence = -1
      let closed = false
      const capture = {
        current: () => life.capture(),
        cancel() {
          vad.reset()
          life.advance('conversation cancelled')
          stopPlayback()
        },
        close() {
          if (closed) return
          closed = true
          sessions.delete(id)
          capture.cancel()
        },
        async feed({ pcm, audio_epoch, sequence: frameSequence, echo = false }) {
          if (closed || busy || !life.accepts(audio_epoch) || !Number.isSafeInteger(frameSequence) ||
              frameSequence <= sequence || !Buffer.isBuffer(pcm) || pcm.length !== PCM16_BYTES) return false
          busy = true
          sequence = frameSequence
          let event
          try {
            const probability = await score(echo ? Buffer.alloc(PCM16_BYTES) : pcm, life.capture().signal)
            if (!life.accepts(audio_epoch)) return false
            event = vad.feed(pcm, probability, { echo, onStart: () => {
              life.advance('new speech turn')
              stopPlayback()
            } })
            if (event.turnId && life.epoch !== audio_epoch) gate.open(event.turnId, life.epoch)
            if (!event.complete) return { ...life.capture(), turnId: event.turnId }
            gate.end(event.turnId)
          } finally { busy = false }
          const turn = life.capture()
          const result = await recognize(event.complete.pcm, turn.signal)
          return gate.receive({ ...result, turnId: event.turnId, audio_epoch: turn.audio_epoch })
        },
        transcript: gate.receive,
      }
      sessions.set(id, capture)
      return capture
    },
  }
  const unprovide = ctx.provide('voiceDuplex', service)
  const off = ctx.on('conversation/cancel', event => sessions.get(idOf(event?.agent ?? event))?.cancel())
  return () => {
    for (const capture of sessions.values()) capture.close()
    if (typeof off === 'function') off()
    if (typeof unprovide === 'function') unprovide()
  }
}
