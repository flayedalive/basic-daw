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

export const COMPRESSOR_WORKLET = { name: "daw-compressor", url: moduleUrl("compressor.js") };

export const busCompPlugin = {
  id: "core.buscomp",
  name: "Bus Compressor",
  category: "Dynamics",
  description:
    "Glue for a bus or the master: soft knee, a sidechain high-pass so the bass does not pump the mix, an auto-release that holds dense passages steady, and a mix knob for parallel compression. Adds no delay.",
  worklets: [COMPRESSOR_WORKLET],
  params: [
    P("threshold", "Thresh", -40, 0, -18, { unit: "dB", prec: 1 }),
    P("ratio", "Ratio", 1, 20, 4, { unit: ":1", prec: 1, log: true }),
    P("knee", "Knee", 0, 24, 6, { unit: "dB", prec: 1 }),
    P("attack", "Attack", 0.1, 100, 10, { unit: "ms", prec: 1, log: true }),
    P("release", "Release", 20, 2000, 200, { unit: "ms", prec: 0, log: true }),
    { key: "auto", label: "Auto release", bool: true, def: false, hint: "Release slows down while compression is sustained, so dense passages do not pump." },
    { key: "detector", label: "Detector", choices: ["rms", "peak"], def: "rms" },
    P("scHpf", "SC high-pass", 20, 500, 80, { unit: "Hz", log: true, hint: "Filters the lows out of what the compressor listens to (not out of the sound). 20 Hz is off." }),
    P("makeup", "Makeup", 0, 24, 0, { unit: "dB", prec: 1 }),
    P("mix", "Mix", 0, 1, 1, { hint: "Blend the compressed signal with the untouched one: parallel compression." }),
  ],
  create(ctx, offline) {
    return workletFx(ctx, offline, "daw-compressor", (p) => ({
      threshold: p.threshold,
      ratio: p.ratio,
      knee: p.knee,
      attack: p.attack / 1000,
      release: p.release / 1000,
      auto: p.auto ? 1 : 0,
      rms: p.detector === "peak" ? 0 : 1,
      scHpf: p.scHpf,
      makeup: p.makeup,
      mix: p.mix,
    }));
  },
};

export const deEsserPlugin = {
  id: "core.deesser",
  name: "De-esser / Dynamic EQ",
  category: "Dynamics",
  description:
    "Cuts one band only while it is too loud. Aim it at 5–8 kHz to tame sibilance, or lower to catch a boomy note. Listen plays the band on its own so you can find the frequency.",
  worklets: [{ name: "daw-dyneq", url: moduleUrl("dyneq.js") }],
  params: [
    P("frequency", "Frequency", 200, 16000, 6500, { unit: "Hz", log: true }),
    P("q", "Width", 0.5, 8, 2, { prec: 1, hint: "Q of the band. Higher is narrower." }),
    P("threshold", "Thresh", -60, 0, -30, { unit: "dB", prec: 1, hint: "Level of the band itself above which it is cut." }),
    P("range", "Range", 0, 24, 10, { unit: "dB", prec: 1, hint: "The most it will cut." }),
    P("attack", "Attack", 0.1, 20, 1, { unit: "ms", prec: 1, log: true }),
    P("release", "Release", 10, 500, 80, { unit: "ms", prec: 0, log: true }),
    { key: "listen", label: "Listen", bool: true, def: false },
  ],
  create(ctx, offline) {
    return workletFx(ctx, offline, "daw-dyneq", (p) => ({
      frequency: p.frequency,
      q: p.q,
      threshold: p.threshold,
      range: p.range,
      attack: p.attack / 1000,
      release: p.release / 1000,
      listen: p.listen ? 1 : 0,
    }));
  },
};
