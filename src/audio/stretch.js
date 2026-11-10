// Time stretch and pitch shift, offline.
//
//   stretch(channels, sampleRate, { ratio, semitones, mode })
//
// `ratio` is output length over input length (2 = twice as long, half speed);
// `semitones` shifts pitch without changing length. Pitch shift is a stretch
// by the pitch ratio followed by resampling back to the wanted length.
//
// Three algorithms, because no single one suits everything:
//
//   mono   WSOLA. Copies whole grains of the waveform and overlaps them where
//          they line up best. Keeps a single voice or instrument intact —
//          speech, a vocal, bass, a solo line — but garbles chords.
//   poly   Phase vocoder with identity phase locking. Works per frequency, so
//          chords and full mixes survive; onsets are carried through at their
//          original speed with the phases reset, so attacks stay sharp.
//   drums  Cuts at the onsets and moves the slices. Every hit is the original
//          audio, untouched; only the gaps between hits change.
//   auto   Picks one of the above by listening to the material.
//
// No DOM and no Web Audio: plain Float32Arrays in and out, so it runs and is
// tested in Node. The work is written as generators that yield their progress,
// which lets the app spread a long stretch across animation frames
// (stretchAsync) while tests simply run it to the end (stretch).
//
// A ratio of exactly 1 is the identity in every mode — not as a special case,
// but because each algorithm reconstructs its input perfectly when nothing
// has to move. The tests null each one against its source.

import { fftOf, nextPow2 } from "./fft.js";
import { resampleTo } from "./resample.js";
import { detectPitch } from "../plugins/pitch.js";

export const STRETCH_MODES = ["auto", "mono", "poly", "drums"];
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 4;

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Periodic Hann: copies spaced n/2 (or n/4, squared) apart sum to a constant. */
function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function mixdown(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const m = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) m[i] += c[i];
  for (let i = 0; i < n; i++) m[i] /= channels.length;
  return m;
}

/**
 * A monotonic map from output sample to input sample, built from breakpoints
 * [[out, in], …]. Linear between them; `at` is meant to be called with
 * non-decreasing arguments and keeps a cursor so each call is O(1).
 */
function timeMap(points) {
  let i = 0;
  return (o) => {
    while (i < points.length - 2 && o >= points[i + 1][0]) i++;
    while (i > 0 && o < points[i][0]) i--;
    const [o0, i0] = points[i];
    const [o1, i1] = points[i + 1];
    return o1 === o0 ? i0 : i0 + ((o - o0) * (i1 - i0)) / (o1 - o0);
  };
}

/* ── onsets ───────────────────────────────────────────────────────────── */

/**
 * Sample positions where something starts: spectral flux (the summed rise in
 * log magnitude from one short frame to the next), peak-picked against a local
 * median, then walked back to where the energy actually begins to climb.
 */
