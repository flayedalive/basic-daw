// The arrangement view: bar ruler + clip lanes on two canvases.
//
// Canvas rather than DOM because a session with a few hundred clips has to
// stay smooth while scrolling, and because the waveform inside a clip has to
// be redrawn at whatever zoom the view lands on. Layout is derived, never
// stored: x = (t - scrollX) * pxPerSec, y = cumulative track heights.

import { $, clamp, popupMenu, toast, uid } from "../util.js";
import {
  assets,
  bus,
  changed,
  clipById,
  newClip,
  pushUndo,
  snapTime,
  snapStep,
  state,
  beatSeconds,
  barSeconds,
  clipMaxDuration,
} from "../state.js";
import { drawPeaks } from "../audio/peaks.js";
import { engine } from "../audio/engine.js";

const RULER_H = 26;
const EDGE = 7; // px hit zone for trim handles
const FADE_H = 9; // px tall band at the top of a clip holding the fade handles
const MIN_PPS = 1;
const MAX_PPS = 4000;

let lanes, ruler, lctx, rctx;
let dpr = 1;
let width = 0;
let height = 0;
let dragOp = null;
let hover = null;
let dropGhost = null;
let needsDraw = false;

export const view = state.view;

/* ── geometry ─────────────────────────────────────────────────────────── */

export const timeToX = (t) => (t - view.scrollX) * view.pxPerSec;
export const xToTime = (x) => x / view.pxPerSec + view.scrollX;

export function trackTops() {
  const tops = [];
  let y = 0;
  for (const t of state.project.tracks) {
    tops.push(y);
    y += t.height;
  }
  return tops;
}

export const contentHeight = () => state.project.tracks.reduce((n, t) => n + t.height, 0);

export function trackAtY(y) {
  const tops = trackTops();
  const py = y + view.scrollY;
  for (let i = 0; i < tops.length; i++) {
    const t = state.project.tracks[i];
    if (py >= tops[i] && py < tops[i] + t.height) return { track: t, index: i, top: tops[i] };
  }
  return null;
}

export function clipRect(clip) {
  const idx = state.project.tracks.findIndex((t) => t.id === clip.trackId);
  if (idx < 0) return null;
  const tops = trackTops();
  const track = state.project.tracks[idx];
  return {
    x: timeToX(clip.start),
    y: tops[idx] - view.scrollY,
    w: Math.max(2, clip.duration * view.pxPerSec),
    h: track.height - 1,
    track,
  };
}

function clipAt(x, y) {
  // Topmost first: later clips in the array win, matching draw order.
  for (let i = state.project.clips.length - 1; i >= 0; i--) {
    const c = state.project.clips[i];
    const r = clipRect(c);
    if (!r) continue;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { clip: c, rect: r };
  }
  return null;
}

/** Which part of a clip the pointer is over: move | trim-l | trim-r | fade-i | fade-o */
function hitZone(x, y, hit) {
  const { clip, rect } = hit;
  const relY = y - rect.y;
  if (relY <= FADE_H) {
    const fi = rect.x + clip.fadeIn * view.pxPerSec;
    const fo = rect.x + rect.w - clip.fadeOut * view.pxPerSec;
    if (Math.abs(x - fi) <= EDGE) return "fade-i";
    if (Math.abs(x - fo) <= EDGE) return "fade-o";
  }
  if (x - rect.x <= EDGE) return "trim-l";
  if (rect.x + rect.w - x <= EDGE) return "trim-r";
  return "move";
}

/* ── setup ────────────────────────────────────────────────────────────── */

export function initTimeline() {
  lanes = $("#lanes");
  ruler = $("#ruler");
  lctx = lanes.getContext("2d");
  rctx = ruler.getContext("2d");

  const ro = new ResizeObserver(() => resize());
  ro.observe(lanes.parentElement);
  ro.observe(ruler);
  resize();

  lanes.addEventListener("pointerdown", onLanePointerDown);
  lanes.addEventListener("pointermove", onLaneHover);
  lanes.addEventListener("pointerleave", () => {
    hover = null;
    draw();
  });
  lanes.addEventListener("wheel", onWheel, { passive: false });
  lanes.addEventListener("contextmenu", onContext);
  lanes.addEventListener("dblclick", onDoubleClick);

  ruler.addEventListener("pointerdown", onRulerDown);
  ruler.addEventListener("wheel", onWheel, { passive: false });
  ruler.addEventListener("dblclick", () => {
    pushUndo("clear loop");
    state.project.loop.enabled = false;
    changed("loop");
  });

  // Drops from the pool list.
  lanes.addEventListener("dragover", onDragOver);
  lanes.addEventListener("dragleave", () => {
    dropGhost = null;
    draw();
  });
  lanes.addEventListener("drop", onDrop);

  for (const evt of ["project", "clips", "tracks", "selection", "view", "assets", "loop", "mix"]) bus.on(evt, draw);
}

