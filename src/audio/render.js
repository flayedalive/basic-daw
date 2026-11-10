// Offline bounce. The graph here is assembled with the same `buildChain` used
// for live playback and the same clip envelope maths, so a bounce is the live
// mix rendered faster than real time rather than a second implementation.

import { dbToGain, clamp } from "../util.js";
import { assets, state, trackAudible } from "../state.js";
import { buildChain, chainLatency } from "./effects.js";
import { prepareContext } from "../plugins/worklets.js";
import { scheduleClipEnvelope } from "./engine.js";
import { encodeWav } from "./wav.js";
import { measureBuffer, gainToTarget } from "./loudness.js";
import { playbackOf, prepareStretches } from "./clipaudio.js";

/**
 * Seconds of silence rendered ahead of the range and then thrown away.
 *
 * Live, an insert chain has existed for a while before you press play. A
 * bounce builds it and plays into it in the same instant, and some nodes are
 * not ready that fast: a DynamicsCompressorNode starts with its detector at
 * zero and ducks the first few hundred milliseconds by up to 14 dB while it
 * recovers at its release rate. Rendering this much silence first puts every
 * insert in the state playback finds it in. Two seconds covers the longest
 * release any built-in offers.
 */
export const PRE_ROLL = 2;

/**
 * Render [start, end) of the project.
 * opts: { sampleRate, trackIds, applyMaster, respectMutes, tailSec, onProgress }
 */
export async function renderRange(start, end, opts = {}) {
  const project = state.project;
  const sampleRate = opts.sampleRate ?? 48000;
  const tail = opts.tailSec ?? 2;
  const duration = Math.max(0.05, end - start + tail);
  const frames = Math.ceil(duration * sampleRate);
  const applyMaster = opts.applyMaster !== false;
  const tracks = project.tracks.filter((t) => !opts.trackIds || opts.trackIds.includes(t.id));

  // Plugin delay compensation, as the engine does it: each track is held back
  // to match the slowest one, and what that and the master chain add to
  // everything is rendered as extra length and cut from the head.
  const slowest = tracks.reduce((m, t) => Math.max(m, chainLatency(t.fx, sampleRate)), 0);
  const late = Math.round((slowest + (applyMaster ? chainLatency(project.master.fx, sampleRate) : 0)) * sampleRate);
  const lead = Math.round(PRE_ROLL * sampleRate);
  const ctx = new OfflineAudioContext(2, lead + late + frames, sampleRate);
  // Worklet plugins need their processor modules in this context before a
  // chain can be built; `create` itself stays synchronous.
  await prepareContext(ctx);

  const masterIn = ctx.createGain();
  const masterGain = ctx.createGain();
  masterGain.gain.value = opts.applyMaster === false ? 1 : dbToGain(project.master.volumeDb);
  buildChain(ctx, opts.applyMaster === false ? [] : project.master.fx, masterIn, masterGain, true);
  masterGain.connect(ctx.destination);

  const wanted = opts.trackIds ? new Set(opts.trackIds) : null;
  const inputs = new Map();
  for (const track of project.tracks) {
    if (wanted && !wanted.has(track.id)) continue;
    if (opts.respectMutes !== false && !wanted && !trackAudible(track)) continue;
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const pan = ctx.createStereoPanner();
    gain.gain.value = dbToGain(track.volumeDb);
    pan.pan.value = clamp(track.pan, -1, 1);
    buildChain(ctx, track.fx, input, gain, true);
    const hold = slowest - chainLatency(track.fx, sampleRate);
    if (hold > 1e-7) {
      const comp = ctx.createDelay(Math.max(1, hold + 0.01));
      comp.delayTime.value = hold;
      gain.connect(pan).connect(comp).connect(masterIn);
    } else {
      gain.connect(pan).connect(masterIn);
    }
    inputs.set(track.id, input);
  }

  // Pitch-locked clips play a stretched copy; playback may have been getting by
  // on a resampled stand-in while it rendered, but a bounce waits for the real thing.
  await prepareStretches(project.clips);

  for (const clip of project.clips) {
    if (clip.mute) continue;
    const input = inputs.get(clip.trackId);
    if (!input) continue;
    const asset = assets.get(clip.assetId);
    if (!asset?.buffer) continue;

    const clipEnd = clip.start + clip.duration;
    if (clipEnd <= start || clip.start >= end) continue;

    const from = Math.max(clip.start, start);
    const until = Math.min(clipEnd, end);
    const when = lead / sampleRate + (from - start);

    // The same buffer and numbers the engine plays the clip with.
    const pb = playbackOf(clip, asset);
    const src = ctx.createBufferSource();
    src.buffer = pb.buffer;
    src.playbackRate.value = pb.playbackRate;
    if (pb.detune) src.detune.value = pb.detune;

    const g = ctx.createGain();
    scheduleClipEnvelope(g.gain, clip, from, until, when);
    src.connect(g).connect(input);

    const srcOffset = clamp(pb.offset + (from - clip.start) * pb.consume, 0, src.buffer.duration);
    const playSecs = until - from;
    src.start(when, srcOffset, Math.min(playSecs * pb.consume, src.buffer.duration - srcOffset));
  }

  if (opts.onProgress) trackProgress(ctx, PRE_ROLL + late / sampleRate + duration, opts.onProgress);
  const rendered = await ctx.startRendering();
  return sliceBuffer(rendered, lead + late, frames);
}

