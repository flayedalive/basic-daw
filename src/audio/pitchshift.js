// Pitch shifting for a single voice: TD-PSOLA.
//
// Voiced sound is a train of pulses — one per cycle of the vocal folds — each
// ringing through the mouth's resonances (the formants). PSOLA cuts the signal
// into grains two periods wide, one centred on each pulse, and lays them back
// down closer together (higher pitch) or further apart (lower). The pulses'
// spacing changes; each grain, and so each formant, is untouched. That is why
// a vocal moved a couple of semitones this way still sounds like the same
// mouth, where resampling would shrink or stretch it.
//
//   pitchMarks   finds the pulses: one mark per period through voiced
//                stretches (from the pitch track, snapped to the waveform's
//                peaks), every 5 ms through the rest
//   psola        lays grains down along a time map with a pitch-ratio curve
//   shiftPitch   pitch only, same length — what the pitch editor renders with
//   vocalStretch time and pitch together, formants kept — stretch.js's
//                "vocal" mode; unvoiced stretches (breaths, consonants) go
//                through WSOLA instead, because repeating grains of noise
//                turns it into a buzz
//
// Where the ratio is 1 the output is the input exactly: the synthesis marks
// fall on the analysis marks, and each grain's window is cut so that
// neighbouring windows sum to one. Unvoiced sound is never shifted.
//
// No DOM, no Web Audio.

import { internals as stretchParts, detectOnsets } from "./stretch.js";
import { lowpass, trackPitch } from "./pitchtrack.js";
import { resampleTo } from "./resample.js";

/**
 * Pitch marks for `mono` given its pitch track.
 * Returns { marks: Float64Array (ascending, first 0, last n - 1; voiced marks
 * are placed to a fraction of a sample), voiced: Uint8Array }.
 */
export function pitchMarks(mono, sampleRate, track) {
  const n = mono.length;
  const hop = track.hopSamples;
  const periodAt = (sample) => {
    const f = Math.min(track.frames - 1, Math.max(0, sample / hop));
    const i = Math.floor(f);
    const a = track.midi[i];
    const b = track.midi[Math.min(track.frames - 1, i + 1)];
    const m = Number.isNaN(a) ? b : Number.isNaN(b) ? a : a + (b - a) * (f - i);
    return Number.isNaN(m) ? NaN : sampleRate / (440 * Math.pow(2, (m - 69) / 12));
  };

  const marks = [];
  const voiced = [];
  const step = Math.max(8, Math.round(sampleRate * 0.005)); // spacing through unvoiced sound
  const fill = (from, to) => {
    // Unvoiced marks strictly between two positions, evenly spread.
    const count = Math.max(0, Math.round((to - from) / step) - 1);
    for (let k = 1; k <= count; k++) {
      marks.push(Math.round(from + ((to - from) * k) / (count + 1)));
      voiced.push(0);
    }
  };

  let last = 0;
  marks.push(0);
  voiced.push(0);
  let f = 0;
  while (f < track.frames) {
    if (Number.isNaN(track.midi[f])) {
      f++;
      continue;
    }
    let end = f;
    while (end + 1 < track.frames && !Number.isNaN(track.midi[end + 1])) end++;
    const a = f * hop;
    const b = Math.min(n - 1, end * hop);
    const region = voicedMarks(mono, sampleRate, a, b, periodAt, track, f, end);
    if (region.length >= 2) {
      // Keep clear of the previous mark, then join up with unvoiced filler.
      const first = region.findIndex((m) => m - last >= step / 2);
      if (first >= 0) {
        fill(last, region[first]);
        for (let k = first; k < region.length; k++) {
          marks.push(region[k]);
          voiced.push(1);
        }
        last = region.at(-1);
      }
    }
    f = end + 1;
  }
  if (n - 1 - last >= step / 2) {
    fill(last, n - 1);
    marks.push(n - 1);
    voiced.push(0);
  } else {
    marks[marks.length - 1] = n - 1;
  }
  return { marks: Float64Array.from(marks), voiced: Uint8Array.from(voiced) };
}

/**
 * One mark per period across the voiced stretch [a, b], grown outwards from
 * its loudest point.
 *
 * Marks are put on the peaks of the note's *fundamental*. On the raw waveform
 * a strong formant gives several peaks per period of nearly the same height,
 * and a picker hopping between them is the classic source of PSOLA's
 * roughness; the fundamental has one peak per period, exactly a period apart.
 */
