// What a clip actually plays.
//
// Usually that is its pool asset, run at the clip's rate. A clip with pitch
// lock on plays a time-stretched (and perhaps pitch-shifted) copy instead —
// rendered once, offline, by audio/stretch.js and cached here. Both the engine
// and the bounce ask `playbackOf` for the buffer and the numbers to schedule it
// with, so they cannot disagree: the bounce is the same samples you heard.
//
// A stretch takes a while (a few seconds per minute of audio in the phase
// vocoder), so it is rendered in the background. Until it is ready the engine
// plays the plain resampled clip — right length, wrong pitch — which is also
// what you hear while dragging a clip's edge to stretch it. The bounce waits.
//
// Stretched copies are not saved with the project: the algorithm is
// deterministic, so they are simply rendered again after a reload.

import { assets, bus, state, clipSourceRate } from "../state.js";
import { stretchAsync, MIN_RATIO, MAX_RATIO } from "./stretch.js";
import { clamp } from "../util.js";

/** True when the clip needs a stretched copy rather than plain resampling. */
export const isStretched = (clip) => !!clip.pitchLock && (Math.abs(clip.rate - 1) > 1e-6 || !!clip.detune);

const keyOf = (clip) => `${clip.rate.toFixed(6)}|${clip.detune || 0}|${clip.stretchMode ?? "auto"}`;

/** A reversed copy of `buffer`, cached on `holder` (reversing a long stem isn't free). */
export function reversedOf(holder, buffer) {
  if (holder.reversed?.length === buffer.length) return holder.reversed;
  const out = new AudioBuffer({ numberOfChannels: buffer.numberOfChannels, length: buffer.length, sampleRate: buffer.sampleRate });
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const from = buffer.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i];
  }
  holder.reversed = out;
  return out;
}

/**
 * How to play `clip`: { buffer, playbackRate, detune, consume, offset, exact }.
 * `consume` is buffer seconds used per timeline second, `offset` where in the
 * buffer the clip begins, and `exact` is false while a stretch is still
 * rendering and the resampled stand-in is playing.
 */
export function playbackOf(clip, asset) {
  if (isStretched(clip)) {
    const entry = asset.stretch?.get(keyOf(clip));
    if (entry?.buffer) {
      return {
        buffer: clip.reverse ? reversedOf(entry, entry.buffer) : entry.buffer,
        playbackRate: 1,
        detune: 0,
        consume: 1,
        offset: clip.offset / clip.rate,
        exact: true,
      };
    }
    return { buffer: clip.reverse ? reversedOf(asset, asset.buffer) : asset.buffer, playbackRate: clip.rate, detune: 0, consume: clip.rate, offset: clip.offset, exact: false };
  }
  return {
    buffer: clip.reverse ? reversedOf(asset, asset.buffer) : asset.buffer,
    playbackRate: clip.rate,
    detune: clip.detune || 0,
    consume: clipSourceRate(clip),
    offset: clip.offset,
    exact: true,
  };
}

/** 0 → 1 while a clip's stretch renders, 1 when it is ready, null when it needs none. */
export function stretchProgress(clip) {
  if (!isStretched(clip)) return null;
  const entry = assets.get(clip.assetId)?.stretch?.get(keyOf(clip));
  return entry ? (entry.buffer ? 1 : entry.progress) : 0;
}

/** Render (or fetch) the stretched copy a clip needs. Resolves to the AudioBuffer, or null. */
export function requestStretch(clip, asset = assets.get(clip.assetId)) {
  if (!asset?.buffer || !isStretched(clip)) return Promise.resolve(null);
  asset.stretch ??= new Map();
  const key = keyOf(clip);
  const existing = asset.stretch.get(key);
  if (existing) return existing.promise;

  const src = asset.buffer;
  const channels = [];
  for (let c = 0; c < src.numberOfChannels; c++) channels.push(src.getChannelData(c));
  const entry = { buffer: null, progress: 0, cancelled: false, promise: null };
  const opts = { ratio: clamp(1 / clip.rate, MIN_RATIO, MAX_RATIO), semitones: (clip.detune || 0) / 100, mode: clip.stretchMode ?? "auto" };
  entry.promise = stretchAsync(channels, src.sampleRate, opts, {
    onProgress: (p) => {
      entry.progress = p;
      bus.emit("stretch-progress");
    },
    isCancelled: () => entry.cancelled,
  }).then(
    (out) => {
      if (!out) {
        if (asset.stretch.get(key) === entry) asset.stretch.delete(key);
        return null;
      }
      const buffer = new AudioBuffer({ numberOfChannels: out.length, length: out[0].length, sampleRate: src.sampleRate });
      out.forEach((d, c) => buffer.copyToChannel(d, c));
      entry.buffer = buffer;
      prune();
      bus.emit("stretch"); // the engine reschedules; the timeline redraws
      return buffer;
    },
    (err) => {
      console.error("stretch failed", err);
      asset.stretch.delete(key);
      return null;
    },
  );
  asset.stretch.set(key, entry);
  return entry.promise;
}

/** Everything the given clips need, rendered. The bounce awaits this before it schedules anything. */
export async function prepareStretches(clips = state.project.clips) {
  await Promise.all(clips.filter(isStretched).map((c) => requestStretch(c)));
}

/**
 * Bring the cache in line with the project: start what is missing, abandon
 * renders nobody wants any more (the ratio moved on mid-drag), and drop copies
 * no clip uses. Debounced by the caller.
 */
export function syncStretches() {
  for (const clip of state.project.clips) if (isStretched(clip)) requestStretch(clip);
  prune();
}

function prune() {
  const wanted = new Map(); // assetId -> Set(key)
  for (const clip of state.project.clips) {
    if (!isStretched(clip)) continue;
    if (!wanted.has(clip.assetId)) wanted.set(clip.assetId, new Set());
    wanted.get(clip.assetId).add(keyOf(clip));
  }
  for (const asset of assets.values()) {
    if (!asset.stretch) continue;
    const keep = wanted.get(asset.id);
    for (const [key, entry] of asset.stretch) {
      if (keep?.has(key)) continue;
      entry.cancelled = true;
      if (entry.buffer) asset.stretch.delete(key);
    }
  }
}
