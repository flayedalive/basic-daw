// Monophonic pitch detection for the tuner, kept free of the DOM and Web Audio
// so it can be tested in Node against synthetic signals.
//
// The detector is YIN (de Cheveigné & Kawahara, 2002): a squared-difference
// function normalised by its own running mean, which keeps the octave errors
// plain autocorrelation makes on bright, harmonic-rich notes (a guitar's low E
// often has more energy in its second harmonic than its fundamental) rare.
//
// The tuner feeds it a decimated, low-passed signal — fundamentals of anything
// you'd tune sit well below 1.5 kHz — which cuts the cost by the decimation
// factor squared and makes it cheap enough to run on the UI thread every frame.

export const NOTE_NAMES = {
  sharps: ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"],
  flats: ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"],
};

/**
 * Estimate the fundamental of `x` (sampled at `sampleRate`).
 * Returns { hz, clarity, rmsDb } — `hz` is 0 when nothing periodic was found.
 * `clarity` runs 0 → 1 (1 = perfectly periodic); `rmsDb` is the window level.
 *
 * opts: { minHz = 27, maxHz = 1500, threshold = 0.15 }
 */
export function detectPitch(x, sampleRate, opts = {}) {
  const minHz = opts.minHz ?? 27;
  const maxHz = opts.maxHz ?? 1500;
  const threshold = opts.threshold ?? 0.15;
  const n = x.length;

  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (x[i] - mean) * (x[i] - mean);
  const rms = Math.sqrt(sq / (n || 1));
  const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -Infinity;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(Math.ceil(sampleRate / minHz), Math.floor(n / 2));
  const w = n - maxLag; // integration window: everything the largest lag leaves
  if (maxLag <= minLag + 2 || w < maxLag / 2) return { hz: 0, clarity: 0, rmsDb };

  // Squared difference, then the cumulative mean normalisation.
  const d = new Float32Array(maxLag + 2);
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = x[j] - x[j + tau];
      s += v * v;
    }
    d[tau] = s;
  }
  const cmnd = new Float32Array(maxLag + 2);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxLag + 1; tau++) {
    running += d[tau];
    cmnd[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // First dip under the threshold, walked down to its local minimum. Taking the
  // *first* qualifying dip rather than the deepest is what avoids reporting a
  // note an octave (or a fifth) below the one played.
  let tau = -1;
  for (let t = minLag; t <= maxLag; t++) {
    if (cmnd[t] < threshold) {
      while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) {
    // Nothing under the threshold: fall back to the global minimum and let
    // the caller judge it by clarity.
    let best = minLag;
    for (let t = minLag + 1; t <= maxLag; t++) if (cmnd[t] < cmnd[best]) best = t;
    tau = best;
  }

  // Parabolic interpolation on the raw difference function, which is closer
  // to quadratic around its minimum than the normalised one.
  let refined = tau;
  if (tau > 1 && tau < maxLag + 1) {
    const a = d[tau - 1];
    const b = d[tau];
    const c = d[tau + 1];
    const den = a - 2 * b + c;
    if (den > 0) refined = tau + (0.5 * (a - c)) / den;
  }

  const clarity = Math.max(0, Math.min(1, 1 - cmnd[tau]));
  return { hz: sampleRate / refined, clarity, rmsDb };
}

/**
 * Sharpen a coarse estimate against a full-rate buffer. On the decimated
 * signal a high note spans only a few dozen samples per period, so parabolic
 * interpolation there is good to a cent or two; here it only has to evaluate
 * the difference function at five lags around the known period.
 */
export function refinePitch(x, sampleRate, hz) {
  if (!(hz > 0)) return hz;
  const center = Math.round(sampleRate / hz);
  const lo = center - 2;
  const hi = center + 2;
  const w = x.length - hi - 1;
  if (lo < 2 || w < center) return hz;
  const d = [];
  for (let tau = lo; tau <= hi; tau++) {
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = x[j] - x[j + tau];
      s += v * v;
    }
    d.push(s);
  }
  let k = 1;
  for (let i = 1; i < d.length - 1; i++) if (d[i] < d[k]) k = i;
  const den = d[k - 1] - 2 * d[k] + d[k + 1];
  if (!(den > 0)) return hz;
  const tau = lo + k + (0.5 * (d[k - 1] - d[k + 1])) / den;
  // Refinement may only nudge, never relabel: reject anything over 30 cents away.
  const out = sampleRate / tau;
  return Math.abs(1200 * Math.log2(out / hz)) < 30 ? out : hz;
}

/**
 * Name the note nearest `hz` against an A4 reference.
 * Returns { midi, name, octave, cents, targetHz } — `cents` is how far `hz`
 * sits from the named note, -50 … +50.
 */
export function noteFromHz(hz, a4 = 440, names = "sharps") {
  const exact = 69 + 12 * Math.log2(hz / a4);
  const midi = Math.round(exact);
  const table = NOTE_NAMES[names] ?? NOTE_NAMES.sharps;
  return {
    midi,
    name: table[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: (exact - midi) * 100,
    targetHz: a4 * Math.pow(2, (midi - 69) / 12),
  };
}

/**
 * Turns a stream of raw detections into something steady enough to tune to:
 * a short median rejects the odd octave slip at a pluck's attack, smoothing
 * calms the needle, and the last good reading is held briefly after the note
 * dies away so you can read it.
 */
export class PitchTracker {
  constructor({ holdSec = 1.5, minClarity = 0.8 } = {}) {
    this.holdSec = holdSec;
    this.minClarity = minClarity;
    this.recent = []; // fractional midi numbers, newest last
    this.smoothed = null;
    this.since = Infinity; // seconds since the last good detection
    this.level = -Infinity;
  }

  /** Feed one detection; `dt` is seconds since the previous call. */
  push({ hz, clarity, rmsDb }, dt, gateDb) {
    this.level = rmsDb;
    const good = hz > 0 && rmsDb >= gateDb && clarity >= this.minClarity;
    if (!good) {
      this.since += dt;
      if (this.since > 0.25) this.recent.length = 0;
      return;
    }
    this.since = 0;
    const m = 69 + 12 * Math.log2(hz / 440);
    this.recent.push(m);
    if (this.recent.length > 5) this.recent.shift();
    const med = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1];
    // A new note snaps; the same note eases, faster when the error is large so
    // turning a peg still feels immediate.
    if (this.smoothed == null || Math.abs(med - this.smoothed) > 0.6) this.smoothed = med;
    else {
      const k = Math.min(1, 0.25 + Math.abs(med - this.smoothed) * 2);
      this.smoothed += (med - this.smoothed) * k;
    }
  }

  /** The current reading in Hz, or 0. `held` is true once the note has stopped. */
  reading() {
    if (this.smoothed == null || this.since > this.holdSec) return { hz: 0, held: false, level: this.level };
    return { hz: 440 * Math.pow(2, (this.smoothed - 69) / 12), held: this.since > 0.12, level: this.level };
  }

  reset() {
    this.recent.length = 0;
    this.smoothed = null;
    this.since = Infinity;
  }
}