export function detectOnsets(mono, sampleRate, { sensitivity = 1 } = {}) {
  const N = nextPow2(sampleRate * 0.02);
  const hop = N >> 2;
  const frames = Math.floor((mono.length - N) / hop) + 1;
  if (frames < 8) return [];
  const fft = fftOf(N);
  const win = hann(N);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const half = N >> 1;
  let prev = new Float32Array(half);
  let cur = new Float32Array(half);
  const flux = new Float32Array(frames);
  const level = new Float32Array(frames); // summed log magnitude: what the flux is a rise *of*
  for (let f = 0; f < frames; f++) {
    const s = f * hop;
    for (let i = 0; i < N; i++) {
      re[i] = mono[s + i] * win[i];
      im[i] = 0;
    }
    fft.forward(re, im);
    let sum = 0;
    let total = 0;
    for (let j = 1; j < half; j++) {
      const m = Math.log1p(200 * Math.hypot(re[j], im[j]));
      cur[j] = m;
      total += m;
      const d = m - prev[j];
      if (d > 0) sum += d;
    }
    flux[f] = f ? sum : 0;
    level[f] = total;
    [prev, cur] = [cur, prev];
  }
  let mean = 0;
  for (let f = 0; f < frames; f++) mean += flux[f];
  mean /= frames;

  const W = Math.max(4, Math.round((0.12 * sampleRate) / hop)); // median window, each side
  const gap = Math.round((0.06 * sampleRate) / hop); // closest two onsets may be
  const onsets = [];
  const scratch = [];
  let last = -gap;
  for (let f = 2; f < frames - 2; f++) {
    const v = flux[f];
    if (v <= flux[f - 1] || v < flux[f + 1] || v <= flux[f - 2] || v < flux[f + 2]) continue;
    scratch.length = 0;
    for (let k = Math.max(0, f - W); k <= Math.min(frames - 1, f + W); k++) scratch.push(flux[k]);
    scratch.sort((a, b) => a - b);
    const median = scratch[scratch.length >> 1];
    if (v < (median * 1.6 + mean * 0.6) / sensitivity) continue;
    // …and the rise has to be a real share of what is sounding. A held note
    // or a slow vibrato shuffles energy between bins all the time; an attack
    // adds a tenth or more of the whole spectrum at once.
    if (v < (level[f] * 0.12) / sensitivity) continue;
    if (f - last < gap) continue;
    const at = refineOnset(mono, sampleRate, f * hop + N - hop);
    // Last, the level itself has to step up. Partials beating against each
    // other in a held chord churn the spectrum without anything having begun.
    const after = meanSquare(mono, at, at + Math.round(sampleRate * 0.02));
    const before = meanSquare(mono, at - Math.round(sampleRate * 0.032), at - Math.round(sampleRate * 0.002));
    if (after < before * 1.8 * (1 / sensitivity) + 1e-9) continue;
    last = f;
    onsets.push(at);
  }
  // Refinement can pull two detections onto the same attack.
  const minGap = Math.round(0.03 * sampleRate);
  return onsets.filter((p, i) => p > minGap && (i === 0 || p - onsets[i - 1] > minGap));
}

function meanSquare(x, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(x.length, to);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return s / (b - a);
}

/** From a rough position, find where the level first climbs towards the peak that follows. */
function refineOnset(x, sampleRate, rough) {
  const block = Math.max(8, Math.round(sampleRate * 0.001));
  const from = Math.max(0, rough - Math.round(sampleRate * 0.04));
  const to = Math.min(x.length, rough + Math.round(sampleRate * 0.02));
  const count = Math.floor((to - from) / block);
  if (count < 3) return rough;
  const e = new Float32Array(count);
  let max = 0;
  let maxAt = 0;
  for (let b = 0; b < count; b++) {
    let s = 0;
    for (let i = 0; i < block; i++) s += x[from + b * block + i] ** 2;
    e[b] = s;
    if (s > max) (max = s), (maxAt = b);
  }
  // Walk back from the peak while the level is still a good part of it.
  let b = maxAt;
  while (b > 0 && e[b - 1] > max * 0.08) b--;
  return from + b * block;
}

/* ── WSOLA ────────────────────────────────────────────────────────────── */

/**
 * Waveform-similarity overlap-add. Grains of 30 ms are laid down every 15 ms;
 * each is taken from where the time map says, nudged by up to ±12 ms to
 * wherever it best continues the grain before it. While the natural
 * continuation is itself within reach it is used as is, which is why ratio 1
 * reproduces the input exactly.
 */
function* wsola(channels, mono, sampleRate, map, outLen) {
  const Hs = Math.max(16, Math.round(sampleRate * 0.015));
  const N = 2 * Hs;
  const tol = Math.max(8, Math.round(sampleRate * 0.012));
  const D = Math.max(1, Math.floor(sampleRate / 12000)); // the search runs on every Dth sample
  const win = hann(N);
  const n = mono.length;
  const out = channels.map(() => new Float32Array(outLen + N + Hs));
  const frames = Math.ceil(outLen / Hs) + 1;
  let prev = 0;
  for (let k = 0; k < frames; k++) {
    const nominal = Math.round(map(k * Hs));
    let centre = nominal;
    if (k > 0) {
      const natural = prev + Hs;
      centre = Math.abs(natural - nominal) <= tol ? natural : nominal + bestOffset(mono, n, natural - Hs, nominal - Hs, Hs, tol, D);
    }
    const src = centre - Hs;
    const dst = k * Hs; // `out` is offset by Hs, so frame k (centred on k·Hs) starts here
    const i0 = Math.max(0, -src);
    const i1 = Math.min(N, n - src);
    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      const y = out[c];
      for (let i = i0; i < i1; i++) y[dst + i] += x[src + i] * win[i];
    }
    prev = centre;
    if ((k & 127) === 0) yield k / frames;
  }
  return out.map((y) => y.slice(Hs, Hs + outLen));
}

