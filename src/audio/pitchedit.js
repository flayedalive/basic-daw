// Pitch editing, as the app sees it: analyse an asset, render a corrected copy,
// and point a clip at it.
//
// It works the way Reverse does, one step further. The corrected audio is
// rendered offline into a new pool asset and the clip is pointed at that; the
// clip remembers the asset it came from and the edit that made it:
//
//     clip.assetId              the rendered, corrected audio
//     clip.pitchEdit.source     the original asset — untouched, still in the pool
//     clip.pitchEdit.edit       key, scale, settings, per-note changes
//
// Playback and bounce both simply play the clip's asset, so what is bounced is
// what was heard, with no worklet and no latency involved. Editing again
// starts from the original and replaces the render. Revert points the clip
// back at the original, exactly as it was.

import { assets, state, historyUsesAsset } from "../state.js";
import { addAsset, removeAsset } from "../assets.js";
import { encodeWav } from "./wav.js";
import { trackPitchGen } from "./pitchtrack.js";
import { segmentNotes } from "./pitchnotes.js";
import { correctedCurve, newEdit } from "./pitchcorrect.js";
import { shiftPitchGen } from "./pitchshift.js";
import { runSliced } from "./slices.js";

/** The asset a clip's audio originally came from: itself, unless it has been pitch-edited. */
export const sourceAssetOf = (clip) => assets.get(clip.pitchEdit?.source ?? clip.assetId);

/** A clip's edit data, or a fresh one to start from. */
export const editOf = (clip) => structuredClone(clip.pitchEdit?.edit ?? newEdit());

function monoOf(buffer) {
  const n = buffer.length;
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const m = new Float32Array(n);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) m[i] += d[i];
  }
  for (let i = 0; i < n; i++) m[i] /= buffer.numberOfChannels;
  return m;
}

/**
 * The pitch track of an asset, analysed once and kept on the asset.
 * Resolves to the track (see audio/pitchtrack.js), or null if cancelled.
 */
export async function analyzeAsset(asset, run = {}) {
  if (asset.pitchTrack) return asset.pitchTrack;
  asset.pitchPending ??= runSliced(trackPitchGen(monoOf(asset.buffer), asset.buffer.sampleRate), run).then((track) => {
    asset.pitchPending = null;
    if (track) asset.pitchTrack = track;
    return track;
  });
  return asset.pitchPending;
}

/** Notes for an asset under an edit (its cuts and joins applied). Needs the track analysed. */
export const notesOf = (asset, edit) => segmentNotes(asset.pitchTrack, { cuts: edit.cuts, joins: edit.joins });

/** Does this edit change anything at all? (No note needs any correction.) */
export function isNoOp(asset, edit) {
  const { ratios } = correctedCurve(asset.pitchTrack, notesOf(asset, edit), edit);
  return ratios.every((r) => r === 1);
}

/** Render `source` corrected by `edit` into a new AudioBuffer. */
export async function renderCorrected(source, edit, run = {}) {
  const track = await analyzeAsset(source);
  if (!track) return null;
  const { ratios } = correctedCurve(track, notesOf(source, edit), edit);
  const buffer = source.buffer;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const out = await runSliced(shiftPitchGen(channels, buffer.sampleRate, track, ratios), run);
  if (!out) return null;
  const rendered = new AudioBuffer({ numberOfChannels: out.length, length: out[0].length, sampleRate: buffer.sampleRate });
  out.forEach((d, c) => rendered.copyToChannel(d, c));
  return rendered;
}

/**
 * Apply `edit` to `clip`: render, store the result in the pool, point the clip
 * (and any others cut from it that share the same edit) at it.
 * `run.commit()` is called once the render exists and just before anything is
 * changed — the place to push the undo step, so a cancelled or failed render
 * leaves no step behind. The caller announces the change.
 */
export async function applyPitchEdit(clip, edit, run = {}) {
  const source = sourceAssetOf(clip);
  if (!source?.buffer) throw new Error("the clip's original audio is not in the pool");
  const rendered = await renderCorrected(source, edit, run);
  if (!rendered) return null;
  const asset = await addAsset({ name: `${source.name.replace(/ \(tuned\)$/, "")} (tuned)`, buffer: rendered, blob: encodeWav(rendered, 24) });
  run.commit?.();
  const previous = clip.pitchEdit ? clip.assetId : null;
  // Pieces split from the same clip play the same audio; keep them together.
  const siblings = state.project.clips.filter((c) => c === clip || (previous && c.assetId === previous && c.pitchEdit?.source === source.id));
  for (const c of siblings) {
    c.assetId = asset.id;
    c.pitchEdit = { source: source.id, edit: structuredClone(edit) };
  }
  if (previous) await dropIfUnused(previous);
  return asset;
}

/** Point `clip` (and its siblings) back at the original audio. Lossless: the original was never changed. */
export async function revertPitchEdit(clip) {
  if (!clip.pitchEdit) return;
  const rendered = clip.assetId;
  const source = clip.pitchEdit.source;
  for (const c of state.project.clips) {
    if (c.assetId !== rendered || c.pitchEdit?.source !== source) continue;
    c.assetId = source;
    delete c.pitchEdit;
  }
  await dropIfUnused(rendered);
}

/** Remove a rendered asset nothing refers to any more — unless an undo step might want it back. */
async function dropIfUnused(id) {
  const used = state.project.clips.some((c) => c.assetId === id);
  if (!used && !historyUsesAsset(id)) await removeAsset(id);
}

/** Asset ids clips depend on without playing them: the originals of pitch-edited clips. */
export function pitchSourceIds(project) {
  const ids = new Set();
  for (const c of project.clips ?? []) if (c.pitchEdit?.source) ids.add(c.pitchEdit.source);
  return ids;
}