/** `count` frames of `buffer` from `from`, as a new buffer. */
export function sliceBuffer(buffer, from, count) {
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: Math.max(1, count), sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(from, from + count), c);
  return out;
}

/** OfflineAudioContext has no progress event; suspend at intervals to fake one. */
function trackProgress(ctx, duration, onProgress) {
  const steps = 20;
  for (let i = 1; i < steps; i++) {
    const at = (duration * i) / steps;
    ctx.suspend(at).then(() => {
      onProgress(i / steps);
      ctx.resume();
    });
  }
}


/** Multiply every sample of `buffer` by `gainDb`, in place. */
export function applyGainDb(buffer, gainDb) {
  if (!gainDb) return;
  const g = dbToGain(gainDb);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}

/**
 * The last step of a bounce: normalize as asked, then measure what is about to
 * be written. mode: "off" | "peak" (to -0.3 dBFS) | "lufs" (to `target` LUFS,
 * held back so the true peak stays under `ceiling` dBTP).
 * Returns { report, gainDb, limited, shortfall }; `report` is of the result.
 */
export function finishBounce(buffer, { mode = "off", target = -14, ceiling = -1 } = {}) {
  let gainDb = 0;
  let limited = false;
  let shortfall = 0;
  if (mode === "peak") {
    gainDb = 20 * Math.log10(normalizeBuffer(buffer, -0.3));
  } else if (mode === "lufs") {
    ({ gainDb, limited, shortfall } = gainToTarget(measureBuffer(buffer), target, ceiling));
    applyGainDb(buffer, gainDb);
  }
  return { report: measureBuffer(buffer), gainDb, limited, shortfall };
}

/** Peak-normalize in place to `targetDb`, returning the gain that was applied. */
export function normalizeBuffer(buffer, targetDb = -0.3) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  if (peak <= 0) return 1;
  const g = dbToGain(targetDb) / peak;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
  return g;
}

export function bufferToWavBlob(buffer, bits = 24) {
  return encodeWav(buffer, bits);
}

/** True peak (well, sample peak) and RMS of a rendered buffer, in dB. */
export function analyzeBuffer(buffer) {
  let peak = 0;
  let sumSq = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sumSq += d[i] * d[i];
      n++;
    }
  }
  const rms = Math.sqrt(sumSq / Math.max(1, n));
  return {
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    rmsDb: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
  };
}