/**
 * The shift d in [-tol, tol] for which x[cand + d …] best matches x[ref …]
 * over `len` samples: normalised cross-correlation, searched coarsely on a
 * decimated grid and then refined at full resolution.
 */
function bestOffset(x, n, ref, cand, len, tol, D) {
  const score = (d, step) => {
    const c = cand + d;
    const i0 = Math.max(0, -ref, -c);
    const i1 = Math.min(len, n - ref, n - c);
    let xy = 0;
    let yy = 0;
    for (let i = i0; i < i1; i += step) {
      const b = x[c + i];
      xy += x[ref + i] * b;
      yy += b * b;
    }
    return yy > 1e-12 ? xy / Math.sqrt(yy) : 0;
  };
  let best = 0;
  let bestScore = score(0, D);
  for (let d = -tol; d <= tol; d += D) {
    const s = score(d, D);
    if (s > bestScore) (bestScore = s), (best = d);
  }
  if (D > 1) {
    const centre = best;
    bestScore = -Infinity;
    for (let d = Math.max(-tol, centre - D); d <= Math.min(tol, centre + D); d++) {
      const s = score(d, 1);
      if (s > bestScore) (bestScore = s), (best = d);
    }
  }
  return best;
}

/* ── phase vocoder ────────────────────────────────────────────────────── */

/**
 * Phase vocoder with identity phase locking (Laroche & Dolson).
 *
 * Each output frame takes its magnitudes from the input at the mapped
 * position. Its phases continue from the previous output frame, advanced by
 * what the input's phase does over one synthesis hop — measured directly from
 * a second analysis frame one hop earlier, so there is no phase unwrapping and
 * no assumption that the analysis hop is constant. Bins are rotated together
 * in the neighbourhood of each spectral peak, which keeps a partial's shape
 * intact and removes most of the "phasiness" of a plain vocoder.
 *
 * At each position in `resets` (input samples) the output phases are set to
 * the input's: the frame is then an exact copy, which is how attacks are kept.
 */
