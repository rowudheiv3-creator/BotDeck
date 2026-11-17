import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sender, FRAME_BYTES, SILENCE } from '../src/sender.js';

// virtual clock so the 20 ms pacing can be checked without waiting
function rig() {
  let t = 0; const timers = [];
  const out = { pkts: [], speak: [] };
  const s = new Sender({
    encode: (f) => Buffer.from([f[0]]), send: (p) => out.pkts.push({ p, t }), speaking: (v) => out.speak.push(v),
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  });
  const advance = (ms) => { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const h = timers[0]; if (!h || h.at > end) break; timers.shift(); t = Math.max(t, h.at); h.fn(); } t = end; };
  return { s, out, advance, at: () => t };
}
const frame = (n) => Buffer.alloc(FRAME_BYTES, n);

test('starts after a 2-frame pre-roll, sends one packet per 20 ms and ends with silence', () => {
  const { s, out, advance } = rig();
  s.push(frame(1)); advance(100);
  assert.equal(out.pkts.length, 0, 'waits for the pre-roll');
  s.push(frame(2)); advance(20);
  assert.deepEqual(out.speak, [true]);
  assert.equal(out.pkts.length, 1);
  s.push(frame(3)); advance(20);
  assert.equal(out.pkts.length, 2);
  advance(400);
  assert.equal(out.pkts.length, 3 + 5, '3 audio packets then 5 silence frames');
  assert.deepEqual(out.pkts.slice(3).map((x) => x.p), Array(5).fill(SILENCE));
  assert.deepEqual(out.speak, [true, false]);
});

test('latency is bounded: a flood is trimmed to the newest 8 frames', () => {
  const { s, out, advance } = rig();
  for (let i = 0; i < 40; i++) s.push(frame(i));
  assert.equal(s.dropped, 32);
  advance(1000);
  const audio = out.pkts.filter((x) => x.p !== SILENCE).map((x) => x.p[0]);
  assert.deepEqual(audio, [32, 33, 34, 35, 36, 37, 38, 39], 'keeps the newest audio, in order');
});

test('packets are paced about 20 ms apart even if the browser sends in bursts', () => {
  const { s, out, advance } = rig();
  s.push(Buffer.concat([frame(1), frame(2), frame(3), frame(4)]));
  advance(200);
  const times = out.pkts.filter((x) => x.p !== SILENCE).map((x) => x.t);
  assert.equal(times.length, 4);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 19 && times[i] - times[i - 1] <= 21, `gap ${times[i] - times[i - 1]}`);
});

test('bad sizes are rejected and stop() silences the stream', () => {
  const { s, out, advance } = rig();
  assert.equal(s.push(Buffer.alloc(100)), false);
  assert.equal(s.push(Buffer.alloc(0)), false);
  assert.equal(s.push(Buffer.alloc(FRAME_BYTES * 9)), false);
  s.push(frame(1)); s.push(frame(2)); s.push(frame(3)); advance(10);
  s.stop();
  assert.deepEqual(out.speak, [true, false]);
  advance(500);
  assert.equal(out.pkts.length, 1, 'nothing is sent after stop');
});

test('an encoder failure never throws out of the timer', () => {
  let t = 0; const timers = [];
  const s = new Sender({ encode: () => { throw new Error('boom'); }, send: () => assert.fail('no send'), speaking: () => {}, now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.at(-1); }, clearTimer: () => {} });
  s.push(frame(1)); s.push(frame(2));
  for (let i = 0; i < 5; i++) { t += 20; const h = timers.shift(); if (h) h.fn(); }
});
