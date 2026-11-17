// Microphone capture on the audio thread: collects 20 ms (960 frame) blocks of interleaved
// 16-bit stereo and posts them to the page. Replaces the deprecated ScriptProcessor (no 43 ms blocks).
class BdCap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(1920); this.fill = 0; }
  process(inputs) {
    const inp = inputs[0];
    if (!inp || !inp[0]) return true;
    const L = inp[0], R = inp[1] || L;
    for (let i = 0; i < L.length; i++) {
      const l = L[i] < -1 ? -1 : L[i] > 1 ? 1 : L[i], r = R[i] < -1 ? -1 : R[i] > 1 ? 1 : R[i];
      this.buf[this.fill++] = l * 32767; this.buf[this.fill++] = r * 32767;
      if (this.fill >= 1920) { const out = this.buf; this.buf = new Int16Array(1920); this.fill = 0; this.port.postMessage(out.buffer, [out.buffer]); }
    }
    return true;
  }
}
registerProcessor('bd-cap', BdCap);