function* phaseVocoder(channels, sampleRate, map, outLen, resets = []) {
  const N = nextPow2(sampleRate * 0.07);
  const Hs = N >> 2;
  const half = N >> 1;
  const fft = fftOf(N);
  const win = hann(N);
  const C = channels.length;
  const n = channels[0].length;
  const out = channels.map(() => new Float32Array(outLen + 3 * N));
  const buf = () => channels.map(() => ({ re: new Float64Array(N), im: new Float64Array(N) }));
  let A = buf(); // analysis at the mapped position
  let B = buf(); // analysis one synthesis hop earlier
  const Y = buf(); // the previous output spectrum
  const mag2 = new Float64Array(half + 1);
  const peaks = new Int32Array(half + 1);
  const norm = 1 / 1.5; // Hann² at 75% overlap sums to 1.5
  const sre = new Float64Array(N);
  const sim = new Float64Array(N);

  const analyse = (into, centre) => {
    const s = centre - half;
    const i0 = Math.max(0, -s);
    const i1 = Math.min(N, n - s);
    for (let c = 0; c < C; c++) {
      const { re, im } = into[c];
      const x = channels[c];
      re.fill(0);
      im.fill(0);
      for (let i = i0; i < i1; i++) re[i] = x[s + i] * win[i];
      fft.forward(re, im);
    }
  };

  // Frame k is centred on output sample k·Hs. At 75% overlap the first samples
  // are also covered by the frame centred one hop before the start.
  const frames = Math.ceil(outLen / Hs) + 2;
  let prevCentre = null;
  let r = 0;
  for (let k = -1; k < frames; k++) {
    const centre = k < 0 ? Math.round(map(0)) - Hs : Math.round(map(k * Hs));
    let reset = k === -1;
    while (r < resets.length && resets[r] <= centre) {
      reset = true;
      r++;
    }
    // The earlier frame is the previous analysis whenever the map is moving at
    // the output's own pace — always, at ratio 1.
    if (prevCentre !== null && prevCentre === centre - Hs) [A, B] = [B, A];
    else if (!reset) analyse(B, centre - Hs);
    analyse(A, centre);

    if (!reset) {
      for (let j = 0; j <= half; j++) {
        let m = 0;
        for (let c = 0; c < C; c++) m += A[c].re[j] ** 2 + A[c].im[j] ** 2;
        mag2[j] = m;
      }
      let count = 0;
      for (let j = 2; j < half - 1; j++) {
        const m = mag2[j];
        if (m > mag2[j - 1] && m > mag2[j - 2] && m >= mag2[j + 1] && m >= mag2[j + 2]) peaks[count++] = j;
      }
      for (let c = 0; c < C; c++) {
        const a = A[c];
        const b = B[c];
        const y = Y[c];
        if (!count) {
          y.re.set(a.re);
          y.im.set(a.im);
          continue;
        }
        let lo = 0;
        for (let p = 0; p < count; p++) {
          const pk = peaks[p];
          const hi = p === count - 1 ? half : (pk + peaks[p + 1]) >> 1;
          // rotation = (previous output phase) − (input phase one hop earlier), at the peak
          const yr = y.re[pk];
          const yi = y.im[pk];
          const br = b.re[pk];
          const bi = b.im[pk];
          const scale = Math.hypot(yr, yi) * Math.hypot(br, bi);
          let rr = 1;
          let ri = 0;
          if (scale > 1e-18) {
            rr = (yr * br + yi * bi) / scale;
            ri = (yi * br - yr * bi) / scale;
          }
          for (let j = lo; j <= hi; j++) {
            const ar = a.re[j];
            const ai = a.im[j];
            y.re[j] = ar * rr - ai * ri;
            y.im[j] = ar * ri + ai * rr;
          }
          lo = hi + 1;
        }
      }
    } else {
      for (let c = 0; c < C; c++) {
        Y[c].re.set(A[c].re);
        Y[c].im.set(A[c].im);
      }
    }

    // Back to time. Only the lower half of Y is ever read, so the mirror image
    // an inverse transform needs is filled into a scratch copy.
    for (let c = 0; c < C; c++) {
      const y = Y[c];
      for (let j = 0; j <= half; j++) {
        sre[j] = y.re[j];
        sim[j] = y.im[j];
      }
      for (let j = 1; j < half; j++) {
        sre[N - j] = y.re[j];
        sim[N - j] = -y.im[j];
      }
      fft.inverse(sre, sim);
      const o = out[c];
      const dst = (k + 1) * Hs; // `out` is offset by N/2 + Hs
      for (let i = 0; i < N; i++) o[dst + i] += sre[i] * win[i] * norm;
    }
    prevCentre = centre;
    if ((k & 15) === 0) yield k / frames;
  }
  return out.map((y) => y.slice(half + Hs, half + Hs + outLen));
}

/* ── drums ────────────────────────────────────────────────────────────── */

/**
 * Slice at the onsets and move the slices. Each slice starts where its onset
 * lands on the new timeline and plays at its original speed, so every attack
 * is the untouched source. When slowing down, the gap that opens before the
 * next hit is filled by stretching the slice's decay (WSOLA); when speeding
 * up, the decay is cut short where the next hit arrives.
 */
