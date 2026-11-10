// Guitar amp and speaker cabinet, on native nodes.
//
// The amp is the classic shape: a tightening high-pass, cascaded asymmetric
// gain stages with filters between them (so each stage clips a differently
// voiced signal, which is most of what separates an amp from a fuzz box), a
// bass/mid/treble stack, a softer power stage with a presence shelf, and a
// speaker cabinet. Every waveshaper is 4x oversampled and every curve maps
// silence to silence, so nothing aliases audibly and a bounce starts clean.
//
// The cabinet is either a small biquad model or a user impulse response from
// the pool (an `asset` parameter). A ConvolverNode rejects a buffer whose
// sample rate differs from its context's, and `create` cannot await anything,
// so the IR is resampled synchronously here — which is what lets a 96 kHz
// bounce of a 48 kHz IR sound like playback.

import { dbToGain, clamp } from "../util.js";
import { assets } from "../state.js";
import { resample } from "../audio/resample.js";
import { setAudioParam } from "./dsp.js";

const BUTTERWORTH = -3.0103; // biquad lowpass/highpass Q is in dB in Web Audio
const P = (key, label, min, max, def, extra = {}) => ({ key, label, min, max, def, ...extra });

/* ── curves ───────────────────────────────────────────────────────────── */

/**
 * A WaveShaper clamps its input to ±1 before the lookup, and a curve that is
 * still rising there turns that clamp into a hard corner — exactly the edge
 * that aliases. So every curve here spans ±RANGE "signal units" across the
 * node's ±1, far enough out that tanh is flat at the ends, and the gain node
 * in front is scaled down by RANGE to match.
 */
const RANGE = 4;

/**
 * One gain stage: tanh pushed off-centre by `bias` for even harmonics, shifted
 * so 0 maps to 0, and scaled so the larger lobe peaks at exactly ±1.
 */
export function stageCurve(drive, bias, n = 8192) {
  const f = (x) => Math.tanh(drive * RANGE * x + bias) - Math.tanh(bias);
  const norm = Math.max(Math.abs(f(1)), Math.abs(f(-1)));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = f((i / (n - 1)) * 2 - 1) / norm;
  return { curve };
}

/**
 * Per-voicing constants. `pre` are the gains into stages 1–3 at Gain = 5;
 * `curves` their [drive, bias]; `hp`/`lp` the filters after each stage;
 * `trim` (dB) brings each voicing out at about the level of the DI going in.
 */
const VOICINGS = {
  clean: {
    tight: 70,
    bright: 3,
    pre: [0.9, 0.55, 0.5],
    curves: [[1.4, 0.2], [1.4, -0.15], [1.2, 0.1]],
    hp: [40, 40],
    lp: [11000, 10000, 9000],
    mid: [450, -3.5],
    power: 0.35,
    trim: 17.5,
  },
  crunch: {
    tight: 105,
    bright: 1.5,
    pre: [4.5, 2.2, 0.9],
    curves: [[3, 0.3], [3, -0.25], [2, 0.1]],
    hp: [160, 90],
    lp: [8500, 7500, 7000],
    mid: [800, 2],
    power: 0.5,
    trim: -12,
  },
  "high gain": {
    tight: 145,
    bright: 0,
    pre: [14, 8, 3],
    curves: [[4, 0.35], [4, -0.3], [3, 0.15]],
    hp: [380, 130],
    lp: [7500, 6500, 6000],
    mid: [650, -1.5],
    power: 0.55,
    trim: -13.5,
  },
};
const curveCache = new Map();
function curvesFor(voicing) {
  if (!curveCache.has(voicing)) curveCache.set(voicing, VOICINGS[voicing].curves.map(([d, b]) => stageCurve(d, b)));
  return curveCache.get(voicing);
}
const POWER = stageCurve(1.6, 0.05);
/** The built-in model's own average level over the band irBuffer matches to (test 22 checks it). */
const MODEL_BAND_LEVEL = 1.126;

/* ── cabinet ──────────────────────────────────────────────────────────── */

const IR_MAX_SECONDS = 6;

/**
 * The pool asset `id` as a convolver-ready buffer at `ctx`'s rate, or null.
 * Level-matched: scaled so its average response across 150 Hz – 2.5 kHz equals
 * the built-in model's, so switching cabs changes the tone and not the volume. Cached per asset and rate.
 */
