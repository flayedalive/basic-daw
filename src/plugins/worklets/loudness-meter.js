// Live loudness meter: momentary, short-term and integrated LUFS, and true
// peak, per ITU-R BS.1770 / EBU R 128 — the running counterpart of
// audio/loudness.js, which measures a finished bounce.
//
// It only listens. Its output is silence, nothing downstream depends on it,
// and it is never part of a bounce; ten times a second it posts
// { momentary, shortTerm, integrated, truePeak } to the UI. A "reset" message
// starts the integrated measurement and the peak hold again — the one message
// it accepts, and it changes no audio.

const TAPS = 12;
const ABS_GATE = -70;
const lufs = (ms) => (ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity);
const power = (l) => Math.pow(10, (l + 0.691) / 10);

function kWeighting() {
  let K = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let Q = 0.7071752369554196;
  let a0 = 1 + K / Q + K * K;
  const shelf = { b0: (Vh + (Vb * K) / Q + K * K) / a0, b1: (2 * (K * K - Vh)) / a0, b2: (Vh - (Vb * K) / Q + K * K) / a0, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  K = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  Q = 0.5003270373238773;
  a0 = 1 + K / Q + K * K;
  return [shelf, { a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 }];
}

function interpolator() {
  const L = 4;
  const N = TAPS * L;
  const i0 = (x) => {
    let s = 1;
    let t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  const mid = (N - 1) / 2;
  const phases = [];
  for (let p = 0; p < L; p++) {
    const taps = new Float64Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const n = k * L + p;
      const t = (n - mid) / L;
      const w = i0(7.5 * Math.sqrt(1 - ((n - mid) / (mid + 0.5)) ** 2)) / i0(7.5);
      sum += taps[k] = (Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
    }
    for (let k = 0; k < TAPS; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
}

class LoudnessMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    [this.shelf, this.hp] = kWeighting();
    this.phases = interpolator();
    this.hop = Math.round(0.1 * sampleRate);
    this.f = [new Float64Array(8), new Float64Array(8)]; // filter state per channel
    this.hist = [new Float32Array(16), new Float32Array(16)]; // last samples, for the interpolator
    this.h = 0;
    this.acc = 0; // K-weighted energy in the current hop
    this.count = 0;
    this.recent = new Float64Array(30); // the last 3 s of hops
    this.hops = 0;
    this.reset();
    this.port.onmessage = (e) => {
      if (e.data === "reset") this.reset();
    };
  }

  reset() {
    this.blocks = new Float64Array(4096); // every 400 ms block's energy since the reset
    this.nBlocks = 0;
    this.peak = 0;
    this.sinceReset = 0;
  }

  /** Gated mean of the stored blocks (absolute gate, then 10 LU below what remains). */
  integrated() {
    const abs = power(ABS_GATE);
    let sum = 0;
    let n = 0;
    for (let i = 0; i < this.nBlocks; i++) if (this.blocks[i] > abs) (sum += this.blocks[i]), n++;
    if (!n) return -Infinity;
    const rel = Math.max(abs, power(lufs(sum / n) - 10));
    sum = 0;
    n = 0;
    for (let i = 0; i < this.nBlocks; i++) if (this.blocks[i] > rel) (sum += this.blocks[i]), n++;
    return n ? lufs(sum / n) : -Infinity;
  }

  process(inputs) {
    const chans = inputs[0];
    const n = chans[0]?.length ?? 128;
    const { shelf: s, hp, phases } = this;
    let { acc, count, peak, h } = this;

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const x = chans[c] ? chans[c][i] : chans[0] && c ? chans[0][i] : 0;
        const f = this.f[c];
        const y = s.b0 * x + s.b1 * f[0] + s.b2 * f[1] - s.a1 * f[2] - s.a2 * f[3];
        f[1] = f[0]; f[0] = x; f[3] = f[2]; f[2] = y;
        const v = y - 2 * f[4] + f[5] - hp.a1 * f[6] - hp.a2 * f[7];
        f[5] = f[4]; f[4] = y; f[7] = f[6]; f[6] = v;
        acc += v * v;

        // True peak: the sample, and four interpolated points beside it.
        const hist = this.hist[c];
        hist[h] = x;
        let a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        if (a > peak * 0.5) {
          for (let p = 0; p < 4; p++) {
            const taps = phases[p];
            let sum = 0;
            for (let k = 0; k < TAPS; k++) sum += taps[k] * hist[(h - k) & 15];
            if (sum < 0) sum = -sum;
            if (sum > peak) peak = sum;
          }
        }
      }
      h = (h + 1) & 15;
      if (++count === this.hop) {
        this.recent[this.hops % 30] = acc / this.hop;
        this.hops++;
        this.sinceReset++;
        acc = 0;
        count = 0;
        this.peak = peak;
        this.report();
        peak = this.peak;
      }
    }
    Object.assign(this, { acc, count, peak, h });
    return true;
  }

  report() {
    const mean = (hops) => {
      const have = Math.min(hops, this.hops);
      if (!have) return 0;
      let sum = 0;
      for (let k = 1; k <= have; k++) sum += this.recent[(this.hops - k) % 30];
      return sum / hops;
    };
    const momentary = mean(4);
    if (this.sinceReset >= 4) {
      if (this.nBlocks === this.blocks.length) {
        const bigger = new Float64Array(this.blocks.length * 2);
        bigger.set(this.blocks);
        this.blocks = bigger;
      }
      this.blocks[this.nBlocks++] = momentary;
    }
    this.port.postMessage({
      momentary: lufs(momentary),
      shortTerm: this.hops >= 30 ? lufs(mean(30)) : lufs(mean(Math.max(4, Math.min(30, this.hops)))),
      integrated: this.integrated(),
      truePeak: this.peak > 0 ? 20 * Math.log10(this.peak) : -Infinity,
    });
  }
}

registerProcessor("daw-loudness", LoudnessMeter);