function* drums(channels, sampleRate, ratio, outLen, onsets) {
  const n = channels[0].length;
  const xf = Math.max(4, Math.round(sampleRate * 0.003));
  // Cut a little ahead of each onset, so the whole attack — including the
  // first quiet millisecond a detector cannot see — belongs to the new slice
  // and none of it is left in the tail of the one before, to be stretched.
  // The onset itself still lands exactly where the ratio puts it.
  const margin = Math.round(sampleRate * 0.003);
  const hits = onsets.filter((p) => p > margin + xf && p < n - xf);
  const bounds = [0, ...hits.map((p) => p - margin), n];
  const places = [0, ...hits.map((p) => Math.round(p * ratio) - margin), outLen];
  const out = channels.map(() => new Float32Array(outLen));
  const attackLen = Math.round(sampleRate * 0.05);

  for (let s = 0; s < bounds.length - 1; s++) {
    const a = bounds[s];
    const b = bounds[s + 1];
    const len = b - a;
    const o0 = Math.max(0, places[s]);
    const o1 = Math.min(outLen, places[s + 1]);
    const span = o1 - o0;
    if (span <= 0) continue;
    const lead = s === 0 ? 0 : xf; // samples before the onset, faded in under the previous slice's fade-out
    const last = s === bounds.length - 2;

    // How much of the slice is copied as is, and how long the stretched decay is.
    let direct = Math.min(len, span);
    let tail = null;
    if (span > len && len > attackLen * 2) {
      direct = attackLen;
      const src = channels.map((c) => c.subarray(a + direct, b));
      const want = span - direct;
      const gen = wsola(src, mixdown(src), sampleRate, (o) => (o * (len - direct)) / want, want);
      let step = gen.next();
      while (!step.done) step = gen.next();
      tail = step.value;
    }

    for (let c = 0; c < channels.length; c++) {
      const x = channels[c];
      const y = out[c];
      for (let i = -lead; i < direct; i++) {
        const o = o0 + i;
        if (o < 0 || o >= outLen) continue;
        y[o] += x[a + i] * (i < 0 ? (i + lead) / lead : 1);
      }
      if (tail) {
        const t = tail[c];
        for (let i = 0; i < t.length; i++) {
          const o = o0 + direct + i;
          if (o < outLen) y[o] += t[i];
        }
      }
      // Fade out under the next slice's lead-in. (At ratio 1 the two are the
      // same samples with complementary gains, so they sum back to the source.)
      if (!last) {
        for (let i = 0; i < xf; i++) {
          const o = o1 - xf + i;
          if (o >= o0 && o < outLen) y[o] *= 1 - i / xf;
        }
      }
    }
    yield s / bounds.length;
  }
  return out;
}

/* ── choosing a mode ──────────────────────────────────────────────────── */

/**
 * Pick an algorithm for `mono`: "mono" when most of it has one clear pitch,
 * "drums" when it is mostly attacks with nothing pitched between them, and
 * "poly" otherwise.
 */
export function chooseMode(mono, sampleRate) {
  const size = nextPow2(sampleRate * 0.04);
  const windows = Math.min(48, Math.floor(mono.length / size));
  if (windows < 2) return "mono";
  let voiced = 0;
  let sounding = 0;
  for (let w = 0; w < windows; w++) {
    const start = Math.floor(((mono.length - size) * w) / (windows - 1));
    const r = detectPitch(mono.subarray(start, start + size), sampleRate, { minHz: 60, maxHz: 1200 });
    if (r.rmsDb < -50) continue;
    sounding++;
    if (r.hz > 0 && r.clarity > 0.85) voiced++;
  }
  if (!sounding) return "mono";
  const pitched = voiced / sounding;
  if (pitched > 0.6) return "mono";
  const onsets = detectOnsets(mono, sampleRate);
  const perSecond = onsets.length / (mono.length / sampleRate);
  if (perSecond >= 1.5 && pitched < 0.25) return "drums";
  return "poly";
}

/* ── the public face ──────────────────────────────────────────────────── */

/**
 * A time map for the phase vocoder that runs at the input's own speed across
 * each onset and makes up the difference everywhere else.
 * Returns { map, resets }.
 */
