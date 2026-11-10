// The project document, the asset pool, selection, and undo history.
//
// Everything the app can persist lives on `project`; everything derived from
// decoded audio (AudioBuffer, peak caches) lives on `assets` and is rebuilt on
// load from the blobs kept in IndexedDB. Mutations follow one rule:
// call `pushUndo(label)` *before* touching the document, then `changed(...)`.

import { emitter, uid, TRACK_COLORS } from "./util.js";

export const bus = emitter();

export const PROJECT_VERSION = 1;

export function newTrack(name, index = 0) {
  return {
    id: uid("trk"),
    name: name ?? `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    volumeDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    inputDevice: "", // "" = the main input from Audio setup; else a device id
    inputDeviceName: "", // that device's name, for when it isn't plugged in
    input: "1", // which of its inputs this track records from: "1", "2", "1+2"…
    monitor: false, // hear the input through this track while armed
    height: 74,
    fx: [],
  };
}

export function newProject(name = "Untitled") {
  const tracks = [newTrack(undefined, 0), newTrack(undefined, 1)];
  return {
    version: PROJECT_VERSION,
    id: uid("prj"),
    name,
    bpm: 120,
    sigNum: 4,
    sigDen: 4,
    snap: "beat",
    loop: { enabled: false, start: 0, end: 8 },
    tracks,
    clips: [],
    markers: [],
    master: { volumeDb: 0, fx: [] },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

/** Runtime-only asset records, keyed by id. Never serialized directly. */
export const assets = new Map();

export const state = {
  project: newProject(),
  /** clip ids */
  selection: new Set(),
  selectedTrackId: null,
  selectedAssetId: null,
  /** mixer strip focus: track id or "master" */
  focusedStrip: "master",
  /** seconds; where playback starts and the playhead parks when stopped */
  playhead: 0,
  view: { scrollX: 0, scrollY: 0, pxPerSec: 60 },
  dirty: false,
};

/* ── history ────────────────────────────────────────────────────────────── */
const undoStack = [];
const redoStack = [];
const HISTORY_LIMIT = 200;

const snapshot = () => JSON.parse(JSON.stringify(state.project));

export function pushUndo(label = "edit") {
  undoStack.push({ label, doc: snapshot() });
  if (undoStack.length > HISTORY_LIMIT) undoStack.shift();
  redoStack.length = 0;
  state.dirty = true;
  bus.emit("history");
}

export function undo() {
  const entry = undoStack.pop();
  if (!entry) return false;
  redoStack.push({ label: entry.label, doc: snapshot() });
  state.project = entry.doc;
  pruneSelection();
  state.dirty = true;
  bus.emit("project");
  bus.emit("history");
  return entry.label;
}

export function redo() {
  const entry = redoStack.pop();
  if (!entry) return false;
  undoStack.push({ label: entry.label, doc: snapshot() });
  state.project = entry.doc;
  pruneSelection();
  state.dirty = true;
  bus.emit("project");
  bus.emit("history");
  return entry.label;
}

/** True if any undo or redo step has a clip that plays, or was rendered from, this asset. */
export function historyUsesAsset(id) {
  const uses = (entry) => entry.doc.clips?.some((c) => c.assetId === id || c.pitchEdit?.source === id);
  return undoStack.some(uses) || redoStack.some(uses);
}

export const historyInfo = () => ({
  canUndo: undoStack.length > 0,
  canRedo: redoStack.length > 0,
  undoLabel: undoStack.at(-1)?.label,
  redoLabel: redoStack.at(-1)?.label,
});

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  bus.emit("history");
}

/** Emit a change. `what` is a hint for panels: project | tracks | clips | mix | view | selection */
export function changed(what = "project", markDirty = true) {
  if (markDirty) {
    state.dirty = true;
    state.project.updatedAt = Date.now();
  }
  bus.emit(what);
  if (what !== "project") bus.emit("any");
}

function pruneSelection() {
  const live = new Set(state.project.clips.map((c) => c.id));
  for (const id of [...state.selection]) if (!live.has(id)) state.selection.delete(id);
}

/* ── document queries ───────────────────────────────────────────────────── */
export const trackById = (id) => state.project.tracks.find((t) => t.id === id);
export const clipById = (id) => state.project.clips.find((c) => c.id === id);
export const clipsOfTrack = (id) => state.project.clips.filter((c) => c.trackId === id);
export const selectedClips = () => state.project.clips.filter((c) => state.selection.has(c.id));
export const trackIndex = (id) => state.project.tracks.findIndex((t) => t.id === id);

export function projectDuration() {
  let end = 0;
  for (const c of state.project.clips) end = Math.max(end, c.start + c.duration);
  for (const m of state.project.markers) end = Math.max(end, m.time);
  return end;
}

export function anySolo() {
  return state.project.tracks.some((t) => t.solo);
}

export function trackAudible(track) {
  if (track.mute) return false;
  return anySolo() ? track.solo : true;
}

/* ── clip factory ───────────────────────────────────────────────────────── */
export function newClip(assetId, trackId, start, opts = {}) {
  const asset = assets.get(assetId);
  return {
    id: uid("clip"),
    assetId,
    trackId,
    name: opts.name ?? asset?.name ?? "clip",
    start,
    offset: opts.offset ?? 0,
    duration: opts.duration ?? asset?.duration ?? 1,
    gainDb: opts.gainDb ?? 0,
    fadeIn: opts.fadeIn ?? 0.005,
    fadeOut: opts.fadeOut ?? 0.005,
    fadeShape: opts.fadeShape ?? "equal", // equal | linear | exp
    rate: opts.rate ?? 1,
    detune: opts.detune ?? 0,
    reverse: opts.reverse ?? false,
    mute: opts.mute ?? false,
    // With pitch lock on, `rate` changes length only and `detune` pitch only
    // (a stretched copy is rendered); off, they are one resampling and move together.
    pitchLock: opts.pitchLock ?? false,
    stretchMode: opts.stretchMode ?? "auto", // auto | mono | poly | drums
  };
}

/**
 * Source seconds a clip consumes per timeline second. Detune is part of that
 * for a resampled clip (pitching up plays the source faster) and is not for a
 * pitch-locked one (its pitch shift is rendered into the stretched copy).
 */
export function clipSourceRate(clip) {
  return clip.pitchLock ? clip.rate : clip.rate * Math.pow(2, (clip.detune || 0) / 1200);
}

/** Playable seconds left in the source from `offset`, at the clip's rate. */
export function clipMaxDuration(clip) {
  const asset = assets.get(clip.assetId);
  if (!asset) return clip.duration;
  return Math.max(0.001, (asset.duration - clip.offset) / clipSourceRate(clip));
}

/* ── grid ───────────────────────────────────────────────────────────────── */
export function beatSeconds(p = state.project) {
  return 60 / p.bpm / (p.sigDen / 4);
}
export function barSeconds(p = state.project) {
  return beatSeconds(p) * p.sigNum;
}

const SNAP_DIVISORS = { "1/2": 2, "1/4": 4, "1/8": 8, "1/16": 16, "1/3": 3 };

/** Grid step in seconds for the current snap setting; 0 = no snapping. */
export function snapStep(p = state.project) {
  switch (p.snap) {
    case "off":
      return 0;
    case "bar":
      return barSeconds(p);
    case "beat":
      return beatSeconds(p);
    case "sec":
      return 1;
    default:
      return beatSeconds(p) / (SNAP_DIVISORS[p.snap] ?? 1);
  }
}

export function snapTime(sec, force = false) {
  const step = snapStep();
  if (!step || (!force && state.project.snap === "off")) return Math.max(0, sec);
  return Math.max(0, Math.round(sec / step) * step);
}