function voicedMarks(mono, sampleRate, a, b, periodAt, track, f0, f1) {
  // Seed where the note is strongest: the pulses are clearest there.
  let seedFrame = f0;
  for (let f = f0; f <= f1; f++) if (track.level[f] > track.level[seedFrame]) seedFrame = f;
  const c = Math.min(b, Math.max(a, seedFrame * track.hopSamples));
  const p0 = periodAt(c);
  if (!(p0 > 0)) return [];
  // Isolate the fundamental. Four passes of a moving average half a period
  // long put a quadruple null on the second harmonic (and every even one) and
  // leave the third 38 dB down, so what remains has exactly one peak per
  // period. The filter is zero-phase: those peaks do not move. A stretch whose
  // pitch travels a long way is filtered in pieces, each with its own length —
  // a filter cut for one end of an octave glide would null the other end's
  // fundamental.
  const pieces = [];
  for (let f = f0; f <= f1; ) {
    let lo = Infinity;
    let hi = 0;
    let g = f;
    const ps = [];
    for (; g <= f1; g++) {
      const p = periodAt(g * track.hopSamples);
      if (!(p > 0)) continue;
      if (Math.max(hi, p) > Math.min(lo, p) * 1.25) break;
      lo = Math.min(lo, p);
      hi = Math.max(hi, p);
      ps.push(p);
    }
    ps.sort((x, y) => x - y);
    const median = ps[ps.length >> 1] || p0;
    const pad = Math.round(median * 3);
    const from = Math.max(0, f * track.hopSamples - pad);
    const to = Math.min(mono.length, (g - 1) * track.hopSamples + track.hopSamples + pad);
    const len = Math.max(3, Math.round(median / 2));
    pieces.push({ from, to, end: g > f1 ? Infinity : g * track.hopSamples, data: lowpass(lowpass(mono.subarray(from, to), len), len) });
    f = Math.max(g, f + 1);
  }
  let cur = 0;
  const lp = {
    at(i) {
      while (cur < pieces.length - 1 && i >= pieces[cur].end) cur++;
      while (cur > 0 && i < pieces[cur - 1].end) cur--;
      const p = pieces[cur];
      return p.data[i - p.from] ?? 0;
    },
  };
  // Which way up are the pulses? Take the polarity with the taller peaks.
  let hi = 0;
  let lo = 0;
  for (let i = Math.max(a, Math.round(c - p0)); i <= Math.min(b, Math.round(c + p0)); i++) {
    const v = lp.at(i);
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  const sign = hi >= -lo ? 1 : -1;
  const peakNear = (centre, reach) => {
    let best = Math.round(centre);
    let bestV = -Infinity;
    const from = Math.round(centre - reach);
    const to = Math.round(centre + reach);
    if (from < a || to > b) return NaN; // the note ends inside the search window: stop here
    for (let i = from; i <= to; i++) {
      // Prefer the peak nearest the prediction when several are about as tall.
      const v = sign * lp.at(i) * (1 - 0.25 * Math.abs(i - centre) / (reach + 1));
      if (v > bestV) (bestV = v), (best = i);
    }
    // The bias above chooses *which* peak; now climb to its actual top…
    while (best < to && sign * lp.at(best + 1) > sign * lp.at(best)) best++;
    while (best > from && sign * lp.at(best - 1) > sign * lp.at(best)) best--;
    // …and place it to a fraction of a sample (parabola through the peak and its neighbours):
    // half a sample of jitter in where grains are cut is audible as roughness.
    const y0 = sign * lp.at(best - 1);
    const y1 = sign * lp.at(best);
    const y2 = sign * lp.at(best + 1);
    const den = y0 - 2 * y1 + y2;
    return den < 0 ? best + Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : best;
  };

  const seed = peakNear(c, p0 / 2);
  if (Number.isNaN(seed)) return [];
  const out = [seed];
  for (let m = seed; ; ) {
    const p = periodAt(m);
    if (!(p > 0)) break;
    const next = peakNear(m + p, p * 0.2);
    if (!(next > m + 1)) break;
    out.push(next);
    m = next;
  }
  for (let m = seed; ; ) {
    const p = periodAt(m);
    if (!(p > 0)) break;
    const prev = peakNear(m - p, p * 0.2);
    if (!(prev < m - 1)) break;
    out.unshift(prev);
    m = prev;
  }
  if (out.length < 3) return out;

  // The fundamental's peaks are a period apart, but they are not where each
  // cycle's energy is: that is at the glottal pulse, some constant fraction of
  // a period away. Grains should be centred there — a pulse under the middle
  // of its window is carried whole, one split between two windows is smeared
  // when the grains are moved. Find the fraction that puts the marks on the
  // most energy, and shift every mark by it.
  const STEPS = 24;
  const energy = new Float64Array(STEPS);
  for (let k = 1; k < out.length - 1; k++) {
    const gap = out[k + 1] - out[k];
    const w = Math.max(1, Math.round(gap / STEPS));
    for (let q = 0; q < STEPS; q++) {
      // Phase runs from -1/2 to +1/2 of a period around the mark.
      const pos = Math.round(out[k] + (q / STEPS - 0.5) * gap);
      let e = 0;
      for (let i = pos - w; i <= pos + w; i++) e += (mono[i] ?? 0) ** 2;
      energy[q] += e;
    }
  }
  let bestQ = 0;
  for (let q = 1; q < STEPS; q++) if (energy[q] > energy[bestQ]) bestQ = q;
  const phase = bestQ / STEPS - 0.5;
  const shifted = out.map((m, k) => m + phase * (k < out.length - 1 ? out[k + 1] - m : m - out[k - 1]));
  return shifted.filter((m) => m >= a && m <= b);
}

/**
 * Lay grains down. `map(o)` gives the input position for output sample o
 * (non-decreasing; identity for a pure pitch shift) and `ratioAt(i)` the pitch
 * ratio wanted at input sample i. A generator: yields progress, returns the
 * output channels.
 */
export function* psola(channels, { marks, voiced }, { map = (o) => o, unmap = (i) => i, ratioAt = () => 1, outLen = channels[0].length } = {}) {
  const n = channels[0].length;
  const out = channels.map(() => new Float32Array(outLen));
  const weight = new Float32Array(outLen);
  const M = marks.length;
  let j = 0;
  let s = 0;
  let guard = 0;
  while (s < outLen && guard++ < outLen) {
    const t = Math.min(n - 1, Math.max(0, map(s)));
    while (j < M - 2 && marks[j + 1] <= t) j++;
    while (j > 0 && marks[j] > t) j--;
    const period = marks[j + 1] - marks[j];
    const g = t - marks[j] < period / 2 ? j : j + 1;
    const centre = marks[g];
    const left = g > 0 ? centre - marks[g - 1] : 0;
    const right = g < M - 1 ? marks[g + 1] - centre : 0;
    // Unvoiced grains go back exactly where they came from (through the time
    // map), whatever the voiced ones before them did: breaths and consonants
    // are then the source's own samples, not a re-timed copy of them.
    if (!voiced[g]) s = Math.max(s - period, unmap(centre));
    // The grain is centred on output position s, which like the marks is not
    // a whole sample. Output sample o is d = o - s from the centre and so reads
    // the source at centre + d — interpolated (4-point) when that falls between
    // samples. Where nothing has moved, s is the grain's own centre, centre + d
    // is a whole sample again, and the source is copied exactly.
    // Each half of the window is a raised cosine as long as the gap to the
    // neighbouring mark, so adjacent grains' halves sum to exactly one.
    const oFrom = Math.max(0, left ? Math.floor(s - left) + 1 : Math.ceil(s));
    const oTo = Math.min(outLen - 1, right ? Math.ceil(s + right) - 1 : Math.floor(s));
    for (let o = oFrom; o <= oTo; o++) {
      const d = o - s;
      const w = d < 0 ? 0.5 * (1 + Math.cos((Math.PI * d) / left)) : right ? 0.5 * (1 + Math.cos((Math.PI * d) / right)) : 1;
      if (w <= 0) continue;
      weight[o] += w;
      const q = centre + d;
      const k = Math.round(q);
      const u = q - k;
      if (Math.abs(u) < 1e-7) {
        if (k >= 0 && k < n) for (let c = 0; c < channels.length; c++) out[c][o] += channels[c][k] * w;
      } else {
        // Cubic (Catmull-Rom) through the four samples around q.
        const k0 = Math.floor(q);
        const v = q - k0;
        const c0 = -0.5 * v + v * v - 0.5 * v * v * v;
        const c1 = 1 - 2.5 * v * v + 1.5 * v * v * v;
        const c2 = 0.5 * v + 2 * v * v - 1.5 * v * v * v;
        const c3 = -0.5 * v * v + 0.5 * v * v * v;
        for (let c = 0; c < channels.length; c++) {
          const x = channels[c];
          out[c][o] += (c0 * (x[k0 - 1] ?? 0) + c1 * (x[k0] ?? 0) + c2 * (x[k0 + 1] ?? 0) + c3 * (x[k0 + 2] ?? 0)) * w;
        }
      }
    }
    const ratio = voiced[g] ? Math.min(4, Math.max(0.25, ratioAt(t))) : 1;
    // Step on by one period, compressed or spread by the pitch ratio. (A time
    // map changes which grain is used next, never how far apart they are laid.)
    s += Math.max(1, period) / ratio;
    if ((guard & 1023) === 0) yield Math.min(1, s / outLen);
  }
  // Grains laid closer together (or further apart) than they were cut overlap
  // more (or less): divide the pile-up back out.
  for (let o = 0; o < outLen; o++) {
    const w = weight[o];
    if (w > 1e-3 && Math.abs(w - 1) > 1e-6) {
      const k = 1 / Math.max(w, 0.35);
      for (let c = 0; c < channels.length; c++) out[c][o] *= k;
    }
  }
  return out;
}

const run = (gen) => {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
};

/** A per-frame ratio array (one value per pitch-track frame) as a function of input sample. */
export function ratioCurve(ratios, hopSamples) {
  const last = ratios.length - 1;
  return (sample) => {
    const f = Math.min(last, Math.max(0, sample / hopSamples));
    const i = Math.floor(f);
    return ratios[i] + (ratios[Math.min(last, i + 1)] - ratios[i]) * (f - i);
  };
}

/**
 * Shift pitch, keep length. `ratios` is one pitch ratio per track frame
 * (2^(cents / 1200)); unvoiced frames are ignored. A generator.
 */
export function* shiftPitchGen(channels, sampleRate, track, ratios) {
  const mono = stretchParts.mixdown(channels);
  const marked = pitchMarks(mono, sampleRate, track);
  return yield* psola(channels, marked, { ratioAt: ratioCurve(ratios, track.hopSamples) });
}

export const shiftPitch = (channels, sampleRate, track, ratios) => run(shiftPitchGen(channels, sampleRate, track, ratios));

/**
 * Time-stretch and pitch-shift a single voice, keeping its formants: the
 * "vocal" stretch mode. Voiced sound goes through PSOLA; breaths and
 * consonants through WSOLA, cross-faded at the joins. A generator.
 */
export function* vocalStretchGen(channels, sampleRate, { ratio = 1, semitones = 0 } = {}) {
  const n = channels[0].length;
  const outLen = Math.max(1, Math.round(n * ratio));
  const mono = stretchParts.mixdown(channels);
  const track = trackPitch(mono, sampleRate);
  yield 0.3;
  const marked = pitchMarks(mono, sampleRate, track);
  const pitch = Math.pow(2, semitones / 12);
  const voicedOut = yield* psola(channels, marked, { map: (o) => o / ratio, unmap: (i) => i * ratio, ratioAt: () => pitch, outLen });
  if (Math.abs(ratio - 1) < 1e-9) return voicedOut;

  // Unvoiced stretches again, with WSOLA, and swap them in.
  const noisy = run(stretchParts.wsola(channels, mono, sampleRate, (o) => o / ratio, outLen));
  const xf = Math.round(sampleRate * 0.006);
  const mix = new Float32Array(outLen); // 0 = PSOLA, 1 = WSOLA
  const hop = track.hopSamples;
  for (let f = 0; f < track.frames; f++) {
    if (!Number.isNaN(track.midi[f])) continue;
    const a = Math.round(f * hop * ratio);
    const b = Math.min(outLen, Math.round((f + 1) * hop * ratio));
    for (let o = Math.max(0, a); o < b; o++) mix[o] = 1;
  }
  // Soften the switch-over (a short moving average of the 0/1 mask).
  const soft = lowpass(mix, xf);
  for (let c = 0; c < channels.length; c++) {
    const v = voicedOut[c];
    const u = noisy[c];
    for (let o = 0; o < outLen; o++) v[o] += (u[o] - v[o]) * soft[o];
  }
  return voicedOut;
}

export const vocalStretch = (channels, sampleRate, opts) => run(vocalStretchGen(channels, sampleRate, opts));

// (resampleTo and detectOnsets are re-exported for the real-time corrector's tests.)
export { resampleTo, detectOnsets };