export function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  const wrap = lanes.parentElement;
  width = wrap.clientWidth;
  height = wrap.clientHeight;
  for (const [cv, h] of [
    [lanes, height],
    [ruler, RULER_H],
  ]) {
    const w = cv === ruler ? ruler.clientWidth : width;
    cv.width = Math.max(1, Math.floor(w * dpr));
    cv.height = Math.max(1, Math.floor(h * dpr));
  }
  draw();
}

/** Coalesce redraws — several state events can land in one frame. */
export function draw() {
  if (needsDraw) return;
  needsDraw = true;
  requestAnimationFrame(() => {
    needsDraw = false;
    paintRuler();
    paintLanes();
  });
}

/* ── painting ─────────────────────────────────────────────────────────── */

/** Choose a grid whose lines stay at least ~9 px apart at the current zoom. */
function gridSpec() {
  const beat = beatSeconds();
  const bar = barSeconds();
  const candidates = [beat / 4, beat / 2, beat, bar, bar * 2, bar * 4, bar * 8, bar * 16, bar * 32];
  const minor = candidates.find((c) => c * view.pxPerSec >= 9) ?? candidates.at(-1);
  const major = candidates.find((c) => c >= bar && c * view.pxPerSec >= 64) ?? bar;
  return { minor, major, beat, bar };
}

function paintRuler() {
  const w = ruler.clientWidth;
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, w, RULER_H);
  rctx.fillStyle = "#1c1f28";
  rctx.fillRect(0, 0, w, RULER_H);

  const { minor, major, bar } = gridSpec();
  const t0 = view.scrollX;
  const t1 = view.scrollX + w / view.pxPerSec;

  // Loop region.
  const loop = state.project.loop;
  if (loop.end > loop.start) {
    const x0 = timeToX(loop.start);
    const x1 = timeToX(loop.end);
    rctx.fillStyle = loop.enabled ? "#5cc8ff33" : "#5cc8ff14";
    rctx.fillRect(x0, 0, x1 - x0, RULER_H);
    rctx.fillStyle = loop.enabled ? "#5cc8ff" : "#5cc8ff66";
    rctx.fillRect(x0, 0, 2, RULER_H);
    rctx.fillRect(x1 - 2, 0, 2, RULER_H);
  }

  rctx.font = "9px ui-monospace, SFMono-Regular, monospace";
  rctx.textBaseline = "alphabetic";
  for (let t = Math.floor(t0 / minor) * minor; t < t1; t += minor) {
    const x = Math.round(timeToX(t)) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    rctx.strokeStyle = isMajor ? "#4a5170" : "#2c3142";
    rctx.beginPath();
    rctx.moveTo(x, isMajor ? 4 : RULER_H - 7);
    rctx.lineTo(x, RULER_H);
    rctx.stroke();
    if (isMajor) {
      const barNo = Math.round(t / bar) + 1;
      rctx.fillStyle = "#8a90a4";
      rctx.fillText(String(barNo), x + 3, 12);
    }
  }

  // Markers.
  for (const m of state.project.markers) {
    const x = timeToX(m.time);
    if (x < -40 || x > w + 40) continue;
    rctx.fillStyle = "#ffb454";
    rctx.beginPath();
    rctx.moveTo(x, RULER_H - 10);
    rctx.lineTo(x + 7, RULER_H - 6);
    rctx.lineTo(x, RULER_H - 2);
    rctx.closePath();
    rctx.fill();
    rctx.fillText(m.name, x + 9, RULER_H - 3);
  }

  const px = timeToX(engine.playing ? engine.position : state.playhead);
  rctx.fillStyle = "#ff6b6b";
  rctx.beginPath();
  rctx.moveTo(px - 5, 0);
  rctx.lineTo(px + 5, 0);
  rctx.lineTo(px, 8);
  rctx.closePath();
  rctx.fill();
  rctx.fillRect(px - 0.5, 0, 1, RULER_H);
}

