// Synthetic singing for the pitch tests: a harmonic source shaped by formants,
// following any pitch curve, with unvoiced consonants between notes.

import { rng } from "./helpers.mjs";

export const SR = 48000;

/**
 * Sing `midiAt(t)` (a function of seconds returning a MIDI note, or NaN for
 * silence) for `seconds`. Returns { x, truth } where truth(t) is the exact
 * pitch at time t. opts: { formants = [[700, 110], [1200, 120], [2600, 160]],
 * breath = 0, level = 0.3 }.
 */
export function sing(seconds, midiAt, opts = {}) {
  const formants = opts.formants ?? [[700, 110], [1200, 120], [2600, 160]];
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  const rand = rng(opts.seed ?? 21);
  // A band-limited pulse train: harmonics with a -12 dB/octave tilt, each
  // weighted by the formant envelope at its frequency.
  const gainAt = (hz) => formantGain(hz, formants);
  let phase = 0;
  let env = 0;
  let hz = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const m = midiAt(t);
    const on = !Number.isNaN(m);
    // A few milliseconds in, a few more out: the note rings on at its last
    // pitch while it fades, as a voice does, rather than being cut off.
    env += ((on ? 1 : 0) - env) * (on ? 0.002 : 0.001);
    if (on) hz = 440 * Math.pow(2, (m - 69) / 12);
    if (hz && env > 1e-4) {
      phase += (2 * Math.PI * hz) / SR;
      let v = 0;
      for (let h = 1; h * hz < 9000; h++) v += (gainAt(h * hz) / h) * Math.sin(h * phase);
      x[i] = (opts.level ?? 0.3) * env * v;
    }
    if (opts.breath) x[i] += opts.breath * (rand() * 2 - 1);
  }
  return { x, truth: midiAt };
}

/** The formant envelope sing() shapes its harmonics with. */
export function formantGain(hz, formants = [[700, 110], [1200, 120], [2600, 160]]) {
  let g = 0.08;
  for (const [f, bw] of formants) g += 1 / (1 + ((hz - f) / bw) ** 2);
  return g;
}

/** A consonant: a short burst of high-passed noise at `at` seconds. */
export function addConsonant(x, at, seconds = 0.06, level = 0.12, seed = 5) {
  const rand = rng(seed);
  let prev = 0;
  const a = Math.round(at * SR);
  const len = Math.round(seconds * SR);
  for (let i = 0; i < len && a + i < x.length; i++) {
    const w = rand() * 2 - 1;
    const hp = w - prev; // crude high-pass
    prev = w;
    x[a + i] += level * hp * Math.sin((Math.PI * i) / len);
  }
}

/** Spectral envelope centroid between lo and hi Hz: where the formant energy sits. */
export function envelopePeak(x, lo, hi, from = 0, to = x.length) {
  let best = 0;
  let bestHz = lo;
  for (let hz = lo; hz <= hi; hz += 20) {
    // Energy in a 150 Hz-wide band (several Goertzel bins), so harmonics do not decide it.
    let e = 0;
    for (let k = -3; k <= 3; k++) {
      const f = hz + k * 25;
      const c = 2 * Math.cos((2 * Math.PI * f) / SR);
      let s1 = 0;
      let s2 = 0;
      for (let i = from; i < to; i++) {
        const s0 = x[i] + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      e += s1 * s1 + s2 * s2 - c * s1 * s2;
    }
    if (e > best) (best = e), (bestHz = hz);
  }
  return bestHz;
}
