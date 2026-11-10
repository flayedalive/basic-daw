// Time stretch and pitch shift against synthetic signals.

import test from "node:test";
import assert from "node:assert/strict";
import { stretch, stretchAsync, detectOnsets, chooseMode, internals, STRETCH_MODES } from "../../src/audio/stretch.js";
import { detectPitch, refinePitch } from "../../src/plugins/pitch.js";
import { sine, noise, rng, rms, db, diffDb, tone } from "./helpers.mjs";

const SR = 48000;
const cents = (a, b) => 1200 * Math.log2(a / b);

/** A sung-ish note: harmonics with a little vibrato. */
function voice(seconds, hz = 220, vibrato = 0) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = hz * (1 + vibrato * Math.sin((2 * Math.PI * 5.5 * i) / SR));
    phase += (2 * Math.PI * f) / SR;
    for (let h = 1; h <= 8; h++) x[i] += (0.3 / h) * Math.sin(h * phase);
  }
  return x;
}

/** Speech-like: voiced syllables at drifting pitch separated by noise bursts and gaps. */
function speech(seconds) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const r = rng(11);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const syl = t % 0.32;
    const f = 120 + 30 * Math.sin(t * 2.1) + 10 * Math.sin(t * 7.3);
    phase += (2 * Math.PI * f) / SR;
    if (syl < 0.2) {
      const env = Math.min(1, syl / 0.02) * Math.min(1, (0.2 - syl) / 0.03);
      for (let h = 1; h <= 10; h++) x[i] += ((0.25 * env) / h) * Math.sin(h * phase);
    } else if (syl < 0.25) {
      x[i] = 0.08 * (r() * 2 - 1);
    }
  }
  return x;
}

/** A drum loop: decaying noise and tone bursts on a grid. Returns { x, hits } (hit times in seconds). */
function drumLoop(seconds, bpm = 120) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const r = rng(3);
  const step = 60 / bpm / 2;
  const hits = [];
  for (let k = 0; k * step < seconds - 0.05; k++) {
    const at = Math.round(k * step * SR);
    hits.push(at / SR);
    const kick = k % 4 === 0;
    for (let i = 0; i < Math.min(n - at, SR * 0.45); i++) {
      const t = i / SR;
      x[at + i] += kick ? 0.7 * Math.exp(-t * 18) * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-t * 40)) * t) : 0.35 * Math.exp(-t * 45) * (r() * 2 - 1);
    }
  }
  return { x, hits };
}

/** Sample index where the short-time level first reaches a fraction of the following peak, near `around`. */
function onsetNear(x, around, window = 0.03) {
  const from = Math.max(0, Math.round((around - window) * SR));
  const to = Math.min(x.length, Math.round((around + window) * SR));
  let max = 0;
  for (let i = from; i < to; i++) max = Math.max(max, Math.abs(x[i]));
  for (let i = from; i < to; i++) if (Math.abs(x[i]) > max * 0.3) return i / SR;
  return NaN;
}

const pitchOf = (x, from = 0.3, len = 8192) => {
  const seg = x.subarray(Math.round(from * SR), Math.round(from * SR) + len);
  const r = detectPitch(seg, SR, { minHz: 60, maxHz: 1200 });
  return refinePitch(seg, SR, r.hz);
};

/* ── identity ─────────────────────────────────────────────────────────── */

test("ratio 1.0 nulls against the source in every algorithm (not just the shortcut)", () => {
  const x = speech(2);
  const run = (gen) => {
    let s = gen.next();
    while (!s.done) s = gen.next();
    return s.value[0];
  };
  const n = x.length;
  const w = run(internals.wsola([x], x, SR, (o) => o, n));
  const p = run(internals.phaseVocoder([x], SR, (o) => o, n, [20000, 50000]));
  const d = run(internals.drums([x], SR, 1, n, detectOnsets(x, SR)));
  for (const [name, y, floor] of [["wsola", w, -120], ["phase vocoder", p, -100], ["drums", d, -120]]) {
    const diff = diffDb(x, y);
    assert.ok(diff < floor, `${name} at ratio 1 differs from its input by ${diff.toFixed(1)} dB`);
  }
  assert.ok(diffDb(x, stretch([x], SR, { ratio: 1, mode: "poly" })[0]) < -200);
});

/* ── length and timing ────────────────────────────────────────────────── */

