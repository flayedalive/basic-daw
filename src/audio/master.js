// Mastering a bounce to a loudness target.
//
// Peak or LUFS *normalizing* is plain gain: it cannot make a mix louder than
// its highest peak allows. To reach a streaming target with a dynamic mix, the
// peaks have to be held down while the rest comes up — a limiter's job. This
// renders the mix once, then repeats: push it into the true-peak limiter,
// measure the result, adjust the push, until the loudness is on target.
//
// The limiter is the same processor as the "Limiter (true peak)" insert
// (plugins/worklets/limiter.js), run in an OfflineAudioContext, so the ceiling
// it guarantees is a true-peak one.

import { measureBuffer } from "./loudness.js";
import { sliceBuffer } from "./render.js";
import { prepareContext, workletNode } from "../plugins/worklets.js";

/** Targets worth having a button for. PLR floors follow from them: the gap between ceiling and target. */
export const MASTER_PRESETS = [
  { id: "streaming", label: "Streaming · -14 LUFS, -1 dBTP", target: -14, ceiling: -1 },
  { id: "loud", label: "Loud · -9 LUFS, -1 dBTP", target: -9, ceiling: -1 },
  { id: "podcast", label: "Podcast · -16 LUFS, -1 dBTP", target: -16, ceiling: -1 },
];

const LIMITER_SPAN = 11; // samples the limiter's peak detector adds to its look-ahead

/** `buffer` through the true-peak limiter: gain in, a ceiling out, its latency removed. */
export async function limitBuffer(buffer, { gainDb = 0, ceilingDb = -1, lookaheadMs = 3, releaseMs = 100 } = {}) {
  const sr = buffer.sampleRate;
  const look = Math.round((lookaheadMs / 1000) * sr);
  const late = look + LIMITER_SPAN;
  const ctx = new OfflineAudioContext(2, buffer.length + late, sr);
  await prepareContext(ctx);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const node = workletNode(ctx, "daw-limiter");
  const set = (name, v) => (node.parameters.get(name).value = v);
  set("gain", gainDb);
  set("ceiling", ceilingDb);
  set("lookahead", look);
  set("release", releaseMs / 1000);
  src.connect(node).connect(ctx.destination);
  src.start(0);
  return sliceBuffer(await ctx.startRendering(), late, buffer.length);
}

/**
 * Bring `mix` to `target` LUFS under a `ceiling` dBTP true peak.
 *
 * `plrFloor` is the dynamic range to keep: the peak-to-loudness ratio below
 * which it will not push further. Loudness gained from a limiter is paid for
 * in crushed peaks, and past some point the mix is simply flat; when the
 * target sits beyond that point it stops there and reports the `shortfall`.
 *
 * Returns { buffer, report, gainDb, passes, shortfall, limited, target }.
 */
export async function masterToTarget(mix, { target = -14, ceiling = -1, plrFloor = 6, tolerance = 0.2, maxPasses = 8, onPass } = {}) {
  const base = measureBuffer(mix);
  if (!Number.isFinite(base.integrated)) return { buffer: mix, report: base, gainDb: 0, passes: 0, shortfall: 0, limited: false, target };

  // Gain that is free: up to where the mix's own peak meets the ceiling.
  const free = ceiling - base.truePeakDb;
  let want = target;
  let shortfall = 0;
  if (target - base.integrated > free) {
    // Past that the limiter is working, the true peak sits at the ceiling, and
    // PLR is simply ceiling minus loudness — so the floor caps the loudness.
    const cap = Math.max(base.integrated + free, ceiling - plrFloor);
    if (target > cap) {
      want = cap;
      shortfall = target - cap;
    }
  }

  let gainDb = want - base.integrated;
  let prev = null;
  let buffer = mix;
  let report = base;
  let passes = 0;
  while (passes < maxPasses) {
    passes++;
    buffer = await limitBuffer(mix, { gainDb, ceilingDb: ceiling });
    report = measureBuffer(buffer);
    onPass?.(passes, report);
    const err = want - report.integrated;
    if (Math.abs(err) <= tolerance / 2) break; // aim for the middle of the tolerance, not its edge
    // A dB of push yields less than a dB of loudness once the limiter is
    // working. Estimate how much less from the last two passes.
    let slope = 1;
    if (prev && Math.abs(gainDb - prev.gainDb) > 1e-6) slope = (report.integrated - prev.loudness) / (gainDb - prev.gainDb);
    prev = { gainDb, loudness: report.integrated };
    gainDb += err / Math.min(1, Math.max(0.25, slope));
  }
  return { buffer, report, gainDb, passes, shortfall, limited: shortfall > 0.05, target };
}
