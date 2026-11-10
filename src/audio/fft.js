// A radix-2 FFT. No DOM, no Web Audio: it is shared by the offline DSP
// (stretch, loudness, analysis) and by the Node tests that check them.
//
// Sizes are powers of two. One instance holds the twiddle and bit-reversal
// tables for its size, so make it once and reuse it.

export class FFT {
  constructor(n) {
    if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two (got ${n})`);
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
  }

  /** In-place forward transform of the complex signal (re, im). */
  forward(re, im) {
    this.#run(re, im, -1);
  }

  /** In-place inverse transform, scaled by 1/n so inverse(forward(x)) = x. */
  inverse(re, im) {
    this.#run(re, im, 1);
    const n = this.n;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }

  #run(re, im, sign) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const wr = cos[t];
          const wi = sign * sin[t];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

const cache = new Map();
/** A shared instance per size. */
export function fftOf(n) {
  if (!cache.has(n)) cache.set(n, new FFT(n));
  return cache.get(n);
}

/** Magnitude spectrum (n/2 + 1 bins) of a real block, optionally Hann-windowed. */
export function magnitudes(x, { window = true, n = nextPow2(x.length) } = {}) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const len = Math.min(n, x.length);
  for (let i = 0; i < len; i++) re[i] = window ? x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len)) : x[i];
  fftOf(n).forward(re, im);
  const out = new Float64Array(n / 2 + 1);
  // Scaled so a full-scale sine reads 1.0 at its bin (windowed or not).
  const norm = (window ? 4 : 2) / len;
  for (let i = 0; i <= n / 2; i++) out[i] = Math.hypot(re[i], im[i]) * norm;
  return out;
}

export const nextPow2 = (n) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));
