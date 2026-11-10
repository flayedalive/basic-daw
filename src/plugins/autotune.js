// Auto-Tune: real-time pitch correction as an insert.
//
// The processor (./worklets/autotune.js) is the pitch editor's detector and
// shifter made causal. This file is its face: key and scale become the twelve-
// bit mask of allowed notes the processor is told, and the fixed delay it
// needs is reported so the host can compensate.
//
// For anything that can be done after the take, the pitch editor ("Edit
// pitch…" on a clip) does it better: it sees whole notes before deciding, and
// every decision can be changed. This is for hearing it now.

import { workletFx } from "./dynamics.js";
import { KEYS, SCALES } from "../audio/pitchcorrect.js";

/** The processor's delay in seconds (its LATENCY), and in whole samples at a rate. */
export const AUTOTUNE_LATENCY = 0.032;
const latencySamples = (sampleRate) => Math.round(AUTOTUNE_LATENCY * sampleRate);

/** Key + scale as twelve bits, bit n set when pitch class n (C = 0) may be sung. */
export function scaleMask(key, scale) {
  const root = Math.max(0, KEYS.indexOf(key));
  let mask = 0;
  for (const step of SCALES[scale] ?? SCALES.chromatic) mask |= 1 << ((root + step) % 12);
  return mask;
}

export const autoTunePlugin = {
  id: "core.autotune",
  name: "Auto-Tune",
  category: "Pitch",
  description:
    "Pulls a single voice or instrument onto the notes of a key as it plays. Formants are kept. Speed 0 is the hard, robotic snap; 30–100 ms sounds natural. Adds 32 ms of delay, which is compensated on playback but heard when monitoring live. For one note at a time, down to about 80 Hz; for careful work use Edit pitch… on the clip instead.",
  worklets: [{ name: "daw-autotune", url: new URL("./worklets/autotune.js", import.meta.url).href }],
  latency: (p, sampleRate) => latencySamples(sampleRate) / sampleRate,
  params: [
    { key: "key", label: "Key", choices: KEYS, def: "C" },
    { key: "scale", label: "Scale", choices: Object.keys(SCALES), def: "chromatic" },
    { key: "amount", label: "Amount", min: 0, max: 1, def: 1, hint: "How much of the distance to the note is corrected." },
    { key: "speed", label: "Speed", min: 0, max: 400, def: 30, unit: "ms", prec: 0, hint: "Time for the correction to take hold. 0 snaps instantly and flattens vibrato." },
    { key: "variance", label: "Variance", min: 0, max: 50, def: 0, unit: "ct", prec: 0, hint: "Cents either side of the note that count as in tune and are left alone." },
  ],
  create(ctx, offline) {
    return workletFx(ctx, offline, "daw-autotune", (p) => ({
      scale: scaleMask(p.key, p.scale),
      amount: p.amount,
      speed: p.speed,
      variance: p.variance,
    }));
  },
};