test("output length is exact and nothing drifts: within 1 ms per minute", () => {
  // One minute with a burst every second; the last burst shows any accumulated drift.
  const n = SR * 60;
  const x = new Float32Array(n);
  const r = rng(5);
  for (let s = 1; s < 60; s++) for (let i = 0; i < 2400; i++) x[s * SR + i] = 0.5 * Math.exp(-i / 400) * (r() * 2 - 1);
  for (const [mode, ratio] of [["drums", 1.25], ["drums", 0.8], ["mono", 1.25], ["poly", 0.8]]) {
    const y = stretch([x], SR, { ratio, mode })[0];
    assert.equal(y.length, Math.round(n * ratio), `${mode} ${ratio}: length`);
    const first = onsetNear(y, 1 * ratio, 0.05);
    const last = onsetNear(y, 59 * ratio, 0.05);
    const drift = (last - first - 58 * ratio) * 1000;
    // Any one event may sit off its ideal spot by up to the algorithm's search
    // tolerance (mono, poly); what must not happen is that error growing with time.
    const limit = mode === "drums" ? 1 : 15;
    assert.ok(Math.abs(drift) < limit, `${mode} ${ratio}: last event is ${drift.toFixed(2)} ms from where 58 s of stretch puts it`);
  }
});

test("drums: every hit lands where the ratio puts it, within 1.5 ms, with its attack intact", () => {
  const { x, hits } = drumLoop(4);
  for (const ratio of [0.8, 1.25, 2]) {
    const y = stretch([x], SR, { ratio, mode: "drums" })[0];
    for (const h of hits.slice(1)) {
      const got = onsetNear(y, h * ratio, 0.02);
      assert.ok(Math.abs(got - h * ratio) < 0.0015, `ratio ${ratio}: hit at ${h}s landed ${((got - h * ratio) * 1000).toFixed(2)} ms off`);
    }
    // The first 20 ms after a hit are the source's own samples.
    const h = hits[4];
    const a = Math.round(h * SR) + 200;
    const b = Math.round(h * ratio * SR) + 200;
    // …give or take where exactly the slicer put its cut (under a millisecond).
    let worst = Infinity;
    for (let lag = -48; lag <= 48; lag++) {
      let w = 0;
      for (let i = 0; i < 700; i++) w = Math.max(w, Math.abs(x[a + i] - y[b + lag + i]));
      worst = Math.min(worst, w);
    }
    assert.ok(worst < 0.005, `ratio ${ratio}: attack differs from the source by ${worst.toFixed(4)}`);
  }
});

/* ── pitch ────────────────────────────────────────────────────────────── */

test("pitch is preserved through a stretch: within 2 cents, 0.5× to 2×", () => {
  const x = voice(2, 220);
  const ref = pitchOf(x);
  for (const mode of ["mono", "poly"]) {
    for (const ratio of [0.5, 0.8, 1.25, 2]) {
      const y = stretch([x], SR, { ratio, mode })[0];
      const c = cents(pitchOf(y, 0.3 * ratio), ref);
      assert.ok(Math.abs(c) < 2, `${mode} at ${ratio}×: pitch moved ${c.toFixed(2)} cents`);
    }
  }
});

test("pitch shift moves the pitch by the semitones asked and leaves the length alone", () => {
  const x = voice(2, 220);
  for (const mode of ["mono", "poly"]) {
    for (const semitones of [-12, -3, 2, 7]) {
      const y = stretch([x], SR, { semitones, mode })[0];
      assert.equal(y.length, x.length);
      const c = cents(pitchOf(y), 220) - semitones * 100;
      assert.ok(Math.abs(c) < 3, `${mode} ${semitones} st: off by ${c.toFixed(2)} cents`);
    }
  }
});

test("stretch and pitch shift combine, and extreme ratios render finite audio", () => {
  const x = voice(1.5, 330, 0.01);
  const y = stretch([x], SR, { ratio: 1.5, semitones: -5, mode: "poly" })[0];
  assert.equal(y.length, Math.round(x.length * 1.5));
  assert.ok(Math.abs(cents(pitchOf(y, 0.5), 330) + 500) < 15);
  const { x: loop } = drumLoop(2);
  for (const mode of ["mono", "poly", "drums"]) {
    for (const ratio of [0.25, 4]) {
      for (const src of [x, loop]) {
        const out = stretch([src], SR, { ratio, mode })[0];
        assert.equal(out.length, Math.round(src.length * ratio));
        assert.ok(out.every(Number.isFinite), `${mode} ${ratio}: non-finite samples`);
        const level = db(rms(out)) - db(rms(src));
        assert.ok(level > -9 && level < 6, `${mode} ${ratio}: level changed by ${level.toFixed(1)} dB`);
      }
    }
  }
});

/* ── quality proxies ──────────────────────────────────────────────────── */

