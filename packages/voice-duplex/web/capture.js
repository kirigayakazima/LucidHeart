class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(512);
    this.offset = 0;
    this.sequence = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.frame[this.offset++] = Math.max(-1, Math.min(1, channel[i]));
      if (this.offset === this.frame.length) {
        this.port.postMessage({
          samples: this.frame, sequence: this.sequence++, atFrame: currentFrame + i + 1 - this.frame.length,
        }, [this.frame.buffer]);
        this.frame = new Float32Array(512);
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture-pcm', Capture);
