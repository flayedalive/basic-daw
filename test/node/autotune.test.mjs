// The real-time pitch corrector's processor, run block by block in Node.

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkletModule, runProcessor, installDomStubs } from "../../.claude/skills/daw-plugin/mock-audio.mjs";
import { trackPitch } from "../../src/audio/pitchtrack.js";
import { sing, addConsonant, formantGain, SR } from "./voice.mjs";
import { db, tone, diffDb, noise } from "./helpers.mjs";

installDomStubs();
const { scaleMask, AUTOTUNE_LATENCY, autoTunePlugin } = await import("../../src/plugins/autotune.js");
await loadWorkletModule(new URL("../../src/plugins/worklets/autotune.js", import.meta.url).href, SR);
const LAT = Math.round(AUTOTUNE_LATENCY * SR);

const run = (x, params = {}, opts = {}) => runProcessor("daw-autotune", [x, opts.right ?? x], params, { sampleRate: SR, ...opts });
/** Output with the latency taken off, so it lines up with the input. */
const aligned = (y) => y.subarray(LAT);
function pitchOf(x, from, to) {
  const t = trackPitch(x, SR);
  const v = [];
  for (let f = Math.ceil(from / t.hop); f <= Math.floor(to / t.hop); f++) if (!Number.isNaN(t.midi[f])) v.push(t.midi[f]);
  v.sort((a, b) => a - b);
  return { median: v[v.length >> 1], spread: v.at(-1) - v[0], count: v.length };
}
function envelopeFit(x, hz, scale, from, to) {
  const got = [];
  const want = [];
  for (let h = 1; h * hz < 3000; h++) {
    got.push(db(tone(x, SR, h * hz, from, to)));
    want.push(db(formantGain((h * hz) / scale) / h));
  }
  const offset = got.reduce((s, v, i) => s + v - want[i], 0) / got.length;
  return Math.sqrt(got.reduce((s, v, i) => s + (v - want[i] - offset) ** 2, 0) / got.length);
}
const hzOf = (m) => 440 * Math.pow(2, (m - 69) / 12);
const note = (midi, seconds = 1.2) => sing(seconds, (t) => (t < 0.1 || t > seconds - 0.1 ? NaN : midi)).x;

test("the face reports the processor's delay, in whole samples", () => {
  assert.equal(autoTunePlugin.latency({}, 48000), 1536 / 48000);
  assert.equal(autoTunePlugin.latency({}, 44100), 1411 / 44100);
  assert.equal(scaleMask("C", "chromatic"), 4095);
  assert.equal(scaleMask("C", "major"), 0b101010110101);
  assert.equal(scaleMask("A", "minor"), 0b101010110101, "A minor has the notes of C major");
});

test("amount 0: the output is the input, delayed by the latency", () => {
  const x = note(56.6);
  addConsonant(x, 0.02, 0.05);
  const y = run(x, { amount: 0 })[0];
  const d = diffDb(x.subarray(0, x.length - LAT), aligned(y));
  assert.ok(d < -110, `differs by ${d.toFixed(1)} dB`);
  for (let i = 0; i < LAT; i++) assert.equal(y[i], 0, "sound before the latency has passed");
});

test("noise and silence pass untouched whatever the settings", () => {
  const x = noise(SR, 0.2, 3);
  for (let i = 0; i < 4800; i++) x[i] = 0;
  const y = run(x, { speed: 0 })[0];
  const d = diffDb(x.subarray(0, x.length - LAT), aligned(y));
  assert.ok(d < -110, `noise changed: ${d.toFixed(1)} dB`);
});

