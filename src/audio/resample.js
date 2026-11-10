// Sample-rate conversion by windowed-sinc interpolation. Synchronous and free
// of the DOM and Web Audio, for the places an OfflineAudioContext cannot be
// awaited: a plugin's `create` (an impulse response must already be at the
// context's rate when the convolver gets it) and the offline pitch/stretch DSP.
//
// The kernel is tabulated once per (taps, phases) and interpolated linearly
// between phases, so the per-sample cost is 2·taps multiply-adds.

const PHASES = 512;
const tables = new Map();

function besselI0(x) {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 32; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

/** Kaiser-windowed sinc with `taps` zero crossings each side, unit cutoff. */
function kernelTable(taps) {
  if (tables.has(taps)) return tables.get(taps);
  const beta = 9; // ~ -90 dB stop band
  const i0b = besselI0(beta);
  const width = 2 * taps;
  const table = new Float32Array((PHASES + 1) * width);
  for (let p = 0; p <= PHASES; p++) {
    const frac = p / PHASES;
    for (let k = 0; k < width; k++) {
      // Tap k sits at integer offset (k - taps + 1) from floor(position).
      const t = k - taps + 1 - frac;
      const w = Math.abs(t) >= taps ? 0 : besselI0(beta * Math.sqrt(1 - (t / taps) ** 2)) / i0b;
      const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      table[p * width + k] = s * w;
    }
  }
  tables.set(taps, table);
  return table;
}

/**
 * Resample `input` from `inRate` to `outRate`. Amplitude-preserving (a sine
 * comes out at the level it went in). `taps` trades quality for speed: 16 is
 * fine for auditioning, 32 is transparent.
 */
export function resample(input, inRate, outRate, { taps = 32 } = {}) {
  if (inRate === outRate) return Float32Array.from(input);
  const ratio = outRate / inRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  return resampleTo(input, outLen, 1 / ratio, 0, { taps });
}

/**
 * The general form: write `outLen` samples reading `input` from position
 * `start`, advancing `step` input samples per output sample. A step above 1
 * (reading faster: downsampling, or pitching up) lowers the kernel's cutoff
 * to match, so nothing aliases.
 */
export function resampleTo(input, outLen, step, start = 0, { taps = 32 } = {}) {
  const out = new Float32Array(outLen);
  const n = input.length;
  if (!n) return out;
  // Downsampling stretches the kernel in time by `scale` and lowers its gain to match.
  const scale = Math.max(1, step);
  const table = kernelTable(taps);
  const width = 2 * taps;
  if (scale === 1) {
    for (let i = 0; i < outLen; i++) {
      const pos = start + i * step;
      const base = Math.floor(pos);
      const ph = (pos - base) * PHASES;
      const p0 = Math.floor(ph);
      const a = ph - p0;
      const row0 = p0 * width;
      const row1 = row0 + width;
      let acc = 0;
      const first = base - taps + 1;
      const k0 = first < 0 ? -first : 0;
      const k1 = first + width > n ? n - first : width;
      for (let k = k0; k < k1; k++) {
        const c = table[row0 + k];
        acc += input[first + k] * (c + (table[row1 + k] - c) * a);
      }
      out[i] = acc;
    }
    return out;
  }
  // Stretched kernel: evaluate the table at t/scale, over scale× as many inputs.
  const span = Math.ceil(taps * scale);
  const inv = 1 / scale;
  for (let i = 0; i < outLen; i++) {
    const pos = start + i * step;
    const base = Math.floor(pos);
    let acc = 0;
    const lo = Math.max(0, base - span + 1);
    const hi = Math.min(n - 1, base + span);
    for (let j = lo; j <= hi; j++) {
      // Kernel argument in zero-crossing units, then split into tap + phase.
      const t = (j - pos) * inv;
      if (t <= -taps || t >= taps) continue;
      const u = t + taps - 1; // 0 … width-1 (+ fraction)
      const ku = Math.ceil(u);
      const ph = (ku - u) * PHASES;
      const p0 = Math.floor(ph);
      const a = ph - p0;
      if (ku < 0 || ku >= width) continue;
      const c = table[p0 * width + ku];
      acc += input[j] * (c + (table[(p0 + 1) * width + ku] - c) * a);
    }
    out[i] = acc * inv;
  }
  return out;
}
