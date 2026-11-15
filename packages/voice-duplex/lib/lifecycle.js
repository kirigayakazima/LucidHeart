export class AudioLifecycle {
  #epoch = 0
  #controller = new AbortController()

  get epoch() { return this.#epoch }

  capture() {
    return { audio_epoch: this.#epoch, signal: this.#controller.signal }
  }

  accepts(epoch) { return epoch === this.#epoch && !this.#controller.signal.aborted }

  advance(reason) {
    const previous = this.#controller
    this.#controller = new AbortController()
    this.#epoch++
    previous.abort(new DOMException(reason, 'AbortError'))
    return this.capture()
  }
}
