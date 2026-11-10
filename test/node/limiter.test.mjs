// The true-peak limiter's processor, run in Node against loud material.

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkletModule, runProcessor } from "../../.claude/skills/daw-plugin/mock-audio.mjs";
import { truePeak } from "../../src/audio/loudness.js";
import { sine, rng, rms, db, tone } from "./helpers.mjs";

const SR = 48000;
await loadWorkletModule(new URL("../../src/plugins/worklets/limiter.js", import.meta.url).href, SR);
const SPAN = 11;
const latency = (lookahead) => Math.round(lookahead * SR) + SPAN;
/** `lookahead` here is in seconds, as the plugin's control is in ms; the processor takes samples. */
const limit = (x, { lookahead = 0.003, ...params }, y = x) => runProcessor("daw-limiter", [x, y], { lookahead: Math.round(lookahead * SR), ...params }, { sampleRate: SR });

/** Loud, dense, peaky: drums, bass, a chord, hiss, all at once and too hot. */
function mix(seconds, seed = 1) {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const rand = rng(seed);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const beat = t % 0.5;
    const kick = Math.exp(-beat * 14) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 35)) * beat);
    const snare = (t + 0.25) % 0.5 < 0.12 ? Math.exp(-((t + 0.25) % 0.5) * 30) * (rand() * 2 - 1) : 0;
    const bass = 0.5 * Math.sign(Math.sin(2 * Math.PI * 55 * t)) * 0.6;
    let chord = 0;
    for (const hz of [220, 277.18, 329.63, 440]) chord += Math.sin(2 * Math.PI * hz * t + hz);
    const hat = (t * 8) % 1 < 0.05 ? (rand() * 2 - 1) * 0.5 : 0;
    const common = 0.9 * kick + 0.7 * snare + bass + 0.2 * chord;
    l[i] = common + hat;
    r[i] = common - hat * 0.7 + 0.1 * Math.sin(2 * Math.PI * 3000 * t);
  }
  return [l, r];
}

test("the ceiling holds: no sample and no 4x inter-sample peak above it, on loud material", () => {
  const cases = [];
  for (const seed of [1, 2]) cases.push([`mix ${seed}`, mix(6, seed)]);
  // Inter-sample torture: fs/4 at 45°, whose samples sit 3 dB under its crest.
  const isp = Float32Array.from({ length: SR * 2 }, (_, i) => 0.9 * Math.sin((2 * Math.PI * i) / 4 + Math.PI / 4));
  cases.push(["fs/4 at 45°", [isp, isp]]);
  const noise = (() => {
    const rand = rng(7);
    return Float32Array.from({ length: SR * 3 }, () => (rand() * 2 - 1) * 1.5);
  })();
  cases.push(["white noise", [noise, noise.map((v) => -v)]]);
  const clicks = new Float32Array(SR * 2);
  for (let i = 1000; i < clicks.length; i += 4801) clicks[i] = i % 2 ? 4 : -4;
  cases.push(["clicks", [clicks, clicks]]);

  let worst = -Infinity;
  for (const [name, [l, r]] of cases) {
    for (const [gain, ceiling, lookahead, release] of [[6, -1, 0.003, 0.1], [12, -0.3, 0.001, 0.02], [18, -3, 0.005, 0.3]]) {
      const out = limit(l, { gain, ceiling, lookahead, release }, r);
      const tp = db(truePeak(out));
      worst = Math.max(worst, tp - ceiling);
      assert.ok(tp <= ceiling, `${name}, +${gain} dB into ${ceiling} dBTP, ${lookahead * 1000} ms: true peak ${tp.toFixed(4)} dBTP`);
      assert.ok(out[0].every(Number.isFinite));
    }
  }
  console.log(`      highest true peak relative to the ceiling over ${cases.length * 3} runs: ${worst.toFixed(4)} dB`);
});

test("under the ceiling it is a pure delay: bit-exact, by look-ahead + 11 samples", () => {
  const [l, r] = mix(1).map((c) => c.map((v) => v * 0.05));
  const out = limit(l, { ceiling: -1, lookahead: 0.004 }, r);
  const d = latency(0.004);
  for (let i = 0; i < l.length - d; i++) assert.ok(out[0][i + d] === l[i] && out[1][i + d] === r[i], `sample ${i} altered`);
});

test("10 dB of reduction on a sine sweep: a steady level, with distortion under 1%", () => {
  const notes = [];
  for (const hz of [60, 100, 250, 1000, 4000, 10000]) {
    const x = sine(SR * 2, SR, hz, Math.pow(10, 9 / 20)); // +9 dBFS into a -1 dBTP ceiling
    const [y] = limit(x, { ceiling: -1, lookahead: 0.003, release: 0.1 });
    const from = SR; // settled
    const fund = tone(y, SR, hz, from, y.length);
    let harm = 0;
    for (let h = 2; h <= 9 && hz * h < SR / 2; h++) harm += tone(y, SR, hz * h, from, y.length) ** 2;
    const thd = Math.sqrt(harm) / fund;
    assert.ok(thd < 0.01, `${hz} Hz: THD ${(thd * 100).toFixed(2)}%`);
    assert.ok(db(fund) <= -1 + 0.02 && db(fund) > -2.5, `${hz} Hz: level ${db(fund).toFixed(2)} dBFS`);
    notes.push(`${hz} Hz ${(thd * 100).toFixed(3)}%`);
  }
  console.log(`      THD at 10 dB of limiting — ${notes.join(", ")}`);
});

test("release is program-dependent: a lone peak recovers fast, sustained limiting is held", () => {
  // One click in quiet material: the gain should be back within ~3 release times.
  const quiet = sine(SR * 2, SR, 1000, 0.1);
  const x = Float32Array.from(quiet);
  x[SR / 2] = 3;
  const [y] = limit(x, { ceiling: -1, release: 0.05 });
  const gainAt = (t) => rms(y, t * SR, (t + 0.02) * SR) / rms(quiet, t * SR, (t + 0.02) * SR);
  assert.ok(gainAt(0.75) > 0.97, `0.25 s after a lone peak the gain is ${gainAt(0.75).toFixed(3)}`);
  // A burst train: between bursts the gain should stay down rather than pump back up.
  const train = new Float32Array(SR * 3);
  for (let i = 0; i < train.length; i++) train[i] = (Math.floor(i / 4800) % 2 ? 0.1 : 2) * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const [z] = limit(train, { ceiling: -1, release: 0.05 });
  // In a quiet half late in the train, gain is still well below unity (held by the slow envelope).
  const s = Math.round(2.5 * SR / 9600) * 9600 + 4800 + 2400;
  const held = rms(z, s, s + 1200) / rms(train, s - latency(0.003), s - latency(0.003) + 1200);
  assert.ok(held < 0.75, `between sustained bursts the gain came back to ${held.toFixed(2)}`);
});
