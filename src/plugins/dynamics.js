// Dynamics that run in an AudioWorklet.
//
// Anything that has to follow the signal's level sample by sample lives here:
// native nodes cannot read the signal, and doing it from `tick()` on the UI
// clock means a bounce — which never calls tick — comes out unprocessed. The
// processors are in ./worklets/, one self-contained module each; this file is
// their plugin faces. See docs/plugins.md, "Worklet plugins".

import { setAudioParam } from "./dsp.js";
import { workletNode } from "./worklets.js";

const P = (key, label, min, max, def, extra = {}) => ({ key, label, min, max, def, ...extra });
const moduleUrl = (file) => new URL(`./worklets/${file}`, import.meta.url).href;

/**
 * Milliseconds of look-ahead as a whole number of samples. The processor is
 * told the samples, and the plugin's reported latency is computed from the
 * same number — so the two cannot disagree by a rounding.
 */
const lookSamples = (ms, sampleRate) => Math.round(((ms ?? 0) / 1000) * sampleRate);

/** A handle whose `update` writes plugin parameters to a worklet's AudioParams through `map`. */
function workletFx(ctx, offline, name, map) {
  const node = workletNode(ctx, name);
  let meter = 0;
  node.port.onmessage = (e) => (meter = e.data);
  return {
    input: node,
    output: node,
    node,
    update(p) {
      for (const [param, value] of Object.entries(map(p))) setAudioParam(ctx, node.parameters.get(param), value, offline);
    },
    /** The processor's latest meter message (port traffic is metering only). */
    readout: () => meter,
    dispose() {
      node.port.onmessage = null;
    },
  };
}

export const gatePlugin = {
  id: "core.gate",
  name: "Noise Gate",
  category: "Dynamics",
  description:
    "Closes when the level falls below the threshold. Stereo-linked, with hold and an optional look-ahead that opens the gate just before the attack arrives (its delay is compensated).",
  worklets: [{ name: "daw-gate", url: moduleUrl("gate.js") }],
  latency: (p, sampleRate) => lookSamples(p.lookahead, sampleRate) / sampleRate,
  params: [
    P("threshold", "Thresh", -80, 0, -45, { unit: "dB" }),
    P("attack", "Attack", 0, 0.1, 0.002, { unit: "s", prec: 3 }),
    P("hold", "Hold", 0, 0.5, 0.05, { unit: "s", prec: 3, hint: "How long the gate stays open after the level drops, so it does not chop the tail of a note." }),
    P("release", "Release", 0.01, 1, 0.12, { unit: "s", prec: 3 }),
    P("lookahead", "Look-ahead", 0, 10, 0, { unit: "ms", prec: 1, hint: "Opens the gate this far ahead of the sound that triggers it, so fast attacks are not clipped." }),
    P("range", "Range", -80, 0, -80, { unit: "dB", hint: "How far a closed gate turns the signal down. -80 is fully closed." }),
  ],
  create(ctx, offline) {
    return workletFx(ctx, offline, "daw-gate", (p) => ({
      threshold: p.threshold,
      attack: p.attack,
      hold: p.hold,
      release: p.release,
      lookahead: lookSamples(p.lookahead, ctx.sampleRate),
      range: p.range <= -79.9 ? -100 : p.range,
    }));
  },
};

/** Samples of delay the interpolating peak detector adds on top of the look-ahead (limiter.js: TAPS - 1). */
const LIMITER_SPAN = 11;

export const limiterPlugin = {
  id: "core.maximizer",
  name: "Limiter (true peak)",
  category: "Dynamics",
  description:
    "Look-ahead brickwall limiter for the master. Holds a true-peak ceiling — inter-sample peaks included — by easing the gain down before each peak arrives. Push Gain into it to raise loudness. Its look-ahead is compensated.",
  worklets: [{ name: "daw-limiter", url: moduleUrl("limiter.js") }],
  latency: (p, sampleRate) => (lookSamples(p.lookahead, sampleRate) + LIMITER_SPAN) / sampleRate,
  params: [
    P("gain", "Gain", 0, 24, 0, { unit: "dB", prec: 1 }),
    P("ceiling", "Ceiling", -12, 0, -1, { unit: "dBTP", prec: 1, hint: "The highest level the output may reach, measured between samples as well as on them. -1 is the usual choice for streaming." }),
    P("lookahead", "Look-ahead", 1, 5, 3, { unit: "ms", prec: 1, hint: "How far ahead it sees, and so how gently it can turn down. Longer is smoother on bass; shorter keeps transients sharper." }),
    P("release", "Release", 10, 1000, 100, { unit: "ms", log: true, prec: 0, hint: "How fast the gain returns after a peak. Sustained limiting is released more slowly than this on its own." }),
  ],
  create(ctx, offline) {
    return workletFx(ctx, offline, "daw-limiter", (p) => ({
      gain: p.gain,
      ceiling: p.ceiling,
      lookahead: lookSamples(p.lookahead, ctx.sampleRate),
      release: p.release / 1000,
    }));
  },
};