test("a flat note is pulled onto the nearest note; formants stay where they were", () => {
  const x = note(56.6); // A♭3 + 60 cents: nearest is A3
  const y = aligned(run(x, { speed: 20 })[0]);
  const p = pitchOf(y, 0.4, 1.0);
  assert.ok(Math.abs(p.median - 57) * 100 < 4, `landed ${((p.median - 57) * 100).toFixed(1)} cents from A3`);
  assert.ok(p.spread * 100 < 8, `wobbles over ${(p.spread * 100).toFixed(1)} cents`);
  const kept = envelopeFit(y, hzOf(57), 1, Math.round(0.5 * SR), Math.round(0.9 * SR));
  assert.ok(kept < 3, `harmonics are ${kept.toFixed(1)} dB off the original envelope`);
  // Level is kept.
  const a = db(Math.hypot(...x.subarray(0.5 * SR, 0.9 * SR)));
  const b = db(Math.hypot(...y.subarray(0.5 * SR, 0.9 * SR)));
  assert.ok(Math.abs(a - b) < 1, `level moved ${(b - a).toFixed(2)} dB`);
});

test("key and scale decide the note", () => {
  const x = note(61.3); // C♯4 + 30: chromatic says C♯, C major says D? no — nearest in C major is D (62) vs C (60): D
  const chrom = pitchOf(aligned(run(x, { speed: 20 })[0]), 0.4, 1.0).median;
  const major = pitchOf(aligned(run(x, { speed: 20, scale: scaleMask("C", "major") })[0]), 0.4, 1.0).median;
  const bflat = pitchOf(aligned(run(x, { speed: 20, scale: scaleMask("B♭", "major") })[0]), 0.4, 1.0).median;
  assert.ok(Math.abs(chrom - 61) * 100 < 4, `chromatic: ${chrom.toFixed(3)}`);
  assert.ok(Math.abs(major - 62) * 100 < 5, `C major: ${major.toFixed(3)}`);
  assert.ok(Math.abs(bflat - 62) * 100 < 5, `B♭ major: ${bflat.toFixed(3)}`);
});

test("speed: 0 snaps and flattens vibrato; a slow speed keeps it and eases in", () => {
  const vib = sing(1.6, (t) => (t < 0.1 || t > 1.5 ? NaN : 56.7 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t))).x;
  const hard = pitchOf(aligned(run(vib, { speed: 0 })[0]), 0.4, 1.4);
  const soft = pitchOf(aligned(run(vib, { speed: 300 })[0]), 0.7, 1.4);
  assert.ok(hard.spread * 100 < 12, `speed 0 leaves ${(hard.spread * 100).toFixed(1)} cents of vibrato`);
  assert.ok(Math.abs(hard.median - 57) * 100 < 4);
  assert.ok(soft.spread * 100 > 35, `speed 300 flattened the vibrato to ${(soft.spread * 100).toFixed(1)} cents`);
  assert.ok(Math.abs(soft.median - 57) * 100 < 8, `speed 300 centre is ${((soft.median - 57) * 100).toFixed(1)} cents off`);
  // Easing in: 60 ms into the note a slow correction has barely begun.
  const flat = note(56.6);
  const early = pitchOf(aligned(run(flat, { speed: 400 })[0]), 0.13, 0.17).median;
  assert.ok(early < 56.8, `speed 400 had already reached ${early.toFixed(2)} after 50 ms`);
});

test("variance leaves near misses alone; amount scales the rest", () => {
  const x = note(57.2);
  const left = pitchOf(aligned(run(x, { variance: 30 })[0]), 0.4, 1.0).median;
  assert.ok(Math.abs(left - 57.2) * 100 < 3, `inside the variance but moved to ${left.toFixed(3)}`);
  const edge = pitchOf(aligned(run(x, { variance: 10 })[0]), 0.4, 1.0).median;
  assert.ok(Math.abs(edge - 57.1) * 100 < 4, `variance 10 should stop at the edge: ${edge.toFixed(3)}`);
  const half = pitchOf(aligned(run(x, { amount: 0.5 })[0]), 0.4, 1.0).median;
  assert.ok(Math.abs(half - 57.1) * 100 < 4, `amount 0.5: ${half.toFixed(3)}`);
});

