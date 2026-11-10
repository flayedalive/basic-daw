// The compressor and dynamic-EQ processors, run in Node.

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkletModule, runProcessor } from "../../.claude/skills/daw-plugin/mock-audio.mjs";
import { sine, noise, rms, db, tone } from "./helpers.mjs";

const SR = 48000;
const at = (file) => new URL(`../../src/plugins/worklets/${file}`, import.meta.url).href;
await loadWorkletModule(at("compressor.js"), SR);
await loadWorkletModule(at("dyneq.js"), SR);
const comp = (x, params, y = x) => runProcessor("daw-compressor", [x, y], params, { sampleRate: SR });
const dyn = (x, params) => runProcessor("daw-dyneq", [x, x], params, { sampleRate: SR })[0];
const dbfs = (v) => Math.pow(10, v / 20);
/** Settled gain (dB) of a steady 1 kHz tone at `level` dBFS. */
const gainAt = (level, params, hz = 1000) => {
  const x = sine(SR, SR, hz, dbfs(level));
  const [y] = comp(x, { rms: 0, attack: 0.001, release: 0.05, ...params });
  return db(rms(y, SR / 2, SR) / rms(x, SR / 2, SR));
};

test("compressor: at ratio 1 the output is the input, bit for bit", () => {
  const x = noise(SR, 0.8, 3);
  const [y] = comp(x, { ratio: 1, threshold: -40 });
  for (let i = 0; i < x.length; i++) assert.ok(y[i] === x[i], `sample ${i} altered`);
});

test("compressor: the static curve is threshold + ratio, with a quadratic knee", () => {
  // Hard knee, 4:1 from -20: a level 12 dB over comes out 3 dB over.
  assert.ok(Math.abs(gainAt(-8, { threshold: -20, ratio: 4, knee: 0 }) + 9) < 0.1);
  assert.ok(Math.abs(gainAt(-30, { threshold: -20, ratio: 4, knee: 0 })) < 0.01, "below threshold must be unity");
  assert.ok(Math.abs(gainAt(0, { threshold: -20, ratio: 20, knee: 0 }) + 19) < 0.1);
  // 12 dB knee: at the threshold itself the reduction is slope × W / 8.
  assert.ok(Math.abs(gainAt(-20, { threshold: -20, ratio: 4, knee: 12 }) + (0.75 * 12) / 8) < 0.1);
  // …and above the knee it rejoins the hard-knee line.
  assert.ok(Math.abs(gainAt(-8, { threshold: -20, ratio: 4, knee: 12 }) + 9) < 0.1);
});

test("compressor: attack and release take the times they say", () => {
  // A step from quiet to loud and back; time to cover 63% of the change.
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < x.length; i++) x[i] = (i > SR * 0.5 && i < SR ? 1 : 0.01) * Math.sin((2 * Math.PI * 5000 * i) / SR);
  const [y] = comp(x, { threshold: -20, ratio: 100, knee: 0, attack: 0.02, release: 0.2, rms: 0 });
  const grAt = (t) => -db(rms(y, t * SR, t * SR + 96) / rms(x, t * SR, t * SR + 96));
  const full = grAt(0.95);
  assert.ok(Math.abs(grAt(0.52) / full - 0.632) < 0.08, `after one attack time: ${(grAt(0.52) / full).toFixed(2)} of the way`);
  assert.ok(Math.abs(grAt(1.2) / full - 0.368) < 0.08, `after one release time: ${(grAt(1.2) / full).toFixed(2)} remaining`);
});

test("compressor: makeup, parallel mix and the sidechain high-pass", () => {
  assert.ok(Math.abs(gainAt(-40, { threshold: -20, makeup: 6 }) - 6) < 0.01);
  // 50% mix of a signal compressed by 9 dB: (1 + 10^(-9/20)) / 2.
  assert.ok(Math.abs(gainAt(-8, { threshold: -20, ratio: 4, knee: 0, mix: 0.5 }) - db((1 + dbfs(-9)) / 2)) < 0.1);
  // A loud 50 Hz tone compresses hard — unless the detector is high-passed above it.
  const open = gainAt(-6, { threshold: -30, ratio: 8, knee: 0, attack: 0.03, release: 0.3 }, 50);
  const filtered = gainAt(-6, { threshold: -30, ratio: 8, knee: 0, attack: 0.03, release: 0.3, scHpf: 300 }, 50);
  assert.ok(open < -15 && filtered > -3, `50 Hz: ${open.toFixed(1)} dB without the filter, ${filtered.toFixed(1)} dB with it`);
});

