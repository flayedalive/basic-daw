import test from "node:test";
import assert from "node:assert/strict";
import { trackPitch } from "../../src/audio/pitchtrack.js";
import { sing, addConsonant, SR } from "./voice.mjs";

/** Worst and mean error in cents over voiced frames in [from, to] seconds. */
function errors(track, truth, from, to) {
  let worst = 0;
  let sum = 0;
  let n = 0;
  let unvoiced = 0;
  for (let f = Math.ceil(from / track.hop); f <= Math.floor(to / track.hop); f++) {
    const want = truth(f * track.hop);
    if (Number.isNaN(want)) continue;
    if (Number.isNaN(track.midi[f])) {
      unvoiced++;
      continue;
    }
    const e = Math.abs(track.midi[f] - want) * 100;
    worst = Math.max(worst, e);
    sum += e;
    n++;
  }
  return { worst, mean: sum / Math.max(1, n), n, unvoiced };
}

test("a steady note: within 1 cent across the range", () => {
  for (const m of [40, 48, 57, 64, 72, 79]) {
    const { x, truth } = sing(1, () => m);
    const e = errors(trackPitch(x, SR), truth, 0.1, 0.9);
    assert.ok(e.unvoiced === 0 && e.worst < 1, `MIDI ${m}: worst ${e.worst.toFixed(2)} cents, ${e.unvoiced} frames unvoiced`);
  }
});

test("a glide of an octave per second: within 1 cent of the pitch at each instant", () => {
  const { x, truth } = sing(1.2, (t) => 55 + 12 * t);
  const e = errors(trackPitch(x, SR), truth, 0.1, 1.1);
  assert.ok(e.unvoiced === 0 && e.worst < 1, `worst ${e.worst.toFixed(2)} cents (mean ${e.mean.toFixed(2)})`);
});

test("vibrato, ±30 cents at 5.5 Hz: within 1 cent, so the vibrato itself is in the track", () => {
  const { x, truth } = sing(1.5, (t) => 60 + 0.3 * Math.sin(2 * Math.PI * 5.5 * t));
  const track = trackPitch(x, SR);
  const e = errors(track, truth, 0.1, 1.4);
  assert.ok(e.unvoiced === 0 && e.worst < 1, `worst ${e.worst.toFixed(2)} cents (mean ${e.mean.toFixed(2)})`);
  let lo = Infinity;
  let hi = -Infinity;
  for (let f = 40; f < 260; f++) (lo = Math.min(lo, track.midi[f])), (hi = Math.max(hi, track.midi[f]));
  assert.ok(Math.abs((hi - lo) * 50 - 30) < 1.5, `tracked vibrato depth ${((hi - lo) * 50).toFixed(1)} cents`);
});

test("silence, noise and consonants are unvoiced; notes around them are not", () => {
  const { x, truth } = sing(2, (t) => (t < 0.2 || (t > 0.9 && t < 1.1) || t > 1.8 ? NaN : t < 1 ? 57 : 62), { breath: 0.002 });
  addConsonant(x, 0.95);
  const track = trackPitch(x, SR);
  for (const t of [0.05, 0.1, 0.97, 1.0, 1.9, 1.95]) assert.ok(Number.isNaN(track.midi[Math.round(t / track.hop)]), `frame at ${t}s should be unvoiced`);
  const a = errors(track, truth, 0.3, 0.8);
  const b = errors(track, truth, 1.2, 1.7);
  assert.ok(a.unvoiced === 0 && b.unvoiced === 0 && a.worst < 2 && b.worst < 2, `notes: ${a.worst.toFixed(2)} / ${b.worst.toFixed(2)} cents`);
});

test("no octave errors on a bright low note whose second harmonic dominates", () => {
  const { x, truth } = sing(1, () => 41, { formants: [[175, 60], [900, 150]] });
  const e = errors(trackPitch(x, SR), truth, 0.1, 0.9);
  assert.ok(e.worst < 3 && e.unvoiced === 0, `worst ${e.worst.toFixed(1)} cents`);
});