test("a phrase: each note to its own target, consonant intact, stereo kept together", () => {
  const midiAt = (t) => {
    if (t < 0.2 || (t >= 1.6 && t < 1.75) || t >= 2.4) return NaN;
    if (t < 0.9) return 56.7;
    if (t < 0.98) return 56.7 + ((60.2 - 56.7) * (t - 0.9)) / 0.08;
    if (t < 1.6) return 60.2;
    return 62.35;
  };
  const x = sing(2.6, midiAt).x;
  addConsonant(x, 1.63, 0.09);
  const right = x.map((v) => v * 0.5);
  const [yl, yr] = run(x, { speed: 20 }, { right });
  const y = aligned(yl);
  const got = [pitchOf(y, 0.4, 0.85).median, pitchOf(y, 1.15, 1.55).median, pitchOf(y, 1.95, 2.35).median];
  [57, 60, 62].forEach((want, i) => assert.ok(Math.abs(got[i] - want) * 100 < 5, `note ${i + 1}: ${got[i].toFixed(3)}, wanted ${want}`));
  for (let i = 0; i < yl.length; i += 5) assert.ok(Math.abs(yl[i] * 0.5 - yr[i]) < 1e-6, "channels drifted apart");
  // The consonant comes through as it went in, once the note before it has died away.
  const a = Math.round(1.68 * SR);
  const b = Math.round(1.715 * SR);
  const d = diffDb(x.subarray(a, b), y.subarray(a, b));
  assert.ok(d < -30, `consonant changed: ${d.toFixed(1)} dB`);
  for (const v of yl) assert.ok(Number.isFinite(v) && Math.abs(v) < 2);
});

test("the same audio gives the same output wherever the blocks fall", () => {
  const x = note(56.6, 0.8);
  const pad = (k) => {
    const p = new Float32Array(x.length + 9000 + k);
    p.set(x, 9000 + k);
    return p;
  };
  const a = run(pad(0), { speed: 20 })[0].subarray(9000);
  const b = run(pad(77), { speed: 20 })[0].subarray(9000 + 77);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i], `sample ${i} differs`);
});

test("it reports what it hears and where it is sending it", () => {
  const seen = [];
  run(note(56.6), { speed: 20 }, { onMessage: (m) => m && seen.push(m) });
  assert.ok(seen.length > 10, "no meter messages");
  const last = seen.at(-3);
  assert.equal(last.note, 57);
  assert.ok(Math.abs(last.midi - 56.6) < 0.05 && Math.abs(last.cents - 40) < 4, JSON.stringify(last));
});

test("other sample rates: 44.1 and 96 kHz correct the same note and report their own delay", async () => {
  for (const sr of [44100, 96000]) {
    await loadWorkletModule(new URL("../../src/plugins/worklets/autotune.js", import.meta.url).href, sr);
    const hz = hzOf(56.6);
    const x = new Float32Array(sr);
    for (let i = Math.round(0.1 * sr); i < Math.round(0.9 * sr); i++) {
      for (let h = 1; h <= 8; h++) x[i] += (0.2 / h) * Math.sin((2 * Math.PI * hz * h * i) / sr);
    }
    const lat = Math.round(autoTunePlugin.latency({}, sr) * sr);
    const y = runProcessor("daw-autotune", [x, x], { speed: 20 }, { sampleRate: sr })[0].subarray(lat);
    const t = trackPitch(y, sr);
    const v = [];
    for (let f = Math.ceil(0.4 / t.hop); f <= Math.floor(0.8 / t.hop); f++) if (!Number.isNaN(t.midi[f])) v.push(t.midi[f]);
    v.sort((a, b) => a - b);
    assert.ok(Math.abs(v[v.length >> 1] - 57) * 100 < 4, `${sr} Hz: landed at ${v[v.length >> 1]?.toFixed(3)}`);
    const quiet = runProcessor("daw-autotune", [x, x], { amount: 0 }, { sampleRate: sr })[0];
    assert.ok(diffDb(x.subarray(0, x.length - lat), quiet.subarray(lat)) < -110, `${sr} Hz: the reported delay is not the real one`);
  }
  await loadWorkletModule(new URL("../../src/plugins/worklets/autotune.js", import.meta.url).href, SR);
});
