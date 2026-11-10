// Insert chains.
//
// The effects themselves now live in src/plugins/ — this module is just the
// part the audio graph cares about: wiring a list of effect definitions
// between two nodes, and tearing it down again.
//
// The same `buildChain` runs inside an OfflineAudioContext during bounce, so
// what you hear is what you render. That is the one rule a plugin must not
// break: no state that exists only in the live context, no module loading at
// build time. (A plugin's AudioWorklet modules are loaded by the host, ahead
// of time — see plugins/worklets.js.)

import { createEffect } from "../plugins/registry.js";

export { createEffect, newEffect, defaultParams, signatureOf, labelOf, paramsOf, getPlugin, missingPlugins, missingInProject, latencyOf, chainLatency } from "../plugins/registry.js";
export { makeImpulse } from "../plugins/dsp.js";

/**
 * Wire `defs` between `input` and `output`, returning live effect handles.
 * Bypassed effects are simply left out of the path (not merely muted), which
 * keeps their CPU cost at zero and their latency out of the sum.
 */
export function buildChain(ctx, defs, input, output, offline = false) {
  const live = [];
  let node = input;
  for (const def of defs ?? []) {
    if (def.on === false) continue;
    const fx = createEffect(ctx, def, offline);
    if (!fx) continue;
    node.connect(fx.input);
    node = fx.output;
    live.push(fx);
  }
  node.connect(output);
  if (!offline && live.length) prime(ctx, input);
  return live;
}

/**
 * Wake a freshly built live chain.
 *
 * The browser does not run a node whose input is silent, so a compressor built
 * while nothing is playing sits untouched until the first note reaches it —
 * and a DynamicsCompressorNode's very first act is to duck by up to 14 dB
 * while its detector comes up, recovering at its release rate. Heard live,
 * that is the first note after adding, bypassing or reordering an insert
 * coming in quiet. Two seconds of a signal 400 dB down (not silence, as far as
 * the graph is concerned) gets that over with before anything plays, and is
 * the live counterpart of the bounce's pre-roll in render.js.
 */
function prime(ctx, input) {
  const src = ctx.createConstantSource();
  src.offset.value = 1e-20;
  src.connect(input);
  src.onended = () => src.disconnect();
  src.start();
  src.stop(ctx.currentTime + 2);
}

export function disposeChain(live) {
  for (const fx of live ?? []) {
    try {
      fx.dispose?.();
      fx.input.disconnect();
      fx.output.disconnect();
    } catch {
      /* already torn down */
    }
  }
}