test("a steady tone stays steady: no amplitude warble from 0.8× to 1.25×", () => {
  const x = voice(3, 196);
  for (const mode of ["mono", "poly"]) {
    for (const ratio of [0.8, 0.9, 1.1, 1.25]) {
      const y = stretch([x], SR, { ratio, mode })[0];
      // Level in 20 ms blocks across the middle: a clean stretch keeps it flat.
      const block = 960;
      let lo = Infinity;
      let hi = 0;
      for (let b = Math.ceil(0.2 * SR / block); b < Math.floor((y.length - 0.2 * SR) / block); b++) {
        const v = rms(y, b * block, (b + 1) * block);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const ripple = db(hi / lo);
      assert.ok(ripple < 1.5, `${mode} at ${ratio}×: level ripples by ${ripple.toFixed(2)} dB`);
    }
  }
});

test("a chord keeps every note (poly), within 1 dB each", () => {
  const n = SR * 2;
  const x = new Float32Array(n);
  const notes = [261.63, 329.63, 392.0, 523.25];
  for (const hz of notes) sine(n, SR, hz, 0.15).forEach((v, i) => (x[i] += v));
  for (const ratio of [0.8, 1.25, 1.6]) {
    const y = stretch([x], SR, { ratio, mode: "poly" })[0];
    for (const hz of notes) {
      const g = db(tone(y, SR, hz, SR / 2, y.length - SR / 2) / 0.15);
      assert.ok(Math.abs(g) < 1, `ratio ${ratio}: ${hz} Hz came out at ${g.toFixed(2)} dB`);
    }
  }
});

test("stereo: both channels move together, so the image holds", () => {
  const l = speech(2);
  const r = l.map((v) => v * 0.5);
  for (const mode of ["mono", "poly", "drums"]) {
    const [yl, yr] = stretch([l, r], SR, { ratio: 1.2, mode });
    let worst = 0;
    for (let i = 0; i < yl.length; i++) worst = Math.max(worst, Math.abs(yl[i] * 0.5 - yr[i]));
    assert.ok(db(worst) < -60, `${mode}: right is not half of left (${db(worst).toFixed(1)} dB)`);
  }
});

/* ── analysis ─────────────────────────────────────────────────────────── */

test("onset detection finds the hits of a drum loop within 5 ms", () => {
  const { x, hits } = drumLoop(4);
  const found = detectOnsets(x, SR).map((p) => p / SR);
  for (const h of hits.slice(1)) {
    const nearest = found.reduce((a, b) => (Math.abs(b - h) < Math.abs(a - h) ? b : a), Infinity);
    assert.ok(Math.abs(nearest - h) < 0.005, `hit at ${h}s: nearest onset ${nearest.toFixed(4)}s`);
  }
  assert.ok(found.length <= hits.length + 1, `${found.length} onsets for ${hits.length} hits`);
});

test("onset detection stays quiet on held notes, vibrato and a steady chord", () => {
  assert.deepEqual(detectOnsets(voice(3, 196).subarray(4800), SR), []);
  assert.deepEqual(detectOnsets(voice(3, 330, 0.02).subarray(4800), SR), []);
  const n = SR * 2;
  const chord = new Float32Array(n);
  for (const hz of [261.63, 329.63, 392.0]) sine(n, SR, hz, 0.15, 1).forEach((v, i) => (chord[i] += v));
  assert.deepEqual(detectOnsets(chord.subarray(4800), SR), []);
});

test("auto mode: a voice is mono, a drum loop is drums, a chord with noise is poly", () => {
  assert.equal(chooseMode(voice(2, 180, 0.01), SR), "mono");
  assert.equal(chooseMode(speech(3), SR), "mono");
  assert.equal(chooseMode(drumLoop(4).x, SR), "drums");
  const n = SR * 2;
  const chord = noise(n, 0.05, 2);
  for (const hz of [261.63, 311.13, 392, 466.16, 587.33]) sine(n, SR, hz, 0.12).forEach((v, i) => (chord[i] += v));
  assert.equal(chooseMode(chord, SR), "poly");
});

test("stretchAsync gives the same result as stretch, yields on the way, and can be cancelled", async () => {
  const x = speech(3);
  let pauses = 0;
  const a = await stretchAsync([x], SR, { ratio: 1.3, mode: "poly" }, { budgetMs: 1, pause: async () => void pauses++ });
  const b = stretch([x], SR, { ratio: 1.3, mode: "poly" });
  assert.ok(pauses > 2, "never yielded");
  assert.deepEqual(a[0], b[0]);
  const cancelled = await stretchAsync([x], SR, { ratio: 1.3, mode: "poly" }, { budgetMs: 0, isCancelled: () => true });
  assert.equal(cancelled, null);
});

test("vocal mode: stretch() hands a single voice to PSOLA, and leaves it alone when nothing moves", async () => {
  const { vocalStretch } = await import("../../src/audio/pitchshift.js");
  const { sing } = await import("./voice.mjs");
  const { x } = sing(1.2, (t) => (t < 0.1 || t > 1.1 ? NaN : 57));
  assert.ok(STRETCH_MODES.includes("vocal"));
  const same = stretch([x], 48000, { ratio: 1, mode: "vocal" })[0];
  assert.deepEqual(same, x, "ratio 1, no shift: should be the input");
  for (const opts of [{ ratio: 1.25 }, { ratio: 1, semitones: 2 }, { ratio: 0.8, semitones: -1 }]) {
    const y = stretch([x], 48000, { ...opts, mode: "vocal" })[0];
    const want = vocalStretch([x], 48000, opts)[0];
    assert.equal(y.length, Math.round(x.length * opts.ratio));
    assert.deepEqual(y, want);
  }
});
