// Paces microphone / soundpad audio into a Discord voice connection with a small jitter buffer.
// The browser sends 20 ms PCM frames whenever it likes (network jitter); Discord wants a steady
// packet every 20 ms. We hold at most MAX_QUEUE frames (so latency can never pile up), start after
// PRE_ROLL frames, send on a self-correcting 20 ms clock and close the stream with silence frames.
export const FRAME_BYTES = 3840; // 20 ms, 48 kHz, stereo, s16le
export const SAMPLES = 960;
export const SILENCE = Buffer.from([0xf8, 0xff, 0xfe]);

const MAX_QUEUE = 8;   // 160 ms ceiling
const PRE_ROLL = 2;    // 40 ms before the first packet
const GAP_TICKS = 3;   // tolerate 60 ms without data mid-speech
const END_TICKS = 10;  // 200 ms without data = end of the utterance

export class Sender {
  /** encode(pcmFrame) -> opus Buffer; send(opus); speaking(bool); now() for tests */
  constructor({ encode, send, speaking, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout }) {
    Object.assign(this, { encode, send, speaking, now, setTimer, clearTimer });
    this.q = []; this.state = 'idle'; this.empty = 0; this.timer = null; this.next = 0; this.sent = 0; this.dropped = 0;
  }

  /** Accepts one or several whole 20 ms frames. */
  push(buf) {
    if (!buf || !buf.length || buf.length % FRAME_BYTES || buf.length > FRAME_BYTES * 8) return false;
    for (let o = 0; o < buf.length; o += FRAME_BYTES) {
      this.q.push(buf.subarray(o, o + FRAME_BYTES));
      while (this.q.length > MAX_QUEUE) { this.q.shift(); this.dropped++; }
    }
    if (!this.timer) { this.next = this.now(); this.schedule(); }
    return true;
  }

  schedule() {
    const wait = Math.max(0, this.next - this.now());
    this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, wait);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  tick() {
    this.next += 20;
    if (this.now() - this.next > 100) this.next = this.now() + 20; // fell behind (event loop stall): resync, don't burst
    if (this.state === 'idle') {
      if (this.q.length < PRE_ROLL) { if (!this.q.length) return; this.schedule(); return; }
      this.state = 'playing'; this.empty = 0; this.speaking(true);
    }
    if (this.q.length) {
      this.empty = 0;
      let pkt; try { pkt = this.encode(this.q.shift()); } catch { pkt = null; }
      if (pkt && pkt.length) { this.send(pkt); this.sent++; }
    } else if (++this.empty >= END_TICKS) {
      for (let i = 0; i < 5; i++) this.send(SILENCE);
      this.speaking(false); this.state = 'idle'; this.empty = 0;
      return; // timer stops; the next push restarts it
    } else if (this.empty <= GAP_TICKS) {
      // short gap: wait for the next frame without sending anything
    }
    this.schedule();
  }

  stop() {
    this.clearTimer(this.timer); this.timer = null; this.q.length = 0;
    if (this.state === 'playing') { try { this.speaking(false); } catch { /* connection already gone */ } }
    this.state = 'idle'; this.empty = 0;
  }
}
