// Three-band compressor on native nodes.
//
// Crossovers are 4th-order Linkwitz–Riley: two Butterworth biquads in series
// per slope. (Web Audio's lowpass/highpass Q is in dB, so Butterworth is
// Q = -3.0103, not 0.707 — get that wrong and each crossover grows a 7 dB
// bump.) The low band also passes through one all-pass at the upper crossover:
// the mid and high bands have been through that crossover's phase shift and
// the low band has not, and without the all-pass the three would not sum flat.
//
// Each band has a DynamicsCompressorNode, which brings two quirks:
//
//  - It applies its own makeup gain, even to signal far below the threshold,
//    and offers no way to turn that off. With the knee held at 0 the amount is
//    a closed form — (-threshold × (1 - 1/ratio)) × 0.6 dB — so it is cancelled
//    here and each band's Gain knob means what it says. (The 0.6 exponent is
//    the same in Chromium, WebKit and Gecko, which share the implementation;
//    test 26 measures it rather than trusting this comment.)
//  - It delays the signal by 6 ms of look-ahead. Every band has one, so they
//    still line up with each other.
//
// Phase 4 replaces the native compressors with a worklet that needs neither
// workaround (handoff plan item 4.4).

import { dbToGain } from "../util.js";
import { setAudioParam } from "./dsp.js";

const BUTTERWORTH = -3.0103;
const P = (key, label, min, max, def, extra = {}) => ({ key, label, min, max, def, ...extra });

/** The makeup gain (dB) a hard-knee DynamicsCompressorNode adds on its own. */
export const nativeMakeupDb = (threshold, ratio) => -threshold * (1 - 1 / Math.max(1, ratio)) * 0.6;

const band = (id, name, thresh) => [
  P(`${id}Thresh`, `${name} thresh`, -60, 0, thresh, { unit: "dB" }),
  P(`${id}Ratio`, `${name} ratio`, 1, 20, 2.5, { unit: ":1", prec: 1 }),
  P(`${id}Gain`, `${name} gain`, -12, 12, 0, { unit: "dB", prec: 1 }),
];

export const multibandPlugin = {
  id: "core.multiband",
  name: "Multiband Compressor",
  category: "Dynamics",
  description:
    "Three bands, each with its own compressor, split by crossovers that sum flat. With every ratio at 1:1 it is transparent. Its 6 ms of look-ahead is compensated.",
  // The native compressors' look-ahead; the engine and the bounce compensate.
  latency: 0.006,
  params: [
    P("xLow", "Low / mid", 60, 1000, 200, { unit: "Hz", log: true }),
    P("xHigh", "Mid / high", 1000, 10000, 2500, { unit: "Hz", log: true }),
    ...band("low", "Low", -24),
    ...band("mid", "Mid", -24),
    ...band("high", "High", -28),
    P("attack", "Attack", 0.001, 0.2, 0.015, { unit: "s", prec: 3, log: true }),
    P("release", "Release", 0.02, 1, 0.15, { unit: "s", prec: 3, log: true }),
  ],

  create(ctx, offline) {
    const bq = (type, q = BUTTERWORTH) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.Q.value = q;
      return f;
    };
    const input = ctx.createGain();
    const out = ctx.createGain();

    // low:  LP(f1)·LP(f1) → AP(f2)
    // rest: HP(f1)·HP(f1) → mid: LP(f2)·LP(f2)   high: HP(f2)·HP(f2)
    const lowLp = [bq("lowpass"), bq("lowpass")];
    const lowAp = bq("allpass", Math.SQRT1_2); // all-pass Q is linear
    const restHp = [bq("highpass"), bq("highpass")];
    const midLp = [bq("lowpass"), bq("lowpass")];
    const highHp = [bq("highpass"), bq("highpass")];
    const comps = [0, 1, 2].map(() => {
      const c = ctx.createDynamicsCompressor();
      c.knee.value = 0; // keeps the built-in makeup gain a closed form — see the header
      return c;
    });
    const gains = [0, 1, 2].map(() => ctx.createGain());

    input.connect(lowLp[0]).connect(lowLp[1]).connect(lowAp).connect(comps[0]);
    input.connect(restHp[0]).connect(restHp[1]);
    restHp[1].connect(midLp[0]).connect(midLp[1]).connect(comps[1]);
    restHp[1].connect(highHp[0]).connect(highHp[1]).connect(comps[2]);
    comps.forEach((c, i) => c.connect(gains[i]).connect(out));

    const f1 = [...lowLp, ...restHp];
    const f2 = [lowAp, ...midLp, ...highHp];
    const ids = ["low", "mid", "high"];
    return {
      input,
      output: out,
      update(p) {
        const set = (param, v) => setAudioParam(ctx, param, v, offline);
        // Keep the crossovers apart: bands that cross over each other stop summing flat.
        const lo = Math.min(p.xLow, p.xHigh / 1.5);
        for (const f of f1) set(f.frequency, lo);
        for (const f of f2) set(f.frequency, p.xHigh);
        ids.forEach((id, i) => {
          const thr = p[`${id}Thresh`];
          const ratio = p[`${id}Ratio`];
          set(comps[i].threshold, thr);
          set(comps[i].ratio, ratio);
          set(comps[i].attack, p.attack);
          set(comps[i].release, p.release);
          set(gains[i].gain, dbToGain(p[`${id}Gain`] - nativeMakeupDb(thr, ratio)));
        });
      },
      /** Gain reduction of whichever band is working hardest, in dB (≤ 0). */
      readout: () => Math.min(comps[0].reduction, comps[1].reduction, comps[2].reduction),
      /** Per-band reduction, for a custom view. */
      reductions: () => comps.map((c) => c.reduction),
    };
  },
};
