// Pitch track: the fundamental of a monophonic recording, every 5 ms.
//
// Two passes per frame, using the tuner's detector (plugins/pitch.js):
//
//   coarse  YIN on a 4x-decimated copy, over a window long enough for the
//           lowest note allowed. This decides *which* note it is — it is what
//           is robust against octave errors — and whether the frame is voiced.
//   fine    the squared-difference function again, at the full sample rate,
//           over a window only two periods long and centred on the frame, at
//           the few lags around the coarse answer. A short window is what lets
//           the track follow vibrato and glides instead of averaging them away.
//
// No DOM, no Web Audio. The pitch editor caches the result per asset.

import { detectPitch } from "../plugins/pitch.js";
import { resample } from "./resample.js";

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);
export const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Track the pitch of `mono`.
 * opts: { hop = 0.005 s, minHz = 65, maxHz = 1100, minClarity = 0.75, gateDb = -55 }
 * Returns {
 *   hop, hopSamples, frames,
 *   midi     Float32Array — fractional MIDI note per frame, NaN where unvoiced
 *   clarity  Float32Array — 0 … 1, how periodic the frame is
 *   level    Float32Array — RMS in dBFS
 * }
 * Frame i describes the signal at sample i * hopSamples.
 */
export function trackPitch(mono, sampleRate, opts = {}) {
  const gen = trackPitchGen(mono, sampleRate, opts);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/** The same as a generator that yields progress 0 → 1, for the UI to time-slice. */
export function* trackPitchGen(mono, sampleRate, opts = {}) {
  const hopSec = opts.hop ?? 0.005;
  const minHz = opts.minHz ?? 65;
  const maxHz = opts.maxHz ?? 1100;
  const minClarity = opts.minClarity ?? 0.75;
  const gateDb = opts.gateDb ?? -55;
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const frames = Math.floor(mono.length / hop) + 1;
  const midi = new Float32Array(frames).fill(NaN);
  const clarity = new Float32Array(frames);
  const level = new Float32Array(frames).fill(-120);

  // Coarse pass on a decimated copy (fundamentals live well below 1.5 kHz).
  const D = Math.max(1, Math.floor(sampleRate / 11000));
  const lowRate = sampleRate / D;
  const low = D === 1 ? mono : resample(mono, sampleRate, lowRate, { taps: 16 });
  const maxLag = Math.ceil(lowRate / minHz);
  const size = Math.ceil(maxLag * 2.5);
  const win = new Float32Array(size);
  for (let f = 0; f < frames; f++) {
    // Centre the window on the frame; zero-pad past the ends.
    const start = Math.round((f * hop) / D) - (size >> 1);
    for (let i = 0; i < size; i++) {
      const j = start + i;
      win[i] = j >= 0 && j < low.length ? low[j] : 0;
    }
    const r = detectPitch(win, lowRate, { minHz, maxHz, threshold: 0.15 });
    clarity[f] = r.clarity;
    level[f] = Number.isFinite(r.rmsDb) ? r.rmsDb : -120;
    if (r.hz > 0 && r.clarity >= minClarity && r.rmsDb >= gateDb && r.hz >= minHz && r.hz <= maxHz) midi[f] = hzToMidi(r.hz);
    if ((f & 255) === 0) yield (f / frames) * 0.8;
  }

  fixOctaves(midi);
  bridge(midi, Math.round(0.02 / hopSec)); // close gaps under 20 ms
  prune(midi, Math.round(0.03 / hopSec)); // drop voiced islands under 30 ms

  // Fine pass at the full rate, on a gently low-passed copy. A voice is close
  // to a pulse train, and the difference function of a pulse train has a
  // sharp V at its minimum that a parabola fits badly (errors of a couple of
  // cents); with the upper harmonics rolled off the minimum is smooth and the
  // interpolation is good to a fraction of a cent. The filter is symmetric,
  // so it shifts nothing in time.
  const smooth = lowpass(mono, Math.max(3, Math.round(sampleRate / 2500)));
  for (let f = 0; f < frames; f++) {
    if (Number.isNaN(midi[f])) continue;
    const hz = refineAt(smooth, sampleRate, f * hop, midiToHz(midi[f]));
    midi[f] = hzToMidi(hz);
    if ((f & 1023) === 0) yield 0.8 + (f / frames) * 0.2;
  }
  return { hop: hop / sampleRate, hopSamples: hop, frames, midi, clarity, level };
}

/** Two passes of a centred moving average of `len` samples: a zero-phase low-pass. */
export function lowpass(x, len) {
  const pass = (src) => {
    const out = new Float32Array(src.length);
    const half = len >> 1;
    let acc = 0;
    for (let i = -half; i < src.length; i++) {
      const add = i + half;
      const drop = i - half - 1;
      if (add < src.length) acc += src[add];
      if (drop >= 0) acc -= src[drop];
      if (i >= 0) out[i] = acc / (2 * half + 1);
    }
    return out;
  };
  return pass(pass(x));
}

/**
 * The period around sample `centre`, to a fraction of a sample, given a coarse
 * `hz`. The squared difference between the signal and itself one lag later is
 * summed over three periods, tapered; pairs (j, j + lag) are arranged so that their
 * midpoints straddle `centre` evenly, which is what makes the answer the pitch
 * *at* that instant on a glide rather than a little before it.
 */
export function refineAt(x, sampleRate, centre, hz) {
  const tau0 = Math.round(sampleRate / hz);
  const w = Math.max(64, tau0 * 3);
  const SPAN = 3;
  const d = new Float64Array(2 * SPAN + 1);
  // The sum is tapered (Hann). A voice is a train of pulses, and with a flat
  // window whichever pulses happen to fall inside decide the answer, so on a
  // glide the estimate jitters by a good part of a period's worth of pitch
  // change. Tapering keeps the weight centred on `centre` wherever they fall.
  const taper = hannTable(w);
  for (let k = -SPAN; k <= SPAN; k++) {
    const tau = tau0 + k;
    if (tau < 2) return hz;
    const start = Math.round(centre - (w + tau) / 2);
    if (start < 0 || start + w + tau >= x.length) return hz;
    let s = 0;
    for (let j = 0; j < w; j++) {
      const v = x[start + j] - x[start + j + tau];
      s += v * v * taper[j];
    }
    d[k + SPAN] = s;
  }
  let m = 1;
  for (let i = 1; i < d.length - 1; i++) if (d[i] < d[m]) m = i;
  const den = d[m - 1] - 2 * d[m] + d[m + 1];
  if (!(den > 0)) return hz;
  const tau = tau0 + (m - SPAN) + (0.5 * (d[m - 1] - d[m + 1])) / den;
  const out = sampleRate / tau;
  // Refinement nudges; it never relabels.
  return Math.abs(1200 * Math.log2(out / hz)) < 60 ? out : hz;
}

const tapers = new Map();
function hannTable(n) {
  if (!tapers.has(n)) {
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) t[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    tapers.set(n, t);
    if (tapers.size > 2000) tapers.delete(tapers.keys().next().value);
  }
  return tapers.get(n);
}

/** A frame an octave away from the median of its neighbourhood is an octave error: move it back. */
function fixOctaves(midi) {
  const R = 6;
  const out = Float32Array.from(midi);
  const near = [];
  for (let f = 0; f < midi.length; f++) {
    if (Number.isNaN(midi[f])) continue;
    near.length = 0;
    for (let k = Math.max(0, f - R); k <= Math.min(midi.length - 1, f + R); k++) if (!Number.isNaN(midi[k])) near.push(midi[k]);
    if (near.length < 5) continue;
    near.sort((a, b) => a - b);
    const med = near[near.length >> 1];
    const off = midi[f] - med;
    if (Math.abs(Math.abs(off) - 12) < 1) out[f] = midi[f] - Math.sign(off) * 12;
  }
  midi.set(out);
}

/** Fill unvoiced gaps of at most `max` frames by interpolating across them. */
function bridge(midi, max) {
  let last = -1;
  for (let f = 0; f < midi.length; f++) {
    if (Number.isNaN(midi[f])) continue;
    const gap = f - last - 1;
    if (last >= 0 && gap > 0 && gap <= max && Math.abs(midi[f] - midi[last]) < 2) {
      for (let k = 1; k <= gap; k++) midi[last + k] = midi[last] + ((midi[f] - midi[last]) * k) / (gap + 1);
    }
    last = f;
  }
}

/** Unvoice runs shorter than `min` frames: too short to be a note, usually a consonant's guess. */
function prune(midi, min) {
  let start = -1;
  for (let f = 0; f <= midi.length; f++) {
    const voiced = f < midi.length && !Number.isNaN(midi[f]);
    if (voiced && start < 0) start = f;
    if (!voiced && start >= 0) {
      if (f - start < min) for (let k = start; k < f; k++) midi[k] = NaN;
      start = -1;
    }
  }
}
