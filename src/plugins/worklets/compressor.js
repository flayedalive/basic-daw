// Compressor processor: the bus / glue compressor, and each band of the
// multiband compressor.
//
// A feed-forward design working in decibels:
//
//   detector    the louder channel (stereo-linked), optionally high-passed
//               first so bass does not drive the whole mix up and down, read
//               as peak or as a 10 ms RMS
//   computer    threshold, ratio and a soft knee (quadratic across the knee
//               width) give the gain reduction the level calls for
//   ballistics  a "decoupled" follower: the reduction called for is first
//               peak-held, falling back at the release rate, and that is then
//               smoothed at the attack rate. Holding the peak is what makes a
//               steady tone settle at the reduction the curve says, instead
//               of sagging between the crests of its own waveform. With
//               auto-release a second, much slower follower runs alongside
//               and the deeper of the two wins, so a single hit lets go
//               quickly while a dense passage is held
//   output      makeup gain, then a dry/wet mix for parallel compression
//
// It adds no delay, so dry and wet stay phase-aligned in the mix. At ratio 1
// it is exactly unity — unlike the native DynamicsCompressorNode, which is why
// the multiband compressor's bands sum flat with no workaround.

class CompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
    return [
      k("threshold", -18, -80, 0), // dB
      k("ratio", 4, 1, 100),
      k("knee", 6, 0, 40), // dB, full width
      k("attack", 0.01, 0.00005, 1), // seconds
      k("release", 0.2, 0.001, 5),
      k("makeup", 0, -24, 36), // dB
      k("mix", 1, 0, 1),
      k("scHpf", 20, 20, 2000), // Hz; 20 is off
      k("rms", 1, 0, 1), // 1: RMS detector, 0: peak
      k("auto", 0, 0, 1), // 1: program-dependent release
    ];
  }

  constructor() {
    super();
    this.gr = 0; // gain reduction, dB (>= 0)
    this.held = 0; // …peak-held, before the attack smoothing
    this.slow = 0; // the auto-release follower
    this.ms = 0; // mean square, for the RMS detector
    // Sidechain high-pass state, per channel: x1, x2, y1, y2.
    this.hp = [new Float64Array(4), new Float64Array(4)];
    this.hpHz = 0;
    this.c = null;
    this.maxGr = 0;
    this.sinceMeter = 0;
  }

  /** Butterworth high-pass coefficients for the sidechain. */
  setHpf(hz) {
    this.hpHz = hz;
    if (hz <= 20.5) {
      this.c = null;
      return;
    }
    const w = (2 * Math.PI * Math.min(hz, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.c = { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
  }

  process(inputs, outputs, params) {
    const inL = inputs[0][0];
    const inR = inputs[0][1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const n = outL.length;

    const T = params.threshold[0];
    const slope = 1 - 1 / Math.max(1, params.ratio[0]); // dB of reduction per dB over
    const W = params.knee[0];
    const coef = (t) => 1 - Math.exp(-1 / (Math.max(1e-5, t) * sampleRate));
    const att = coef(params.attack[0]);
    const rel = coef(params.release[0]);
    const auto = params.auto[0] >= 0.5;
    const slowAtt = coef(params.attack[0] * 8 + 0.6);
    const slowRel = coef(params.release[0] * 6);
    const makeup = Math.pow(10, params.makeup[0] / 20);
    const mix = params.mix[0];
    const useRms = params.rms[0] >= 0.5;
    const msCoef = coef(0.01);
    if (params.scHpf[0] !== this.hpHz) this.setHpf(params.scHpf[0]);
    const c = this.c;
    const hl = this.hp[0];
    const hr = this.hp[1];
    let { gr, held, slow, ms, maxGr } = this;

    for (let i = 0; i < n; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;

      // Detector signal.
      let sl = l;
      let sr = r;
      if (c) {
        sl = c.b0 * l + c.b1 * hl[0] + c.b2 * hl[1] - c.a1 * hl[2] - c.a2 * hl[3];
        hl[1] = hl[0]; hl[0] = l; hl[3] = hl[2]; hl[2] = sl;
        sr = c.b0 * r + c.b1 * hr[0] + c.b2 * hr[1] - c.a1 * hr[2] - c.a2 * hr[3];
        hr[1] = hr[0]; hr[0] = r; hr[3] = hr[2]; hr[2] = sr;
      }
      let level = Math.max(Math.abs(sl), Math.abs(sr));
      if (useRms) {
        ms += (level * level - ms) * msCoef;
        level = Math.sqrt(ms);
      }
      const dB = level > 1e-7 ? 20 * Math.log10(level) : -140;

      // Gain computer with a quadratic soft knee.
      const over = dB - T;
      let want;
      if (2 * over <= -W) want = 0;
      else if (2 * over < W) want = (slope * (over + W / 2) ** 2) / (2 * W);
      else want = slope * over;

      // Ballistics: hold the peak (release), then smooth towards it (attack).
      held = want > held ? want : held + (want - held) * rel;
      gr += (held - gr) * att;
      let red = gr;
      if (auto) {
        // It follows the reduction actually being applied, slowly both ways:
        // only reduction that *lasts* builds it up.
        slow += (gr - slow) * (gr > slow ? slowAtt : slowRel);
        if (slow > red) red = slow;
      }
      if (red < 1e-9) red = 0;
      if (red > maxGr) maxGr = red;

      const wet = red === 0 && makeup === 1 ? 1 : Math.pow(10, -red / 20) * makeup;
      const g = 1 - mix + mix * wet;
      outL[i] = l * g;
      if (outR) outR[i] = r * g;
    }
    if (gr < 1e-9) gr = 0;
    if (held < 1e-9) held = 0;
    if (slow < 1e-9) slow = 0;
    if (ms < 1e-20) ms = 0;
    Object.assign(this, { gr, held, slow, ms });

    // Metering only: the deepest reduction since the last report, as dB <= 0.
    this.sinceMeter += n;
    this.maxGr = maxGr;
    if (this.sinceMeter >= 2048) {
      this.port.postMessage(-maxGr);
      this.sinceMeter = 0;
      this.maxGr = 0;
    }
    return true;
  }
}

registerProcessor("daw-compressor", CompressorProcessor);