export function irBuffer(ctx, id) {
  const asset = id ? assets.get(id) : null;
  const src = asset?.buffer;
  if (!src) return null;
  asset.irCache ??= new Map();
  if (asset.irCache.has(ctx.sampleRate)) return asset.irCache.get(ctx.sampleRate);

  const chans = Math.min(2, src.numberOfChannels);
  const len = Math.min(src.length, Math.floor(IR_MAX_SECONDS * src.sampleRate));
  const data = [];
  for (let c = 0; c < chans; c++) data.push(src.getChannelData(c).subarray(0, len));

  const scale = MODEL_BAND_LEVEL / Math.max(1e-9, bandLevel(data[0], src.sampleRate));
  // A filter resampled to a higher rate has more, proportionally smaller taps.
  const rateGain = src.sampleRate / ctx.sampleRate;
  const outLen = Math.max(1, Math.round((len * ctx.sampleRate) / src.sampleRate));
  const out = ctx.createBuffer(chans, outLen, ctx.sampleRate);
  for (let c = 0; c < chans; c++) {
    const r = src.sampleRate === ctx.sampleRate ? data[c] : resample(data[c], src.sampleRate, ctx.sampleRate);
    const d = out.getChannelData(c);
    for (let i = 0; i < outLen; i++) d[i] = (r[i] ?? 0) * scale * rateGain;
  }
  asset.irCache.set(ctx.sampleRate, out);
  return out;
}

/** RMS of |H(f)| over 150 Hz – 2.5 kHz, at log-spaced points. */
function bandLevel(h, sampleRate) {
  const POINTS = 24;
  let sum = 0;
  for (let k = 0; k < POINTS; k++) {
    const hz = 150 * Math.pow(2500 / 150, k / (POINTS - 1));
    const w = (2 * Math.PI * hz) / sampleRate;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < h.length; i++) {
      const s0 = h[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    sum += Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2);
  }
  return Math.sqrt(sum / POINTS);
}

/**
 * The cabinet section, shared by the amp and the stand-alone cab plugin.
 * update({ on, ir }): `ir` is a pool asset id, or "" for the built-in model.
 */
export function createCab(ctx, offline) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const mk = (type, freq, q, gain = 0) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gain;
    return f;
  };
  // A closed-back 4x12, roughly: resonant roll-off under 80 Hz, a thump at
  // 120, a little boxiness taken out at 400, the cone's presence peak, then
  // nothing much above 5 kHz.
  const model = [
    mk("highpass", 80, 2),
    mk("peaking", 120, 1.2, 2.5),
    mk("peaking", 400, 1, -2),
    mk("peaking", 2400, 1.4, 3.5),
    mk("lowpass", 5000, 0),
    mk("lowpass", 5500, BUTTERWORTH),
  ];
  const gModel = ctx.createGain();
  const gIr = ctx.createGain();
  const gDry = ctx.createGain();
  const conv = ctx.createConvolver();
  conv.normalize = false; // irBuffer has already level-matched it
  model.reduce((a, b) => (a.connect(b), b), input).connect(gModel).connect(output);
  input.connect(conv).connect(gIr).connect(output);
  input.connect(gDry).connect(output);
  gIr.gain.value = 0;
  gDry.gain.value = 0;

  let key = null;
  const handle = {
    input,
    output,
    /** True when an IR is selected but its audio isn't in the pool (yet). */
    irMissing: false,
    update({ on = true, ir = "" }) {
      const buf = on && ir ? irBuffer(ctx, ir) : null;
      const k = `${on}|${ir}|${buf ? 1 : 0}`;
      if (k !== key) {
        key = k;
        conv.buffer = buf;
        handle.irMissing = !!(on && ir && !buf);
      }
      // A selected IR that isn't loaded falls back to the model rather than to
      // silence or to a raw, cab-less amp.
      const mode = !on ? "dry" : buf ? "ir" : "model";
      setAudioParam(ctx, gModel.gain, mode === "model" ? 1 : 0, offline);
      setAudioParam(ctx, gIr.gain, mode === "ir" ? 1 : 0, offline);
      setAudioParam(ctx, gDry.gain, mode === "dry" ? 1 : 0, offline);
    },
    dispose() {
      for (const n of [...model, gModel, gIr, gDry, conv]) n.disconnect();
    },
  };
  return handle;
}

/* ── plugins ──────────────────────────────────────────────────────────── */

const IR_PARAM = {
  key: "ir",
  label: "Cab IR",
  asset: true,
  def: "",
  hint: "An impulse response from the pool. None selected uses the built-in 4x12 model.",
};

