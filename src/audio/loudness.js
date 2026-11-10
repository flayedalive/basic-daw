// Programme loudness and true peak, per ITU-R BS.1770-4 and EBU R 128.
//
//   integrated   LUFS, K-weighted, gated (absolute -70 LUFS, relative -10 LU)
//   momentary    400 ms window        short-term   3 s window
//   range (LRA)  EBU Tech 3342: 10th–95th percentile of gated short-term values
//   true peak    dBTP, from a 4x oversampled reconstruction
//
// No DOM and no Web Audio: it takes plain Float32Arrays, so the bounce dialog,
// the "master to a target" loop and the Node tests all run the same code.
// Stereo and mono only (every channel weighted 1.0) — the app has no surround.

const ABS_GATE = -70; // LUFS
const HOP = 0.1; // seconds: 400 ms blocks overlap by 75%
const lufs = (meanSquare) => (meanSquare > 0 ? -0.691 + 10 * Math.log10(meanSquare) : -Infinity);
const power = (l) => Math.pow(10, (l + 0.691) / 10);

/** The two K-weighting biquads for `sampleRate`: [{ b0, b1, b2, a1, a2 }, …]. */
export function kWeighting(sampleRate) {
  // Stage 1: the head's high-frequency boost, a +4 dB shelf.
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let Q = 0.7071752369554196;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: the RLB high-pass.
  K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  const highpass = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, highpass];
}

/**
 * K-weighted energy of each 100 ms hop, summed over channels.
 * Returns a Float64Array of mean-square values, one per complete hop.
 */
export function hopEnergies(channels, sampleRate) {
  const hop = Math.round(HOP * sampleRate);
  const hops = Math.floor(channels[0].length / hop);
  const out = new Float64Array(hops);
  const [s1, s2] = kWeighting(sampleRate);
  for (const x of channels) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0; // shelf state
    let u1 = 0, u2 = 0, v1 = 0, v2 = 0; // high-pass state
    for (let h = 0, i = 0; h < hops; h++) {
      let sum = 0;
      for (let k = 0; k < hop; k++, i++) {
        const x0 = x[i];
        const y0 = s1.b0 * x0 + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        const v0 = y0 - 2 * u1 + u2 - s2.a1 * v1 - s2.a2 * v2;
        u2 = u1; u1 = y0; v2 = v1; v1 = v0;
        sum += v0 * v0;
      }
      out[h] += sum / hop;
    }
  }
  return out;
}

/** Sliding mean of `n` consecutive hops: the momentary (n = 4) or short-term (n = 30) series. */
function windows(energies, n) {
  const count = energies.length - n + 1;
  if (count <= 0) return new Float64Array(0);
  const out = new Float64Array(count);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += energies[i];
  out[0] = acc / n;
  for (let i = 1; i < count; i++) {
    acc += energies[i + n - 1] - energies[i - 1];
    out[i] = Math.max(0, acc) / n;
  }
  return out;
}

/** Gated mean in LUFS: drop blocks under the absolute gate, then under `relative` LU below what is left. */
function gated(blocks, relative) {
  const absGate = power(ABS_GATE);
  let sum = 0;
  let n = 0;
  for (const b of blocks) if (b > absGate) (sum += b), n++;
  if (!n) return { loudness: -Infinity, threshold: -Infinity };
  const threshold = lufs(sum / n) + relative;
  const relGate = Math.max(absGate, power(threshold));
  sum = 0;
  n = 0;
  for (const b of blocks) if (b > relGate) (sum += b), n++;
  return { loudness: n ? lufs(sum / n) : -Infinity, threshold };
}

/** Loudness range (EBU Tech 3342) from the short-term series. */
function loudnessRange(shortTerm) {
  const { threshold } = gated(shortTerm, -20);
  if (!Number.isFinite(threshold)) return 0;
  const gate = Math.max(power(ABS_GATE), power(threshold));
  const kept = [];
  for (const b of shortTerm) if (b > gate) kept.push(lufs(b));
  if (kept.length < 2) return 0;
  kept.sort((a, b) => a - b);
  const pct = (p) => kept[Math.min(kept.length - 1, Math.round(p * (kept.length - 1)))];
  return pct(0.95) - pct(0.1);
}

/* ── true peak ────────────────────────────────────────────────────────── */