function transientMap(n, outLen, onsets, sampleRate) {
  const guard = Math.round(sampleRate * 0.02); // each side of an onset
  const regions = [];
  for (const p of onsets) {
    const a = Math.max(0, p - guard);
    const b = Math.min(n, p + guard);
    if (regions.length && a <= regions.at(-1)[1]) regions.at(-1)[1] = b;
    else regions.push([a, b]);
  }
  let fixed = regions.reduce((s, [a, b]) => s + (b - a), 0);
  // Unstretched regions only make sense while there is room left to stretch
  // (or squeeze) around them without the rest going to extremes.
  const rest = n - fixed;
  const restOut = outLen - fixed;
  if (!regions.length || rest <= 0 || restOut <= 0 || restOut / rest > 6 || restOut / rest < 1 / 6) {
    return { map: timeMap([[0, 0], [outLen, n]]), resets: onsets };
  }
  const slope = restOut / rest;
  const points = [[0, 0]];
  let i = 0;
  let o = 0;
  for (const [a, b] of regions) {
    o += (a - i) * slope;
    points.push([o, a]);
    o += b - a;
    points.push([o, b]);
    i = b;
  }
  points.push([o + (n - i) * slope, n]);
  return { map: timeMap(points), resets: regions.map(([a]) => a) };
}

/**
 * The work, as a generator: yields progress 0 → 1 and returns the stretched
 * channels. opts: { ratio = 1, semitones = 0, mode = "auto" }.
 */
export function* stretchGen(channels, sampleRate, opts = {}) {
  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, opts.ratio ?? 1));
  const pitch = Math.pow(2, (opts.semitones ?? 0) / 12);
  const n = channels[0].length;
  const outLen = Math.max(1, Math.round(n * ratio));
  // Stretch to the wanted length times the pitch ratio, then read that back
  // `pitch` times as fast: the length comes out right and the pitch has moved.
  const stageLen = Math.max(1, Math.round(n * ratio * pitch));
  let staged = channels;

  if (stageLen !== n) {
    const mono = mixdown(channels);
    const mode = STRETCH_MODES.includes(opts.mode) && opts.mode !== "auto" ? opts.mode : chooseMode(mono, sampleRate);
    const total = stageLen / n;
    if (mode === "mono") {
      staged = yield* wsola(channels, mono, sampleRate, (o) => o / total, stageLen);
    } else if (mode === "drums") {
      staged = yield* drums(channels, sampleRate, total, stageLen, detectOnsets(mono, sampleRate));
    } else {
      const { map, resets } = transientMap(n, stageLen, detectOnsets(mono, sampleRate), sampleRate);
      staged = yield* phaseVocoder(channels, sampleRate, map, stageLen, resets);
    }
  }
  if (stageLen === outLen) return staged === channels ? channels.map((c) => Float32Array.from(c)) : staged;
  return staged.map((c) => resampleTo(c, outLen, stageLen / outLen));
}

/** Run a stretch to completion. For Node and for short clips. */
export function stretch(channels, sampleRate, opts) {
  const gen = stretchGen(channels, sampleRate, opts);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * The same, yielding to the caller's event loop every `budgetMs` so a long
 * stretch does not freeze the page. `pause` resolves when work may resume;
 * `onProgress` hears 0 → 1; `isCancelled` may end it early (resolves null).
 */
export async function stretchAsync(channels, sampleRate, opts, { budgetMs = 14, pause, onProgress, isCancelled } = {}) {
  const gen = stretchGen(channels, sampleRate, opts);
  const wait = pause ?? (() => new Promise((r) => setTimeout(r, 0)));
  let t0 = Date.now();
  let step = gen.next();
  while (!step.done) {
    if (Date.now() - t0 >= budgetMs) {
      onProgress?.(step.value);
      await wait();
      if (isCancelled?.()) return null;
      t0 = Date.now();
    }
    step = gen.next();
  }
  onProgress?.(1);
  return step.value;
}

/** The individual algorithms, for tests and for the pitch editor (Phase 5). */
export const internals = { wsola, phaseVocoder, drums, mixdown, timeMap, transientMap, bestOffset };