function paintLanes() {
  lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lctx.clearRect(0, 0, width, height);
  lctx.fillStyle = "#14161c";
  lctx.fillRect(0, 0, width, height);

  const tops = trackTops();
  const tracks = state.project.tracks;

  // Lane backgrounds (alternating) and horizontal separators.
  for (let i = 0; i < tracks.length; i++) {
    const y = tops[i] - view.scrollY;
    const h = tracks[i].height;
    if (y + h < 0 || y > height) continue;
    lctx.fillStyle = i % 2 ? "#171a22" : "#14161c";
    lctx.fillRect(0, y, width, h);
    if (tracks[i].id === state.selectedTrackId) {
      lctx.fillStyle = "#5cc8ff08";
      lctx.fillRect(0, y, width, h);
    }
    lctx.strokeStyle = "#232739";
    lctx.beginPath();
    lctx.moveTo(0, y + h - 0.5);
    lctx.lineTo(width, y + h - 0.5);
    lctx.stroke();
  }

  // Grid.
  const { minor, major } = gridSpec();
  const t0 = view.scrollX;
  const t1 = view.scrollX + width / view.pxPerSec;
  for (let t = Math.floor(t0 / minor) * minor; t < t1; t += minor) {
    const x = Math.round(timeToX(t)) + 0.5;
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    lctx.strokeStyle = isMajor ? "#2a2f44" : "#1e2230";
    lctx.beginPath();
    lctx.moveTo(x, 0);
    lctx.lineTo(x, height);
    lctx.stroke();
  }

  // Loop shading over the lanes.
  const loop = state.project.loop;
  if (loop.enabled && loop.end > loop.start) {
    lctx.fillStyle = "#5cc8ff0c";
    lctx.fillRect(timeToX(loop.start), 0, (loop.end - loop.start) * view.pxPerSec, height);
  }

  for (const clip of state.project.clips) paintClip(clip);

  if (dragOp?.kind === "marquee") {
    const { x0, y0, x1, y1 } = dragOp;
    lctx.fillStyle = "#5cc8ff18";
    lctx.strokeStyle = "#5cc8ff";
    lctx.lineWidth = 1;
    lctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
    lctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  if (dropGhost) {
    const { x, y, w, h } = dropGhost;
    lctx.fillStyle = "#5cc8ff33";
    lctx.strokeStyle = "#5cc8ff";
    lctx.setLineDash([4, 3]);
    lctx.fillRect(x, y, w, h);
    lctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    lctx.setLineDash([]);
  }

  // Playhead last so it is never buried under a clip.
  const px = timeToX(engine.playing ? engine.position : state.playhead);
  lctx.fillStyle = "#ff6b6b";
  lctx.fillRect(px - 0.5, 0, 1, height);
}

function paintClip(clip) {
  const r = clipRect(clip);
  if (!r || r.x + r.w < 0 || r.x > width || r.y + r.h < 0 || r.y > height) return;
  const selected = state.selection.has(clip.id);
  const color = r.track.color;
  const x = r.x;
  const w = r.w;
  const y = r.y + 1;
  const h = r.h - 2;

  lctx.save();
  lctx.beginPath();
  lctx.roundRect(x, y, w, h, 3);
  lctx.clip();

  lctx.fillStyle = clip.mute ? "#2a2f3d" : hexA(color, selected ? 0.34 : 0.22);
  lctx.fillRect(x, y, w, h);

  // Waveform.
  const asset = assets.get(clip.assetId);
  if (asset?.peaks && w > 3) {
    const effRate = clip.rate * Math.pow(2, (clip.detune || 0) / 1200);
    const sr = asset.peaks.sampleRate;
    const visX0 = Math.max(x, 0);
    const visX1 = Math.min(x + w, width);
    const startSec = clip.offset + ((visX0 - x) / view.pxPerSec) * effRate;
    const endSec = clip.offset + ((visX1 - x) / view.pxPerSec) * effRate;
    lctx.fillStyle = clip.mute ? "#4d5468" : hexA(color, 0.95);
    const wy = y + (h > 28 ? 12 : 2);
    const wh = h - (h > 28 ? 14 : 4);
    if (clip.reverse) {
      drawPeaks(lctx, asset.peaks, (asset.duration - endSec) * sr, (asset.duration - startSec) * sr, visX0, wy, visX1 - visX0, wh);
    } else {
      drawPeaks(lctx, asset.peaks, startSec * sr, endSec * sr, visX0, wy, visX1 - visX0, wh);
    }
  } else if (asset?.missing) {
    lctx.fillStyle = "#ff6b6b55";
    lctx.fillRect(x, y, w, h);
  }

  // Fades, drawn as the part of the clip they mute.
  if (clip.fadeIn > 0.001) {
    const fw = clip.fadeIn * view.pxPerSec;
    lctx.fillStyle = "#14161cc0";
    lctx.beginPath();
    lctx.moveTo(x, y);
    lctx.lineTo(x + fw, y);
    lctx.lineTo(x, y + h);
    lctx.closePath();
    lctx.fill();
  }
  if (clip.fadeOut > 0.001) {
    const fw = clip.fadeOut * view.pxPerSec;
    lctx.fillStyle = "#14161cc0";
    lctx.beginPath();
    lctx.moveTo(x + w, y);
    lctx.lineTo(x + w - fw, y);
    lctx.lineTo(x + w, y + h);
    lctx.closePath();
    lctx.fill();
  }

  // Clip gain, as a line across the clip.
  if (clip.gainDb !== 0 && h > 20) {
    const t = clamp(0.5 - clip.gainDb / 48, 0.05, 0.95);
    lctx.strokeStyle = "#ffb45499";
    lctx.setLineDash([3, 3]);
    lctx.beginPath();
    lctx.moveTo(x, y + h * t);
    lctx.lineTo(x + w, y + h * t);
    lctx.stroke();
    lctx.setLineDash([]);
  }

  if (h > 18 && w > 24) {
    lctx.fillStyle = hexA(color, 0.85);
    lctx.fillRect(x, y, w, 11);
    lctx.fillStyle = "#0d0f14";
    lctx.font = "9px ui-monospace, SFMono-Regular, monospace";
    lctx.textBaseline = "middle";
    const label = `${clip.mute ? "· " : ""}${clip.name}${clip.reverse ? " ⟲" : ""}`;
    lctx.fillText(label, x + 4, y + 6, Math.max(0, w - 8));
  }

  lctx.restore();

  lctx.strokeStyle = selected ? "#ffffff" : hexA(color, 0.75);
  lctx.lineWidth = selected ? 1.6 : 1;
  lctx.beginPath();
  lctx.roundRect(x + 0.5, y + 0.5, Math.max(1, w - 1), h - 1, 3);
  lctx.stroke();

  // Fade handles, only when the clip is big enough to grab them.
  if (selected && w > 16) {
    lctx.fillStyle = "#ffffff";
    for (const hx of [x + clip.fadeIn * view.pxPerSec, x + w - clip.fadeOut * view.pxPerSec]) {
      lctx.beginPath();
      lctx.arc(clamp(hx, x, x + w), y + 3, 3, 0, Math.PI * 2);
      lctx.fill();
    }
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/* ── pointer interaction ──────────────────────────────────────────────── */

function localPos(e, target = lanes) {
  const r = target.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onLaneHover(e) {
  if (dragOp) return;
  const { x, y } = localPos(e);
  const hit = clipAt(x, y);
  hover = hit ? { id: hit.clip.id, zone: hitZone(x, y, hit) } : null;
  lanes.style.cursor = !hover
    ? "default"
    : hover.zone === "trim-l" || hover.zone === "trim-r"
      ? "ew-resize"
      : hover.zone.startsWith("fade")
        ? "col-resize"
        : "grab";
  setStatus(hoverStatus(hit, x));
}

function hoverStatus(hit, x) {
  const t = xToTime(x);
  const time = `${t.toFixed(3)}s`;
  if (!hit) return `${time} · ${state.project.clips.length} clips`;
  const c = hit.clip;
  const a = assets.get(c.assetId);
  return `${c.name} · ${c.duration.toFixed(3)}s @ ${c.start.toFixed(3)}s · src ${c.offset.toFixed(3)}s${
    c.rate !== 1 ? ` · rate ${c.rate.toFixed(3)}` : ""
  }${a ? ` · ${a.channels}ch ${a.sampleRate}Hz` : ""}`;
}

export function setStatus(text) {
  const s = $("#status");
  if (s) s.textContent = text;
}

function onLanePointerDown(e) {
  if (e.button === 2) return; // context menu handles right-click
  engine.ensure();
  const { x, y } = localPos(e);
  const hit = clipAt(x, y);

  // Middle button anywhere, or Alt-drag on empty space, pans the view.
  if (e.button === 1 || (e.altKey && !hit)) return startPan(e);

  if (!hit) {
    if (!e.shiftKey) {
      state.selection.clear();
      changed("selection", false);
    }
    const lane = trackAtY(y);
    if (lane) state.selectedTrackId = lane.track.id;
    dragOp = { kind: "marquee", x0: x, y0: y, x1: x, y1: y, add: e.shiftKey };
    attachDrag(e);
    draw();
    return;
  }

  const zone = hitZone(x, y, hit);
  const clip = hit.clip;
  state.selectedTrackId = clip.trackId;

  if (e.metaKey || e.ctrlKey) {
    if (state.selection.has(clip.id)) state.selection.delete(clip.id);
    else state.selection.add(clip.id);
  } else if (e.shiftKey) {
    state.selection.add(clip.id);
  } else if (!state.selection.has(clip.id)) {
    state.selection.clear();
    state.selection.add(clip.id);
  }
  changed("selection", false);

  const snapshot = () => new Map(selected().map((c) => [c.id, { ...c }]));

  if (zone === "move") {
    pushUndo(e.altKey ? "duplicate clips" : "move clips");
    if (e.altKey) {
      // Alt-drag copies: clone the selection, then drag the clones.
      const clones = selected().map((c) => ({ ...c, id: undefined }));
      state.selection.clear();
      for (const c of clones) {
        const copy = { ...c, id: uid("clip") };
        state.project.clips.push(copy);
        state.selection.add(copy.id);
      }
      changed("clips");
    }
    dragOp = { kind: "move", grabTime: xToTime(x), grabY: y, orig: snapshot(), dTime: 0, dTrack: 0 };
  } else if (zone === "trim-l" || zone === "trim-r") {
    pushUndo("trim clip");
    dragOp = { kind: zone, id: clip.id, orig: snapshot(), grabTime: xToTime(x) };
  } else {
    pushUndo("fade");
    dragOp = { kind: zone, id: clip.id, orig: snapshot(), grabTime: xToTime(x) };
  }
  attachDrag(e);
}

const selected = () => state.project.clips.filter((c) => state.selection.has(c.id));

function attachDrag(e) {
  const move = (ev) => {
    const { x, y } = localPos(ev);
    applyDrag(x, y, ev);
    draw();
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    finishDrag();
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function startPan(e) {
  const startX = view.scrollX;
  const startY = view.scrollY;
  const x0 = e.clientX;
  const y0 = e.clientY;
  const move = (ev) => {
    view.scrollX = Math.max(0, startX - (ev.clientX - x0) / view.pxPerSec);
    view.scrollY = clamp(startY - (ev.clientY - y0), 0, Math.max(0, contentHeight() - height));
    changed("view", false);
  };
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function applyDrag(x, y, ev) {
  if (!dragOp) return;
  const fine = ev.shiftKey; // shift = ignore the grid
  const t = xToTime(x);

  if (dragOp.kind === "marquee") {
    dragOp.x1 = x;
    dragOp.y1 = y;
    const x0 = Math.min(dragOp.x0, x);
    const x1 = Math.max(dragOp.x0, x);
    const y0 = Math.min(dragOp.y0, y);
    const y1 = Math.max(dragOp.y0, y);
    if (!dragOp.add) state.selection.clear();
    for (const c of state.project.clips) {
      const r = clipRect(c);
      if (!r) continue;
      if (r.x < x1 && r.x + r.w > x0 && r.y < y1 && r.y + r.h > y0) state.selection.add(c.id);
    }
    changed("selection", false);
    return;
  }

  if (dragOp.kind === "move") {
    const lane = trackAtY(y);
    const fromIdx = state.project.tracks.findIndex((tr) => tr.id === [...dragOp.orig.values()][0]?.trackId);
    const dTrack = lane ? lane.index - fromIdx : 0;
    let dTime = t - dragOp.grabTime;
    // Snap the earliest clip in the selection, and move the rest in lockstep.
    const anchor = Math.min(...[...dragOp.orig.values()].map((c) => c.start));
    if (!fine) dTime = snapTime(anchor + dTime) - anchor;
    const minStart = Math.min(...[...dragOp.orig.values()].map((c) => c.start + dTime));
    if (minStart < 0) dTime -= minStart;
    for (const clip of selected()) {
      const o = dragOp.orig.get(clip.id);
      if (!o) continue;
      clip.start = Math.max(0, o.start + dTime);
      const oi = state.project.tracks.findIndex((tr) => tr.id === o.trackId);
      const ni = clamp(oi + dTrack, 0, state.project.tracks.length - 1);
      clip.trackId = state.project.tracks[ni].id;
    }
    changed("clips");
    return;
  }

  const clip = clipById(dragOp.id);
  const o = dragOp.orig.get(dragOp.id);
  if (!clip || !o) return;
  const asset = assets.get(clip.assetId);
  const effRate = clip.rate * Math.pow(2, (clip.detune || 0) / 1200);

  if (dragOp.kind === "trim-l") {
    let newStart = fine ? t : snapTime(t);
    const maxStart = o.start + o.duration - 0.02;
    newStart = clamp(newStart, Math.max(0, o.start - o.offset / effRate), maxStart);
    const delta = newStart - o.start;
    clip.start = newStart;
    clip.offset = Math.max(0, o.offset + delta * effRate);
    clip.duration = o.duration - delta;
    changed("clips");
  } else if (dragOp.kind === "trim-r") {
    let end = fine ? t : snapTime(t);
    const maxDur = asset ? (asset.duration - clip.offset) / effRate : Infinity;
    clip.duration = clamp(end - clip.start, 0.02, maxDur);
    changed("clips");
  } else if (dragOp.kind === "fade-i") {
    clip.fadeIn = clamp(t - clip.start, 0, clip.duration);
    changed("clips");
  } else if (dragOp.kind === "fade-o") {
    clip.fadeOut = clamp(clip.start + clip.duration - t, 0, clip.duration);
    changed("clips");
  }
}

function finishDrag() {
  const kind = dragOp?.kind;
  dragOp = null;
  draw();
  if (kind && kind !== "marquee") engine.invalidate();
}

function onDoubleClick(e) {
  const { x, y } = localPos(e);
  const hit = clipAt(x, y);
  if (!hit) {
    state.playhead = snapTime(xToTime(x));
    engine.seek(state.playhead);
    changed("view", false);
    return;
  }
  // Double-click sets the loop to the clip: the fastest way to audition one.
  pushUndo("loop to clip");
  state.project.loop = { enabled: true, start: hit.clip.start, end: hit.clip.start + hit.clip.duration };
  engine.seek(hit.clip.start);
  changed("loop");
}

function onRulerDown(e) {
  engine.ensure();
  const { x } = localPos(e, ruler);
  const t = Math.max(0, xToTime(x));
  if (e.shiftKey || e.button === 2) {
    pushUndo("loop region");
    const anchor = snapTime(t);
    state.project.loop = { enabled: true, start: anchor, end: anchor + snapStep() };
    const move = (ev) => {
      const tx = Math.max(0, xToTime(localPos(ev, ruler).x));
      const s = snapTime(Math.min(anchor, tx));
      const en = snapTime(Math.max(anchor, tx));
      state.project.loop.start = s;
      state.project.loop.end = Math.max(en, s + 0.01);
      changed("loop");
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      engine.invalidate();
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    return;
  }
  const seek = (tx) => {
    state.playhead = snapTime(Math.max(0, tx));
    engine.seek(state.playhead);
    changed("view", false);
  };
  seek(t);
  const move = (ev) => seek(xToTime(localPos(ev, ruler).x));
  const up = () => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
}

function onWheel(e) {
  e.preventDefault();
  if (e.altKey) return zoomTracks(Math.pow(1.0015, -(e.deltaY || e.deltaX)), localPos(e, e.currentTarget).y);
  if (e.ctrlKey || e.metaKey) {
    const anchorX = localPos(e, e.currentTarget).x;
    zoomAt(anchorX, Math.pow(1.0025, -e.deltaY));
    return;
  }
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const dx = (e.shiftKey ? e.deltaY : e.deltaX) / view.pxPerSec;
    view.scrollX = Math.max(0, view.scrollX + dx);
  } else {
    view.scrollY = clamp(view.scrollY + e.deltaY, 0, Math.max(0, contentHeight() - height));
  }
  changed("view", false);
}

export function zoomAt(anchorX, factor) {
  const tAnchor = xToTime(anchorX);
  view.pxPerSec = clamp(view.pxPerSec * factor, MIN_PPS, MAX_PPS);
  view.scrollX = Math.max(0, tAnchor - anchorX / view.pxPerSec);
  changed("view", false);
}

export function zoomBy(factor) {
  zoomAt(width / 2, factor);
}

export function zoomToFit() {
  let end = 0;
  for (const c of state.project.clips) end = Math.max(end, c.start + c.duration);
  if (end <= 0) end = barSeconds() * 8;
  view.pxPerSec = clamp((width - 40) / end, MIN_PPS, MAX_PPS);
  view.scrollX = 0;
  changed("view", false);
}

export function scrollToPlayhead(force = false) {
  const pos = engine.playing ? engine.position : state.playhead;
  if (!Number.isFinite(pos)) return; // never scroll the view off to nowhere
  const x = timeToX(pos);
  if (force || x > width - 60 || x < 0) {
    view.scrollX = Math.max(0, pos - (width * 0.25) / view.pxPerSec);
    changed("view", false);
  }
}

export function scrollTracksTo(y) {
  view.scrollY = clamp(y, 0, Math.max(0, contentHeight() - height));
  changed("view", false);
}

export const viewportHeight = () => height;
export const viewportWidth = () => width;

/** Scroll the lanes so track `index` is fully visible (no-op if it already is). */
export function revealTrack(index) {
  const tops = trackTops();
  const t = state.project.tracks[index];
  if (!t) return;
  const top = tops[index];
  if (top < view.scrollY) scrollTracksTo(top);
  else if (top + t.height > view.scrollY + height) scrollTracksTo(top + t.height - height);
}

// Track heights, kept in step with the drag-resize limits in tracks.js.
const TRACK_MIN_H = 34;
const TRACK_MAX_H = 260;
let heightUndoAt = 0;

/**
 * Scale every track's height (Alt + wheel), keeping the track under the
 * pointer where it is. One undo step per gesture, not per wheel notch.
 */
export function zoomTracks(factor, anchorY = height / 2) {
  const tracks = state.project.tracks;
  if (!tracks.length) return;
  const now = performance.now();
  if (now - heightUndoAt > 600) pushUndo("track height");
  heightUndoAt = now;
  // Where the pointer sits, as track index + fraction, before resizing.
  const hit = trackAtY(anchorY);
  const frac = hit ? (anchorY + view.scrollY - hit.top) / hit.track.height : 0;
  for (const t of tracks) t.height = clamp(Math.round(t.height * factor), TRACK_MIN_H, TRACK_MAX_H);
  if (hit) {
    const top = trackTops()[hit.index];
    view.scrollY = top + frac * hit.track.height - anchorY;
  }
  view.scrollY = clamp(view.scrollY, 0, Math.max(0, contentHeight() - height));
  changed("tracks");
}

/* ── drop from the pool ───────────────────────────────────────────────── */

function onDragOver(e) {
  if (!e.dataTransfer.types.includes("application/x-daw-asset") && !e.dataTransfer.types.includes("Files")) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  const { x, y } = localPos(e);
  const lane = trackAtY(y);
  const id = window.__dawDragAssetId;
  const asset = id ? assets.get(id) : null;
  const start = snapTime(xToTime(x));
  dropGhost = {
    x: timeToX(start),
    y: lane ? lane.top - view.scrollY : 0,
    w: (asset?.duration ?? 2) * view.pxPerSec,
    h: lane ? lane.track.height - 2 : 40,
  };
  draw();
}

async function onDrop(e) {
  e.preventDefault();
  dropGhost = null;
  const { x, y } = localPos(e);
  const lane = trackAtY(y);
  const start = snapTime(xToTime(x));
  const assetId = e.dataTransfer.getData("application/x-daw-asset") || window.__dawDragAssetId;

  if (assetId && assets.get(assetId)) {
    dropAssetAt(assetId, lane?.track.id, start);
    return;
  }
  if (e.dataTransfer.files?.length) {
    const { importFiles } = await import("../assets.js");
    const imported = await importFiles(e.dataTransfer.files);
    let at = start;
    for (const a of imported) {
      dropAssetAt(a.id, lane?.track.id, at);
      at += a.duration;
    }
  }
}

/** Place an asset as a clip; creates a track when dropped past the last lane. */
export function dropAssetAt(assetId, trackId, start) {
  const asset = assets.get(assetId);
  if (!asset) return null;
  pushUndo("add clip");
  let tid = trackId;
  if (!tid) {
    const { addTrack } = requireTracks();
    tid = addTrack(asset.name).id;
  }
  const clip = newClip(assetId, tid, Math.max(0, start));
  state.project.clips.push(clip);
  state.selection.clear();
  state.selection.add(clip.id);
  state.selectedTrackId = tid;
  changed("clips");
  engine.invalidate();
  return clip;
}

// Lazily resolved to avoid an import cycle with the track-header module.
let tracksApi = null;
export function registerTracksApi(api) {
  tracksApi = api;
}
function requireTracks() {
  if (!tracksApi) throw new Error("tracks API not registered");
  return tracksApi;
}

/* ── context menu ─────────────────────────────────────────────────────── */

function onContext(e) {
  e.preventDefault();
  const { x, y } = localPos(e);
  const hit = clipAt(x, y);
  const t = xToTime(x);
  if (hit && !state.selection.has(hit.clip.id)) {
    state.selection.clear();
    state.selection.add(hit.clip.id);
    changed("selection", false);
  }
  const items = hit ? clipMenu(hit.clip, t) : laneMenu(trackAtY(y)?.track, t);
  popupMenu(e.clientX, e.clientY, items);
}

function clipMenu(clip, t) {
  const many = state.selection.size > 1;
  return [
    { title: many ? `${state.selection.size} clips` : clip.name },
    { label: "Split at cursor", sc: "S", onClick: () => splitSelection(t) },
    { label: "Duplicate", sc: "Ctrl+D", onClick: () => duplicateSelection() },
    { label: clip.mute ? "Unmute" : "Mute", sc: "M", onClick: () => toggleMuteSelection() },
    { label: clip.reverse ? "Un-reverse" : "Reverse", onClick: () => toggleReverseSelection() },
    "-",
    { label: "Fade in to cursor", onClick: () => fadeToCursor(t, "in") },
    { label: "Fade out from cursor", onClick: () => fadeToCursor(t, "out") },
    { label: "Clear fades", onClick: () => clearFades() },
    "-",
    { label: "Loop over clip", onClick: () => setLoopToSelection() },
    { label: "Move to playhead", onClick: () => moveSelectionTo(state.playhead) },
    { label: "Rename…", onClick: () => renameClip(clip) },
    "-",
    { label: "Delete", sc: "⌫", onClick: () => deleteSelection() },
  ];
}

function laneMenu(track, t) {
  return [
    { title: track ? track.name : "Arrangement" },
    { label: "Paste here", sc: "Ctrl+V", disabled: !clipboard.length, onClick: () => pasteClipboard(track?.id, snapTime(t)) },
    { label: "Add marker here", sc: "P", onClick: () => addMarker(snapTime(t)) },
    { label: "Select all in track", disabled: !track, onClick: () => selectTrackClips(track.id) },
  ];
}

/* ── clip commands (shared with the keyboard map) ─────────────────────── */

export function splitSelection(at = state.playhead) {
  const targets = selected().filter((c) => at > c.start + 0.001 && at < c.start + c.duration - 0.001);
  if (!targets.length) {
    toast("Nothing to split at the cursor");
    return;
  }
  pushUndo("split");
  for (const c of targets) {
    const effRate = c.rate * Math.pow(2, (c.detune || 0) / 1200);
    const left = at - c.start;
    const right = { ...c, id: uid("clip") };
    right.start = at;
    right.offset = c.offset + left * effRate;
    right.duration = c.duration - left;
    right.fadeIn = Math.min(0.005, right.duration);
    c.duration = left;
    c.fadeOut = Math.min(0.005, c.duration);
    state.project.clips.push(right);
    state.selection.add(right.id);
  }
  changed("clips");
  engine.invalidate();
}

export function duplicateSelection() {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("duplicate");
  const end = Math.max(...sel.map((c) => c.start + c.duration));
  const start = Math.min(...sel.map((c) => c.start));
  const span = end - start;
  state.selection.clear();
  for (const c of sel) {
    const copy = { ...c, id: uid("clip"), start: c.start + span };
    state.project.clips.push(copy);
    state.selection.add(copy.id);
  }
  changed("clips");
  engine.invalidate();
}

export function deleteSelection() {
  if (!state.selection.size) return;
  pushUndo("delete clips");
  state.project.clips = state.project.clips.filter((c) => !state.selection.has(c.id));
  state.selection.clear();
  changed("clips");
  engine.invalidate();
}

export function toggleMuteSelection() {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("mute clips");
  const to = !sel[0].mute;
  for (const c of sel) c.mute = to;
  changed("clips");
  engine.invalidate();
}

export function toggleReverseSelection() {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("reverse clips");
  const to = !sel[0].reverse;
  for (const c of sel) c.reverse = to;
  changed("clips");
  engine.invalidate();
}

function fadeToCursor(t, dir) {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("fade");
  for (const c of sel) {
    if (dir === "in") c.fadeIn = clamp(t - c.start, 0, c.duration);
    else c.fadeOut = clamp(c.start + c.duration - t, 0, c.duration);
  }
  changed("clips");
  engine.invalidate();
}

function clearFades() {
  pushUndo("clear fades");
  for (const c of selected()) {
    c.fadeIn = 0.005;
    c.fadeOut = 0.005;
  }
  changed("clips");
  engine.invalidate();
}

export function setLoopToSelection() {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("loop region");
  state.project.loop = {
    enabled: true,
    start: Math.min(...sel.map((c) => c.start)),
    end: Math.max(...sel.map((c) => c.start + c.duration)),
  };
  changed("loop");
  engine.invalidate();
}

function moveSelectionTo(t) {
  const sel = selected();
  if (!sel.length) return;
  pushUndo("move clips");
  const start = Math.min(...sel.map((c) => c.start));
  for (const c of sel) c.start = Math.max(0, c.start + (t - start));
  changed("clips");
  engine.invalidate();
}

function renameClip(clip) {
  const name = prompt("Clip name", clip.name);
  if (name == null) return;
  pushUndo("rename clip");
  clip.name = name;
  changed("clips");
}

function selectTrackClips(trackId) {
  state.selection.clear();
  for (const c of state.project.clips) if (c.trackId === trackId) state.selection.add(c.id);
  changed("selection", false);
}

export function selectAllClips() {
  for (const c of state.project.clips) state.selection.add(c.id);
  changed("selection", false);
}

export function addMarker(t) {
  pushUndo("add marker");
  state.project.markers.push({ time: t, name: `M${state.project.markers.length + 1}` });
  state.project.markers.sort((a, b) => a.time - b.time);
  changed("project");
}

/* ── clipboard ────────────────────────────────────────────────────────── */

let clipboard = [];

export function copySelection(cut = false) {
  const sel = selected();
  if (!sel.length) return;
  const base = Math.min(...sel.map((c) => c.start));
  clipboard = sel.map((c) => ({ ...c, start: c.start - base }));
  if (cut) deleteSelection();
  setStatus(`${clipboard.length} clip(s) ${cut ? "cut" : "copied"}`);
}

export function pasteClipboard(trackId = state.selectedTrackId, at = state.playhead) {
  if (!clipboard.length) return;
  pushUndo("paste");
  const tracks = state.project.tracks;
  const baseIdx = Math.max(0, tracks.findIndex((t) => t.id === (trackId ?? clipboard[0].trackId)));
  const srcTracks = [...new Set(clipboard.map((c) => c.trackId))];
  state.selection.clear();
  for (const c of clipboard) {
    const rel = srcTracks.indexOf(c.trackId);
    const target = tracks[clamp(baseIdx + rel, 0, tracks.length - 1)];
    const copy = { ...c, id: uid("clip"), start: at + c.start, trackId: target.id };
    state.project.clips.push(copy);
    state.selection.add(copy.id);
  }
  changed("clips");
  engine.invalidate();
}

export const hasClipboard = () => clipboard.length > 0;

/** Nudge the selection by one grid step (or a fine amount with `fine`). */
export function nudgeSelection(dir, fine = false) {
  const sel = selected();
  if (!sel.length) return;
  const step = fine ? 0.01 : snapStep() || 0.1;
  pushUndo("nudge");
  for (const c of sel) c.start = Math.max(0, c.start + dir * step);
  changed("clips");
  engine.invalidate();
}

/** Extend/shrink every selected clip's tail by one grid step. */
export function stretchSelection(dir) {
  const sel = selected();
  if (!sel.length) return;
  const step = snapStep() || 0.1;
  pushUndo("resize");
  for (const c of sel) c.duration = clamp(c.duration + dir * step, 0.02, clipMaxDuration(c));
  changed("clips");
  engine.invalidate();
}