const TP_TAPS = 12; // per phase
let tpPhases = null;
/** Four polyphase branches of a 48-tap Kaiser-windowed sinc: the 4x interpolator. */
function truePeakFilter() {
  if (tpPhases) return tpPhases;
  const L = 4;
  const N = TP_TAPS * L;
  const beta = 7.5;
  const i0 = (x) => {
    let s = 1, t = 1;
    for (let k = 1; k < 30; k++) (t *= (x / (2 * k)) ** 2), (s += t);
    return s;
  };
  const h = new Float64Array(N);
  const mid = (N - 1) / 2;
  for (let n = 0; n < N; n++) {
    const t = (n - mid) / L;
    const w = i0(beta * Math.sqrt(1 - ((n - mid) / (mid + 0.5)) ** 2)) / i0(beta);
    h[n] = (Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
  }
  tpPhases = [];
  for (let p = 0; p < L; p++) {
    const taps = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) sum += taps[k] = h[k * L + p];
    for (let k = 0; k < TP_TAPS; k++) taps[k] /= sum; // unity gain at DC in every phase
    tpPhases.push(taps);
  }
  return tpPhases;
}

/** Largest absolute value of the 4x-oversampled signal, linear. Never below the sample peak. */
export function truePeak(channels) {
  const phases = truePeakFilter();
  let peak = 0;
  for (const x of channels) {
    const n = x.length;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(x[i]);
      if (a > peak) peak = a;
    }
    // Inter-sample peaks only matter near the top, so skip the convolution
    // wherever the neighbourhood is too quiet to beat what has been found.
    for (let i = TP_TAPS - 1; i < n; i++) {
      const lim = peak * 0.5;
      if (Math.abs(x[i]) < lim && Math.abs(x[i - 5]) < lim && Math.abs(x[i - 6]) < lim) continue;
      for (let p = 0; p < 4; p++) {
        const taps = phases[p];
        let acc = 0;
        for (let k = 0; k < TP_TAPS; k++) acc += taps[k] * x[i - k];
        if (acc < 0) acc = -acc;
        if (acc > peak) peak = acc;
      }
    }
  }
  return peak;
}

/* ── the report ───────────────────────────────────────────────────────── */

const dB = (lin) => (lin > 0 ? 20 * Math.log10(lin) : -Infinity);

/**
 * Measure `channels` (Float32Arrays of equal length).
 * Returns { integrated, momentaryMax, shortTermMax, range, truePeakDb,
 * samplePeakDb, plr, duration } — loudness in LUFS, peaks in dBFS/dBTP, and
 * -Infinity for silence (a report is shown, never saved to a project).
 */
export function measureLoudness(channels, sampleRate) {
  const energies = hopEnergies(channels, sampleRate);
  const momentary = windows(energies, 4);
  const shortTerm = windows(energies, 30);
  const max = (arr) => {
    let m = 0;
    for (const v of arr) if (v > m) m = v;
    return lufs(m);
  };
  let sample = 0;
  for (const x of channels) for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > sample) sample = Math.abs(x[i]);
  const integrated = gated(momentary, -10).loudness;
  const truePeakDb = dB(truePeak(channels));
  return {
    integrated,
    momentaryMax: max(momentary),
    // Under 3 s there is no short-term window; the momentary maximum stands in.
    shortTermMax: shortTerm.length ? max(shortTerm) : max(momentary),
    range: loudnessRange(shortTerm),
    truePeakDb,
    samplePeakDb: dB(sample),
    plr: Number.isFinite(integrated) ? truePeakDb - integrated : 0,
    duration: channels[0].length / sampleRate,
  };
}

/** Convenience for an AudioBuffer (or anything with getChannelData). */
export function measureBuffer(buffer) {
  const channels = [];
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c));
  return measureLoudness(channels, buffer.sampleRate);
}

/**
 * The gain (dB) that takes a measured programme to `targetLufs`, held back if
 * it would push the true peak over `ceilingDb`.
 * Returns { gainDb, limited, shortfall } — `shortfall` is how many LU short of
 * the target the ceiling leaves it.
 */
export function gainToTarget(report, targetLufs, ceilingDb = -1) {
  if (!Number.isFinite(report.integrated)) return { gainDb: 0, limited: false, shortfall: 0 };
  const wanted = targetLufs - report.integrated;
  const room = ceilingDb - report.truePeakDb;
  if (wanted <= room) return { gainDb: wanted, limited: false, shortfall: 0 };
  return { gainDb: room, limited: true, shortfall: wanted - room };
}
