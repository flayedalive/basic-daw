// True-peak look-ahead limiter.
//
// A limiter's job is to guarantee a ceiling without being heard doing it. The
// two halves of that pull against each other, and look-ahead is what lets both
// be had: the audio is delayed a few milliseconds, so the gain can be eased
// down *before* a peak arrives instead of snapping down on top of it.
//
//   1. Peak detection. Each input sample is interpolated 4x (a 48-tap
//      polyphase FIR, as ITU-R BS.1770 prescribes) and the largest magnitude,
//      across both channels, is that sample's "true peak" — what a converter
//      will reconstruct, which can be well above any one sample.
//   2. The gain each sample needs is ceiling / peak (or 1).
//   3. A sliding minimum over the look-ahead window turns that into "the gain
//      the next few milliseconds need", so the lowest point is known early.
//   4. Release is applied to that: a fast envelope for isolated peaks and a
//      slow one that only builds up under sustained limiting, taking the lower
//      of the two. That is the program-dependent part — a drum hit recovers
//      quickly, a dense passage is held steady instead of pumping.
//   5. A moving average the length of the look-ahead smooths the result. This
//      is the attack: a linear ramp that ends exactly as the peak leaves the
//      delay line. An average of values that are all low enough is itself low
//      enough, so the ceiling holds by construction.
//
// Stereo-linked: both channels get the same gain. All settings are k-rate
// AudioParams; the port only reports gain reduction.

const TAPS = 12; // per polyphase branch
const MAX_LOOKAHEAD = 0.01; // seconds
// The interpolator looks at 12 samples, so a sample can raise the true peak
// reported up to 11 samples later; the delay and the window allow for that.
const SPAN = TAPS - 1;

/** Four polyphase branches of a Kaiser-windowed sinc — the same filter audio/loudness.js measures with. */
function interpolator() {
  const L = 4;
  const N = TAPS * L;
  const beta = 7.5;
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
  const h = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = (n - mid) / L;
    const w = i0(beta * Math.sqrt(1 - ((n - mid) / (mid + 0.5)) ** 2)) / i0(beta);
    h[n] = (Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t)) * w;
  }
  const phases = [];
  for (let p = 0; p < L; p++) {
    const taps = new Float64Array(TAPS);
    let sum = 0;
    for (let k = 0; k < TAPS; k++) sum += taps[k] = h[k * L + p];
    for (let k = 0; k < TAPS; k++) taps[k] /= sum;
    phases.push(taps);
  }
  return phases;
}

class LimiterProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
    return [
      k("gain", 0, -24, 36), // dB into the limiter
      k("ceiling", -1, -24, 0), // dBTP
      // In samples, not seconds: the host compensates for this delay, and a whole
      // number of samples is the one thing both sides can agree on exactly.
      k("lookahead", 144, 8, 8192),
      k("release", 0.1, 0.005, 2), // seconds
    ];
  }

  constructor() {
    super();
    const max = Math.ceil(MAX_LOOKAHEAD * sampleRate) + SPAN + 2;
    let size = 256;
    while (size < max + 256) size <<= 1;
    this.mask = size - 1;
    this.phases = interpolator();
    this.audio = [new Float32Array(size), new Float32Array(size)]; // the delayed signal (after input gain)
    this.need = new Float32Array(size); // gain each instant needs
    this.env = new Float32Array(size); // after release, before smoothing
    // Monotonic queue of indices into `need`, for the sliding minimum.
    this.q = new Int32Array(size);
    this.qHead = 0;
    this.qTail = 0;
    this.n = 0; // samples processed
    this.fast = 1;
    this.slow = 1;
    this.sum = 0; // running sum of `env` over the smoothing window
    this.look = -1;
    this.minGain = 1;
    this.sinceMeter = 0;
  }

  /** Changing the look-ahead resizes the windows; start their bookkeeping afresh. */
  resize(look) {
    this.look = look;
    this.qHead = this.qTail = 0;
    this.env.fill(1);
    this.need.fill(1);
    this.sum = look; // `look` ones
    this.fast = this.slow = 1;
  }

  process(inputs, outputs, params) {
    const inL = inputs[0][0];
    const inR = inputs[0][1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const frames = outL.length;

    const look = Math.max(8, Math.min(Math.round(params.lookahead[0]), this.mask - SPAN - 130));
    if (look !== this.look) this.resize(look);
    const delay = look + SPAN; // audio delay, and this processor's latency, in samples
    const window = look + SPAN + 1; // sliding-minimum length
    const drive = Math.pow(10, params.gain[0] / 20);
    // Aim a hundredth of a dB under the ceiling asked for. The gain is applied
    // to samples, and the interpolated peaks of the *result* can differ from
    // gain × the interpolated peaks of the input by a hair (measured: 0.0001 dB).
    const ceiling = Math.pow(10, (params.ceiling[0] - 0.01) / 20);
    const rel = params.release[0];
    const fastCoef = 1 - Math.exp(-1 / (rel * sampleRate));
    // The slow envelope sinks only under sustained reduction and takes ten
    // times as long to come back.
    const slowDown = 1 - Math.exp(-1 / (0.15 * sampleRate));
    const slowUp = 1 - Math.exp(-1 / (Math.max(0.3, rel * 10) * sampleRate));
    const { mask, phases, need, env, q } = this;
    const aL = this.audio[0];
    const aR = this.audio[1];
    let { n, fast, slow, sum, qHead, qTail, minGain } = this;

    for (let i = 0; i < frames; i++) {
      const w = n & mask;
      const l = (inL ? inL[i] : 0) * drive;
      const r = (inR ? inR[i] : 0) * drive;
      aL[w] = l;
      aR[w] = r;

      // 1. True peak of the newest 12 samples: the sample itself and the four
      //    interpolated points beside it, on both channels.
      let peak = Math.max(Math.abs(l), Math.abs(r));
      for (let p = 0; p < 4; p++) {
        const taps = phases[p];
        let sl = 0;
        let sr = 0;
        for (let k = 0; k < TAPS; k++) {
          const idx = (w - k) & mask;
          sl += taps[k] * aL[idx];
          sr += taps[k] * aR[idx];
        }
        if (sl < 0) sl = -sl;
        if (sr < 0) sr = -sr;
        if (sl > peak) peak = sl;
        if (sr > peak) peak = sr;
      }

      // 2. The gain this instant needs.
      const g = peak > ceiling ? ceiling / peak : 1;
      need[w] = g;

      // 3. Sliding minimum over the window (monotonic queue: front is the minimum).
      while (qTail !== qHead && need[q[(qTail - 1) & mask] & mask] >= g) qTail = (qTail - 1) & mask;
      q[qTail] = n;
      qTail = (qTail + 1) & mask;
      while (q[qHead] <= n - window) qHead = (qHead + 1) & mask;
      const low = need[q[qHead] & mask];

      // 4. Release: instant down, eased back up; the slow envelope adds the
      //    program dependence.
      fast = low < fast ? low : fast + (low - fast) * fastCoef;
      slow += (low - slow) * (low < slow ? slowDown : slowUp);
      const e = fast < slow ? fast : slow;

      // 5. Moving average over the look-ahead: the attack ramp.
      sum += e - env[(n - look) & mask];
      env[w] = e;
      let gain = sum / look;
      if (gain > 1) gain = 1; // rounding in the running sum

      const rd = (n - delay) & mask;
      outL[i] = aL[rd] * gain;
      if (outR) outR[i] = aR[rd] * gain;
      if (gain < minGain) minGain = gain;
      n++;
    }
    // The running sum drifts by a few ulps per block; rebuild it now and then.
    if ((n & 0xffff) < frames) {
      sum = 0;
      for (let k = 1; k <= look; k++) sum += env[(n - k) & mask];
    }
    Object.assign(this, { n, fast, slow, sum, qHead, qTail });

    // Metering only: the deepest gain reduction since the last report, in dB.
    this.sinceMeter += frames;
    this.minGain = minGain;
    if (this.sinceMeter >= 2048) {
      this.port.postMessage(20 * Math.log10(Math.max(1e-6, minGain)));
      this.sinceMeter = 0;
      this.minGain = 1;
    }
    return true;
  }
}

registerProcessor("daw-limiter", LimiterProcessor);
