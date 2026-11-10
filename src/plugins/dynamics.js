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
  latency: (p) => (p.lookahead ?? 0) / 1000,
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
      lookahead: p.lookahead / 1000,
      range: p.range <= -79.9 ? -100 : p.range,
    }));
  },
};
