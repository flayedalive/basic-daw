// Real-time pitch correction for one voice.
//
// The pitch editor's two halves — a YIN detector and a PSOLA shifter — made
// causal. The detector reads the input as it arrives; the audio is delayed by
// a fixed 32 ms, which is the look-ahead the shifter needs to cut a grain two
// periods wide around a point it has not played yet. The host is told that
// delay and compensates for it.
//
//   detect   every 5 ms, on a copy of the input decimated to ~12 kHz: YIN's
//            normalised difference picks the period, then the difference is
//            recomputed at the full rate around that lag for a fraction of a
//            sample's precision.
//   decide   the detected pitch is snapped to the nearest note of the scale
//            (with a little hysteresis, so a note sitting between two does
//            not flicker). The correction is the distance to that note, less
//            the variance left alone, scaled by the amount, and it is eased in
//            over the speed time — instantly at 0, which is the robot.
//   shift    grains are laid down one synthesis period apart, each cut from
//            the input a whole number of periods on from the last, so every
//            grain holds the same slice of the waveform's cycle. Closer
//            together is higher; the grains themselves — the formants — are
//            not resampled.
//
// Where nothing is corrected (unvoiced sound, amount 0, a note inside the
// variance) each grain is cut from where it is laid and its window is the
// complement of its neighbours', so the output is the input, delayed.
//
// Parity: the processor is a function of its input and its parameters alone.
// After a ring's worth of silence it goes idle and starts afresh on
// the next sample that is not, so where the 128-sample blocks happen to
// fall — which differs between playback and a bounce — changes nothing.

const LATENCY = 0.032; // seconds; the plugin's face reports the same figure
const MIN_HZ = 80; // 2.5 periods of this must fit in the latency
const MAX_HZ = 1000;
const FRAME = 0.005; // seconds between detections, and the grain spacing through unvoiced sound
const SILENCE = 1e-15; // -300 dBFS
const HISTORY = 32; // frames remembered: 160 ms, several times the latency

class AutoTuneProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
    return [
      // The notes allowed, as twelve bits: bit n set means pitch class n (C = 0) is in the scale.
      k("scale", 4095, 0, 4095),
      k("amount", 1, 0, 1),
      k("speed", 30, 0, 1000), // ms for the correction to take hold
      k("variance", 0, 0, 100), // cents either side of the note left alone
    ];
  }

  constructor() {
    super();
    const sr = sampleRate;
    this.latency = Math.round(LATENCY * sr);
    let size = 1024;
    while (size < this.latency * 4) size <<= 1;
    this.size = size;
    this.mask = size - 1;
    this.inL = new Float32Array(size);
    this.inR = new Float32Array(size);
    this.mono = new Float32Array(size);
    this.outL = new Float32Array(size);
    this.outR = new Float32Array(size);

    // Detection runs on a decimated copy.
    this.dec = Math.max(1, Math.round(sr / 12000));
    const srD = sr / this.dec;
    this.tauMin = Math.max(2, Math.floor(srD / MAX_HZ));
    this.tauMax = Math.ceil(srD / MIN_HZ) + 1;
    this.win = Math.round(1.7 * this.tauMax);
    let dsize = 256;
    while (dsize < this.win + this.tauMax + 8) dsize <<= 1;
    this.d = new Float32Array(dsize);
    this.dmask = dsize - 1;
    this.frame = new Float32Array(this.win + this.tauMax + 1); // the detector's window, unwrapped
    this.cm = new Float32Array(this.tauMax + 2);
    this.hop = Math.max(1, Math.round((FRAME * sr) / this.dec)); // in decimated samples
    this.unvoicedPeriod = Math.round(FRAME * sr);
    this.maxPeriod = sr / MIN_HZ;
    // What each recent frame decided, and the moment in the input it speaks
    // for (the middle of the stretch it measured). A grain uses the frame
    // nearest to where it is laid, not the newest: the detector runs ahead of
    // the delayed audio, and a correction applied early is a wrong one.
    this.histAt = new Float64Array(HISTORY);
    this.histPeriod = new Float32Array(HISTORY);
    this.histRatio = new Float32Array(HISTORY);

    this.n = 0; // samples taken in since the processor woke
    this.zeros = size; // length of the current run of digital silence
    this.idle = true;
    this.sinceMeter = 0;
    this.reset();
  }

  /** Back to the state of a processor that has only ever heard silence. */
  reset() {
    this.n = 0;
    this.d.fill(0);
    this.dn = 0;
    this.decAcc = 0;
    this.decCount = 0;
    this.sinceHop = 0;
    this.period = 0; // samples; 0 while unvoiced
    this.midi = NaN;
    this.pending = NaN; // a pitch far from the last, waiting for a second frame to agree
    this.unvoicedFrames = 1000;
    this.note = NaN; // the scale note being corrected to
    this.shift = 0; // correction applied, semitones
    this.ratio = 1;
    this.histAt.fill(-Infinity);
    this.frames = 0;
    this.measuredAt = 0;
    this.s = 0; // where the next grain is laid, in input samples (fractional)
    this.off = 0; // how far ahead of that it is cut from
    this.hPrev = this.unvoicedPeriod; // half-width of the junction with the grain before
  }

  /* ── detect ─────────────────────────────────────────────────────────── */

  detect() {
    const { d, dmask, frame, cm, win, tauMin, tauMax } = this;
    const len = win + tauMax;
    const start = this.dn - len;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const v = d[(start + i) & dmask];
      frame[i] = v;
      if (i < win) energy += v * v;
    }
    this.measuredAt = this.n - (len * this.dec) / 2;
    if (energy / win < 1e-7) return 0; // under about -70 dBFS: nothing to follow

    // YIN: squared difference at each lag, normalised by its running mean.
    let sum = 0;
    cm[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let acc = 0;
      for (let i = 0; i < win; i++) {
        const e = frame[i] - frame[i + tau];
        acc += e * e;
      }
      sum += acc;
      cm[tau] = sum > 0 ? (acc * tau) / sum : 1;
    }
    let best = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (cm[tau] < 0.15) {
        while (tau + 1 < tauMax && cm[tau + 1] < cm[tau]) tau++;
        best = tau;
        break;
      }
    }
    if (best < 0) {
      let lo = Infinity;
      for (let tau = tauMin; tau < tauMax; tau++) if (cm[tau] < lo) (lo = cm[tau]), (best = tau);
      if (lo > 0.35) return 0; // not periodic enough to call a pitch
    }

    // Again at the full rate, a few lags either side, for the fraction.
    const { mono, mask, dec } = this;
    const centre = best * dec;
    const span = dec + 1;
    const w = Math.max(256, Math.min(1024, 2 * centre));
    const from = this.n - (w + centre + span + 1);
    let lowest = Infinity;
    let at = centre;
    let before = 0;
    let after = 0;
    let last = 0;
    for (let tau = centre - span; tau <= centre + span; tau++) {
      let acc = 0;
      for (let i = 0; i < w; i++) {
        const e = mono[(from + i) & mask] - mono[(from + i + tau) & mask];
        acc += e * e;
      }
      if (tau === at + 1) after = acc;
      if (acc < lowest) {
        lowest = acc;
        at = tau;
        before = last;
        after = 0;
      }
      last = acc;
    }
    let period = at;
    if (at > centre - span && at < centre + span) {
      const curve = before - 2 * lowest + after;
      if (curve > 0) period += (0.5 * (before - after)) / curve;
    }
    this.measuredAt = this.n - (w + period) / 2;
    return Math.min(this.maxPeriod, Math.max(2, period));
  }

  /** One detection frame: follow the pitch, choose the note, move the correction. */
  step(scale, amount, speed, variance) {
    this.follow(scale, amount, speed, variance);
    const f = this.frames++ % HISTORY;
    this.histAt[f] = this.measuredAt;
    this.histPeriod[f] = this.period;
    this.histRatio[f] = this.ratio;
  }

  follow(scale, amount, speed, variance) {
    let period = this.detect();
    let midi = period ? 69 + 12 * Math.log2(sampleRate / period / 440) : NaN;

    // A leap of more than four semitones in 5 ms is far more often the
    // detector slipping an octave than the singer; wait for a second opinion.
    if (period && this.period && Math.abs(midi - this.midi) > 4) {
      if (Number.isNaN(this.pending) || Math.abs(midi - this.pending) > 1) {
        this.pending = midi;
        period = this.period;
        midi = this.midi;
      } else {
        this.pending = NaN;
      }
    } else {
      this.pending = NaN;
    }

    if (!period) {
      this.period = 0;
      this.midi = NaN;
      this.ratio = 1;
      this.unvoicedFrames++;
      return;
    }
    // A new phrase starts uncorrected and is eased in, like a note in the editor.
    if (this.unvoicedFrames >= 8) {
      this.shift = 0;
      this.note = NaN;
    }
    this.unvoicedFrames = 0;
    this.period = period;
    this.midi = midi;

    const snapped = snap(midi, scale);
    if (Number.isNaN(this.note) || !inScale(this.note, scale)) this.note = snapped;
    else if (snapped !== this.note && Math.abs(midi - snapped) < Math.abs(midi - this.note) - 0.2) this.note = snapped;

    const error = midi - this.note;
    const dead = variance / 100;
    const beyond = error - Math.max(-dead, Math.min(dead, error));
    const want = -amount * beyond;
    // "Speed" is the time to get 95% of the way there.
    const k = speed > 0 ? 1 - Math.exp((-3 * FRAME * 1000) / speed) : 1;
    this.shift += (want - this.shift) * k;
    if (Math.abs(this.shift) < 1e-6) this.shift = 0;
    this.shift = Math.max(-12, Math.min(12, this.shift));
    this.ratio = this.shift === 0 ? 1 : Math.pow(2, this.shift / 12);
  }

  /* ── shift ──────────────────────────────────────────────────────────── */

  /** Lay the next grain at this.s. `floor` is the oldest output sample still to be played. */
  grain(floor) {
    const { hPrev, s, mask, inL, inR, outL, outR, histAt } = this;
    // The frame that measured the input nearest to here.
    let f = -1;
    let nearest = Infinity;
    for (let k = 0; k < HISTORY; k++) {
      const gap = Math.abs(histAt[k] - s);
      if (gap < nearest) (nearest = gap), (f = k);
    }
    const voiced = f >= 0 && this.histPeriod[f] > 0;
    let period = voiced ? this.histPeriod[f] : this.unvoicedPeriod;
    let ratio = voiced ? this.histRatio[f] : 1;
    if (voiced) {
      // Between two voiced frames, read between them: 5 ms steps in the
      // correction are audible as a flutter on a fast vibrato.
      const g = (f + (histAt[f] <= s ? 1 : HISTORY - 1)) % HISTORY;
      const t = (s - histAt[f]) / (histAt[g] - histAt[f]);
      if (this.histPeriod[g] > 0 && t > 0 && t < 1) {
        period += (this.histPeriod[g] - period) * t;
        ratio += (this.histRatio[g] - ratio) * t;
      }
    }
    const spacing = period / ratio;
    const h = Math.min(spacing, period); // junction with the grain after

    // Cut from a whole number of periods on from the last cut, as near to
    // where it is laid as that allows — or from exactly there if nothing is
    // being shifted.
    let off = 0;
    if (voiced && (ratio !== 1 || this.off !== 0)) {
      off = this.off;
      off -= Math.round(off / period) * period;
      // Never past what has arrived (two more samples for the interpolator).
      while (s + h + off + 2 > this.n - 1) off -= period;
    }
    this.off = off;

    const first = Math.max(floor, Math.ceil(s - hPrev));
    const last = Math.floor(s + h);
    const whole = Math.floor(off);
    const frac = off - whole;
    for (let o = first; o <= last; o++) {
      const t = o - s;
      const w = t < 0 ? 0.5 + 0.5 * Math.cos((Math.PI * t) / hPrev) : 0.5 + 0.5 * Math.cos((Math.PI * t) / h);
      if (w <= 0) continue;
      const i = o + whole;
      let l;
      let r;
      if (frac === 0) {
        l = inL[i & mask];
        r = inR[i & mask];
      } else {
        l = cubic(inL[(i - 1) & mask], inL[i & mask], inL[(i + 1) & mask], inL[(i + 2) & mask], frac);
        r = cubic(inR[(i - 1) & mask], inR[i & mask], inR[(i + 1) & mask], inR[(i + 2) & mask], frac);
      }
      outL[o & mask] += w * l;
      outR[o & mask] += w * r;
    }
    // The next grain is laid `spacing` on and wants to be cut `period` on.
    this.off = off + period - spacing;
    if (!voiced) this.off = 0;
    this.s = s + spacing;
    this.hPrev = h;
  }

  process(inputs, outputs, params) {
    const inL = inputs[0][0];
    const inR = inputs[0][1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1] ?? outL;
    const len = outL.length;
    const scale = Math.round(params.scale[0]) & 4095 || 4095;
    const amount = params.amount[0];
    const speed = params.speed[0];
    const variance = params.variance[0];
    const { mask, latency, dec } = this;

    for (let i = 0; i < len; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      // "Silence" includes the host's priming signal (400 dB down), which is
      // there to wake native nodes and must not start this one's clock.
      if (l < SILENCE && l > -SILENCE && r < SILENCE && r > -SILENCE) {
        if (++this.zeros >= this.size && !this.idle) {
          this.idle = true;
          this.reset();
        }
      } else {
        this.zeros = 0;
        if (this.idle) {
          // Awake. Everything in the rings is silence; the grid starts here.
          this.idle = false;
          this.s = this.n - latency;
        }
      }
      if (this.idle) {
        outL[i] = 0;
        outR[i] = 0;
        continue;
      }

      const n = this.n;
      this.inL[n & mask] = l;
      this.inR[n & mask] = r;
      const m = 0.5 * (l + r);
      this.mono[n & mask] = m;
      this.n = n + 1;

      this.decAcc += m;
      if (++this.decCount === dec) {
        this.d[this.dn & this.dmask] = this.decAcc / dec;
        this.dn++;
        this.decAcc = 0;
        this.decCount = 0;
        if (++this.sinceHop === this.hop) {
          this.sinceHop = 0;
          this.step(scale, amount, speed, variance);
        }
      }

      const out = n - latency; // the sample due out now
      while (this.s - this.hPrev <= out) this.grain(out);
      const at = out & mask;
      outL[i] = this.outL[at];
      outR[i] = this.outR[at];
      this.outL[at] = 0;
      this.outR[at] = 0;
    }

    // Metering only: what is heard, where it is being sent, and by how much.
    this.sinceMeter += len;
    if (this.sinceMeter >= sampleRate * 0.04) {
      this.sinceMeter = 0;
      this.port.postMessage(this.period ? { midi: this.midi, note: this.note, cents: this.shift * 100 } : null);
    }
    return true;
  }
}

const inScale = (note, scale) => ((scale >> (((Math.round(note) % 12) + 12) % 12)) & 1) === 1;

/** The note of the scale nearest to a fractional MIDI pitch (the lower, on a tie). */
function snap(midi, scale) {
  const base = Math.round(midi);
  for (let k = 0; k <= 6; k++) {
    const below = inScale(base - k, scale);
    const above = inScale(base + k, scale);
    if (below && above) return Math.abs(base - k - midi) <= Math.abs(base + k - midi) ? base - k : base + k;
    if (below) return base - k;
    if (above) return base + k;
  }
  return base;
}

/** Catmull-Rom through four samples, at `t` between the middle two. */
function cubic(a, b, c, d, t) {
  return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}

registerProcessor("daw-autotune", AutoTuneProcessor);
