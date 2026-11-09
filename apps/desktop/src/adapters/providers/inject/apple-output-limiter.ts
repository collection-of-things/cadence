/** AudioWorklet source for a stereo-linked lookahead peak limiter. */
export const APPLE_OUTPUT_LIMITER_JS = String.raw`
class CadenceAppleLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.delay = Math.max(1, Math.round(sampleRate * 0.005));
    this.size = this.delay + 1;
    this.left = new Float32Array(this.size);
    this.right = new Float32Array(this.size);
    this.peaks = new Float32Array(this.size + 1);
    this.indices = new Float64Array(this.size + 1);
    this.head = 0;
    this.tail = 0;
    this.frame = 0;
    this.gain = 1;
    // Leave 0.1 dB before the browser output clamp. Below this ceiling,
    // gain is exactly unity until a future overrange peak needs protection.
    this.ceiling = Math.pow(10, -0.1 / 20);
    this.attack = Math.exp(-1 / (sampleRate * 0.0005));
    this.release = Math.exp(-1 / (sampleRate * 0.05));
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'reset') this.reset();
    };
  }
  reset() {
    this.left.fill(0);
    this.right.fill(0);
    this.head = this.tail = this.frame = 0;
    this.gain = 1;
  }
  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const capacity = this.peaks.length;
    for (let i = 0; i < output[0].length; i++) {
      const l = input[0] ? input[0][i] : 0;
      const r = input[1] ? input[1][i] : l;
      const peak = Math.max(Math.abs(l), Math.abs(r));
      // A monotone queue finds the largest peak in the delayed sample's
      // lookahead window without allocating or scanning the audio ring.
      while (this.head !== this.tail && this.indices[this.head] < this.frame - this.delay) {
        this.head = (this.head + 1) % capacity;
      }
      while (this.head !== this.tail) {
        const back = (this.tail + capacity - 1) % capacity;
        if (this.peaks[back] > peak) break;
        this.tail = back;
      }
      this.peaks[this.tail] = peak;
      this.indices[this.tail] = this.frame;
      this.tail = (this.tail + 1) % capacity;
      const maximum = this.peaks[this.head];
      const target = maximum > this.ceiling ? this.ceiling / maximum : 1;
      const coefficient = target < this.gain ? this.attack : this.release;
      this.gain = target + coefficient * (this.gain - target);
      const slot = this.frame % this.size;
      this.left[slot] = l;
      this.right[slot] = r;
      const read = (slot + 1) % this.size;
      const dl = this.frame >= this.delay ? this.left[read] : 0;
      const dr = this.frame >= this.delay ? this.right[read] : 0;
      // Also bound the outgoing sample: a discontinuity or very large
      // impulse must not overshoot while the attack envelope converges.
      const outgoing = Math.max(Math.abs(dl), Math.abs(dr));
      if (outgoing * this.gain > this.ceiling) this.gain = this.ceiling / outgoing;
      output[0][i] = dl * this.gain;
      if (output[1]) output[1][i] = dr * this.gain;
      this.frame++;
    }
    return true;
  }
}
registerProcessor('cadence-apple-limiter', CadenceAppleLimiter);
`;