test("compressor: auto-release lets go of one hit quickly but holds a dense passage", () => {
  const params = { threshold: -30, ratio: 8, knee: 0, attack: 0.002, release: 0.05, rms: 0 };
  const tail = (x, auto) => {
    const [y] = comp(x, { ...params, auto });
    const t = Math.round(1.7 * SR);
    return db(rms(y, t, t + 2400) / rms(x, t, t + 2400));
  };
  // Quiet tone throughout; loud until 1.5 s in the "dense" case, one 20 ms hit in the other.
  const make = (loudUntil, from = 0) => Float32Array.from({ length: SR * 2 }, (_, i) => (i >= from * SR && i < loudUntil * SR ? 1 : 0.02) * Math.sin((2 * Math.PI * 2000 * i) / SR));
  const dense = make(1.5);
  const hit = make(1.5, 1.48);
  assert.ok(Math.abs(tail(hit, 1)) < 3, `0.2 s after a single hit, auto is still ${tail(hit, 1).toFixed(1)} dB down`);
  assert.ok(tail(dense, 1) < tail(dense, 0) - 3 && tail(dense, 1) < tail(hit, 1) - 6, `after 1.5 s of limiting: auto ${tail(dense, 1).toFixed(1)} dB, fixed ${tail(dense, 0).toFixed(1)} dB`);
});

test("compressor: stereo-linked — both channels get the same gain", () => {
  const l = sine(SR, SR, 1000, 0.9);
  const r = sine(SR, SR, 1000, 0.09);
  const [yl, yr] = comp(l, { threshold: -20, ratio: 4 }, r);
  assert.ok(Math.abs(db(rms(yl, SR / 2, SR) / rms(l, SR / 2, SR)) - db(rms(yr, SR / 2, SR) / rms(r, SR / 2, SR))) < 0.01);
});

test("dynamic EQ: cuts its band when it is loud, by what was asked, and nothing else", () => {
  const mk = (ess) => {
    const x = sine(SR, SR, 300, 0.3);
    sine(SR, SR, 6500, ess).forEach((v, i) => (x[i] += v));
    return x;
  };
  const level = (y, hz) => db(tone(y, SR, hz, SR / 2, SR));
  const loud = mk(0.3);
  const y = dyn(loud, { frequency: 6500, q: 2, threshold: -30, range: 10 });
  assert.ok(Math.abs(level(y, 6500) - level(loud, 6500) + 10) < 0.3, `6.5 kHz cut by ${(level(loud, 6500) - level(y, 6500)).toFixed(2)} dB, range is 10`);
  assert.ok(Math.abs(level(y, 300) - level(loud, 300)) < 0.05, "300 Hz moved");
  // Just over the threshold: cut by exactly the overshoot.
  const mild = mk(dbfs(-26));
  const m = dyn(mild, { frequency: 6500, q: 2, threshold: -30, range: 10 });
  assert.ok(Math.abs(level(m, 6500) + 30) < 0.4, `a band 4 dB over the threshold came out at ${level(m, 6500).toFixed(2)} dB`);
  // Under the threshold: untouched, bit for bit.
  const quiet = mk(0.005);
  const q = dyn(quiet, { frequency: 6500, q: 2, threshold: -30, range: 10 });
  for (let i = 0; i < quiet.length; i++) assert.ok(q[i] === quiet[i]);
});

test("dynamic EQ: listen outputs only the band", () => {
  const x = sine(SR, SR, 300, 0.3);
  sine(SR, SR, 6500, 0.1).forEach((v, i) => (x[i] += v));
  const y = dyn(x, { frequency: 6500, q: 4, listen: 1 });
  assert.ok(Math.abs(db(tone(y, SR, 6500, SR / 2, SR)) - db(0.1)) < 0.1, "band should pass at 0 dB");
  assert.ok(db(tone(y, SR, 300, SR / 2, SR)) < db(0.3) - 35, "300 Hz should be far down");
});