export const ampPlugin = {
  id: "core.amp",
  name: "Amp Sim",
  category: "Distortion",
  description:
    "Guitar amp and cabinet for a recorded DI. Browser monitoring is too slow to play through comfortably: track with your interface's direct monitoring and add the amp afterwards.",
  params: [
    { key: "voicing", label: "Voicing", choices: ["clean", "crunch", "high gain"], def: "crunch" },
    P("gain", "Gain", 0, 10, 5, { prec: 1 }),
    P("bass", "Bass", 0, 10, 5, { prec: 1 }),
    P("mid", "Mid", 0, 10, 5, { prec: 1 }),
    P("treble", "Treble", 0, 10, 5, { prec: 1 }),
    P("presence", "Presence", 0, 10, 5, { prec: 1 }),
    P("master", "Master", -24, 12, 0, { unit: "dB" }),
    { key: "cab", label: "Cabinet", bool: true, def: true },
    IR_PARAM,
  ],

  create(ctx, offline) {
    const bq = (type) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      return f;
    };
    const sh = () => {
      const s = ctx.createWaveShaper();
      s.oversample = "4x";
      return s;
    };
    const input = ctx.createGain();
    const tight = bq("highpass");
    const bright = bq("highshelf");
    const pre = [ctx.createGain(), ctx.createGain(), ctx.createGain()];
    const stage = [sh(), sh(), sh()];
    const hp = [bq("highpass"), bq("highpass")];
    const lp = [bq("lowpass"), bq("lowpass"), bq("lowpass")];
    const bass = bq("lowshelf");
    const mid = bq("peaking");
    const voice = bq("peaking"); // the stack's built-in character, per voicing
    const treble = bq("highshelf");
    const powerIn = ctx.createGain();
    const power = sh();
    const presence = bq("highshelf");
    const dc = bq("highpass");
    const cab = createCab(ctx, offline);
    const out = ctx.createGain();

    tight.Q.value = BUTTERWORTH;
    bright.frequency.value = 2500;
    for (const f of [...hp, ...lp]) f.Q.value = BUTTERWORTH;
    bass.frequency.value = 120;
    mid.frequency.value = 650;
    mid.Q.value = 0.7;
    voice.Q.value = 0.8;
    treble.frequency.value = 3200;
    presence.frequency.value = 4200;
    dc.frequency.value = 20;
    dc.Q.value = BUTTERWORTH;
    power.curve = POWER.curve;

    const path = [
      input, tight, bright,
      pre[0], stage[0], hp[0], lp[0],
      pre[1], stage[1], hp[1], lp[1],
      pre[2], stage[2], lp[2],
      bass, mid, voice, treble,
      powerIn, power, presence, dc, cab.input,
    ];
    path.reduce((a, b) => (a.connect(b), b));
    cab.output.connect(out);

    let voicing = null;
    return {
      input,
      output: out,
      cab,
      update(p) {
        const name = VOICINGS[p.voicing] ? p.voicing : "crunch";
        const v = VOICINGS[name];
        if (name !== voicing) {
          voicing = name;
          curvesFor(name).forEach((c, i) => (stage[i].curve = c.curve));
        }
        // Gain is ±20 dB around the voicing's own drive, most of it into the
        // first stage — which is how a gain pot before the first triode acts.
        const turn = Math.pow(10, (clamp(p.gain, 0, 10) - 5) / 5);
        const set = (param, value) => setAudioParam(ctx, param, value, offline);
        set(tight.frequency, v.tight);
        set(bright.gain, v.bright);
        set(pre[0].gain, (v.pre[0] * Math.pow(turn, 0.7)) / RANGE);
        set(pre[1].gain, (v.pre[1] * Math.pow(turn, 0.3)) / RANGE);
        set(pre[2].gain, v.pre[2] / RANGE);
        hp.forEach((f, i) => set(f.frequency, v.hp[i]));
        lp.forEach((f, i) => set(f.frequency, v.lp[i]));
        const knob = (x) => (clamp(x, 0, 10) - 5) * 2.4; // 0…10 → ±12 dB
        set(bass.gain, knob(p.bass));
        set(mid.gain, knob(p.mid));
        set(voice.frequency, v.mid[0]);
        set(voice.gain, v.mid[1]);
        set(treble.gain, knob(p.treble));
        set(powerIn.gain, v.power / RANGE);
        set(presence.gain, (clamp(p.presence, 0, 10) - 5) * 1.6);
        set(out.gain, dbToGain(p.master + v.trim));
        cab.update({ on: p.cab !== false, ir: p.ir });
      },
      dispose() {
        cab.dispose();
      },
    };
  },
};

export const cabPlugin = {
  id: "core.cab",
  name: "Cabinet / IR",
  category: "Distortion",
  description:
    "A speaker cabinet on its own: the built-in 4x12 model, or any impulse response from the pool. Put it after pedals, or use it to load a room IR as a reverb send would.",
  params: [IR_PARAM, P("mix", "Mix", 0, 1, 1), P("level", "Level", -24, 12, 0, { unit: "dB" })],

  create(ctx, offline) {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const wet = ctx.createGain();
    const out = ctx.createGain();
    const cab = createCab(ctx, offline);
    input.connect(dry).connect(out);
    input.connect(cab.input);
    cab.output.connect(wet).connect(out);
    return {
      input,
      output: out,
      cab,
      update(p) {
        cab.update({ on: true, ir: p.ir });
        setAudioParam(ctx, wet.gain, p.mix, offline);
        setAudioParam(ctx, dry.gain, 1 - p.mix, offline);
        setAudioParam(ctx, out.gain, dbToGain(p.level), offline);
      },
      dispose() {
        cab.dispose();
      },
    };
  },
};
