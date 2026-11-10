// De-esser / dynamic EQ processor.
//
// One band, cut only when it is too loud. The band is isolated with a
// band-pass filter; its level is followed; and when that passes the threshold
// the same band is turned down in the signal — by subtracting some of the
// band-passed signal from the input:
//
//     y = x + (k - 1) · bandpass(x)          0 < k <= 1
//
// With a band-pass that peaks at exactly 0 dB this is a peaking cut of depth k
// at the centre frequency, and k can change every sample without recomputing
// a single filter coefficient — which is what lets it move fast enough to
// catch an "s" without zipper noise.
//
// "Listen" outputs the band-passed signal alone, to find the frequency by ear.

class DynEqProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
    return [
      k("frequency", 6500, 40, 20000), // Hz
      k("q", 2, 0.2, 20),
      k("threshold", -30, -80, 0), // dB, of the band's own level
      k("range", 10, 0, 40), // most it will cut, dB
      k("attack", 0.001, 0.00005, 0.5), // seconds
      k("release", 0.08, 0.001, 2),
      k("listen", 0, 0, 1),
    ];
  }

  constructor() {
    super();
    this.state = [new Float64Array(4), new Float64Array(4)]; // x1, x2, y1, y2 per channel
    this.key = "";
    this.c = null;
    this.gr = 0; // dB of cut, >= 0
    this.maxGr = 0;
    this.sinceMeter = 0;
  }

  process(inputs, outputs, params) {
    const inL = inputs[0][0];
    const inR = inputs[0][1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const n = outL.length;

    const hz = Math.min(params.frequency[0], sampleRate * 0.45);
    const q = params.q[0];
    const key = `${hz}|${q}`;
    if (key !== this.key) {
      // Band-pass with a constant 0 dB peak (RBJ cookbook).
      const w = (2 * Math.PI * hz) / sampleRate;
      const alpha = Math.sin(w) / (2 * q);
      const a0 = 1 + alpha;
      this.c = { b0: alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
      this.key = key;
    }
    const { b0, a1, a2 } = this.c;
    const T = params.threshold[0];
    const range = params.range[0];
    const coef = (t) => 1 - Math.exp(-1 / (Math.max(1e-5, t) * sampleRate));
    const att = coef(params.attack[0]);
    const rel = coef(params.release[0]);
    const listen = params.listen[0] >= 0.5;
    const sl = this.state[0];
    const sr = this.state[1];
    let { gr, maxGr } = this;

    for (let i = 0; i < n; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      // b1 = 0 and b2 = -b0 for this band-pass.
      const bl = b0 * (l - sl[1]) - a1 * sl[2] - a2 * sl[3];
      sl[1] = sl[0]; sl[0] = l; sl[3] = sl[2]; sl[2] = bl;
      const br = b0 * (r - sr[1]) - a1 * sr[2] - a2 * sr[3];
      sr[1] = sr[0]; sr[0] = r; sr[3] = sr[2]; sr[2] = br;

      const level = Math.max(Math.abs(bl), Math.abs(br));
      const over = (level > 1e-7 ? 20 * Math.log10(level) : -140) - T;
      // Everything over the threshold is taken back out, up to the range.
      const want = over <= 0 ? 0 : over < range ? over : range;
      gr += (want - gr) * (want > gr ? att : rel);
      if (gr < 1e-9) gr = 0;
      if (gr > maxGr) maxGr = gr;

      if (listen) {
        outL[i] = bl;
        if (outR) outR[i] = br;
      } else {
        const k = gr === 0 ? 0 : Math.pow(10, -gr / 20) - 1;
        outL[i] = l + k * bl;
        if (outR) outR[i] = r + k * br;
      }
    }
    this.gr = gr;

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

registerProcessor("daw-dyneq", DynEqProcessor);
