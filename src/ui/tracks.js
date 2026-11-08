// Track headers, kept as DOM (they are mostly widgets) and absolutely
// positioned so a single transform keeps them locked to the canvas scroll.

import { $, el, popupMenu, drag, clamp, coalesce, uid, TRACK_COLORS, fmtDb } from "../util.js";
import { bus, changed, newTrack, pushUndo, state, trackById } from "../state.js";
import { engine } from "../audio/engine.js";
import { DEFAULT_INPUT, input, inputChoices, inputLabel } from "../audio/input.js";
import { fader, meterBar } from "./controls.js";
import { registerTracksApi, draw as drawTimeline, view, viewportHeight } from "./timeline.js";

const MIN_H = 34;
const MAX_H = 260;

let host;
const rows = new Map(); // trackId -> live widget handles, so "mix" updates never rebuild the DOM

export function initTracks() {
  host = $("#track-heads");
  $("#btn-add-track").addEventListener("click", () => addTrack());
  host.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".thead");
    e.preventDefault();
    popupMenu(e.clientX, e.clientY, trackMenu(row ? trackById(row.dataset.id) : null));
  });
  host.addEventListener("wheel", (e) => {
    // Wheeling over the headers scrolls the lanes, not the page.
    e.preventDefault();
    view.scrollY = clamp(view.scrollY + e.deltaY, 0, Math.max(0, contentH() - viewportHeight()));
    changed("view", false);
  }, { passive: false });

  const refresh = coalesce(render);
  bus.on("tracks", refresh);
  bus.on("project", refresh);
  bus.on("view", position);
  bus.on("mix", syncValues);
  bus.on("selection", highlight);
  bus.on("mixlive", syncLabels);
  registerTracksApi({ addTrack, deleteTrack });
  render();
}

const contentH = () => state.project.tracks.reduce((n, t) => n + t.height, 0);

export function addTrack(name) {
  pushUndo("add track");
  const t = newTrack(name, state.project.tracks.length);
  state.project.tracks.push(t);
  state.selectedTrackId = t.id;
  changed("tracks");
  engine.syncGraph();
  return t;
}

export function deleteTrack(id) {
  if (state.project.tracks.length <= 1) return;
  pushUndo("delete track");
  state.project.tracks = state.project.tracks.filter((t) => t.id !== id);
  state.project.clips = state.project.clips.filter((c) => c.trackId !== id);
  if (state.selectedTrackId === id) state.selectedTrackId = state.project.tracks[0]?.id ?? null;
  changed("tracks");
  engine.syncGraph();
  engine.invalidate();
}

function duplicateTrack(id) {
  const src = trackById(id);
  if (!src) return;
  pushUndo("duplicate track");
  const copy = { ...structuredClone(src), id: uid("trk"), name: `${src.name} copy` };
  const at = state.project.tracks.findIndex((t) => t.id === id) + 1;
  state.project.tracks.splice(at, 0, copy);
  for (const c of state.project.clips.filter((c) => c.trackId === id)) {
    state.project.clips.push({ ...c, id: uid("clip"), trackId: copy.id });
  }
  changed("tracks");
  engine.syncGraph();
  engine.invalidate();
}

function trackMenu(track) {
  return [
    { title: track ? track.name : "Tracks" },
    { label: "Add track", sc: "T", onClick: () => addTrack() },
    { label: "Duplicate track", disabled: !track, onClick: () => duplicateTrack(track.id) },
    { label: "Delete track", disabled: !track, onClick: () => deleteTrack(track.id) },
    "-",
    {
      label: "Fit height to content",
      disabled: !track,
      onClick: () => {
        pushUndo("track height");
        track.height = 110;
        changed("tracks");
      },
    },
    {
      label: "Reset all heights",
      onClick: () => {
        pushUndo("track height");
        for (const t of state.project.tracks) t.height = 74;
        changed("tracks");
      },
    },
    ...(track ? recordMenu(track) : []),
  ];
}

/** Input choice and monitoring, right where the arm button is. */
function recordMenu(track) {
  const current = String(track.input ?? DEFAULT_INPUT);
  return [
    "-",
    { title: "Record from" },
    ...inputChoices(input.channels || 2).map((c) => ({
      label: c.label,
      checked: c.value === current,
      onClick: () => {
        pushUndo("track input");
        track.input = c.value;
        changed("mix");
      },
    })),
    {
      label: "Monitor input",
      checked: !!track.monitor,
      onClick: () => {
        pushUndo("monitor");
        track.monitor = !track.monitor;
        changed("mix");
      },
    },
    { label: "Audio setup…", onClick: () => import("./audio-setup.js").then((m) => m.audioSetup()) },
  ];
}

export function render() {
  if (!host) return;
  host.replaceChildren();
  rows.clear();
  let y = 0;
  for (const [i, track] of state.project.tracks.entries()) {
    host.append(buildHead(track, i, y));
    y += track.height;
  }
  position();
  highlight();
}

function buildHead(track, index, top) {
  const compact = track.height < 56;
  const swatch = el("div.swatch", {
    style: { background: track.color },
    title: "Track colour",
    onclick: (e) => {
      e.stopPropagation();
      popupMenu(
        e.clientX,
        e.clientY,
        TRACK_COLORS.map((c) => ({
          label: c === track.color ? "● current" : "●",
          onClick: () => {
            pushUndo("track colour");
            track.color = c;
            changed("tracks");
          },
        })),
      );
    },
  });

  const name = el("input.tname", {
    value: track.name,
    spellcheck: false,
    onchange: () => {
      pushUndo("rename track");
      track.name = name.value;
      changed("tracks");
    },
  });

  const toggle = (label, on, cls, fn, title) =>
    el(`button.tgl${on ? "." + cls : ""}`, { title, onclick: (e) => (e.stopPropagation(), fn()) }, label);

  const meter = meterBar();

  const vol = fader({
    value: track.volumeDb,
    orient: "h",
    width: 74,
    height: 14,
    onInput: (db) => {
      track.volumeDb = db;
      engine.updateMix();
      dbLabel.textContent = fmtDb(db);
      bus.emit("mixlive");
    },
    onChange: () => changed("mix"),
  });
  const dbLabel = el("span.a-meta", null, fmtDb(track.volumeDb));

  const mBtn = toggle("M", track.mute, "on-m", () => setFlag(track, "mute", !track.mute), "Mute");
  const sBtn = toggle("S", track.solo, "on-s", () => setFlag(track, "solo", !track.solo), "Solo");
  const rBtn = toggle("●", track.armed, "on-r", () => setFlag(track, "armed", !track.armed), armTitle(track));
  const row1 = el("div.row1", null, swatch, name, dbLabel);
  const row2 = el("div.row2", null, mBtn, sBtn, rBtn, el("div.minifader", null, vol.root), meter.root);
  rows.set(track.id, { swatch, name, dbLabel, meter, vol, mBtn, sBtn, rBtn });

  const head = el(
    `div.thead`,
    {
      dataset: { id: track.id },
      style: { top: `${top}px`, height: `${track.height}px` },
      onpointerdown: (e) => {
        if (e.target.closest("button, input, canvas")) return;
        state.selectedTrackId = track.id;
        state.focusedStrip = track.id;
        changed("selection", false);
        bus.emit("mixfocus");
      },
    },
    row1,
    compact ? null : row2,
  );

  // Bottom edge drags the track height.
  head.append(
    el("div", {
      style: { position: "absolute", left: 0, right: 0, bottom: 0, height: "5px", cursor: "row-resize" },
      onpointerdown: (e) => {
        e.stopPropagation();
        const h0 = track.height;
        pushUndo("track height");
        drag(
          e,
          (dx, dy) => {
            track.height = clamp(h0 + dy, MIN_H, MAX_H);
            head.style.height = `${track.height}px`;
            layout();
            drawTimeline();
          },
          () => changed("tracks"),
        );
      },
    }),
  );
  return head;
}

const armTitle = (track) =>
  `Arm for recording · ${inputLabel(track.input)}${track.monitor ? " · monitoring" : ""} (right-click to change)`;

function setFlag(track, key, value) {
  pushUndo(key);
  track[key] = value;
  engine.updateMix();
  changed("mix");
}

/** Re-stack the headers after a height change without rebuilding them. */
function layout() {
  let y = 0;
  for (const child of host.children) {
    const track = trackById(child.dataset.id);
    if (!track) continue;
    child.style.top = `${y}px`;
    y += track.height;
  }
}

function position() {
  if (!host) return;
  for (const child of host.children) child.style.transform = `translateY(${-view.scrollY}px)`;
}

function highlight() {
  if (!host) return;
  for (const child of host.children) child.classList.toggle("sel", child.dataset.id === state.selectedTrackId);
}

/** Cheap label-only refresh, safe to run while a fader is being dragged. */
function syncLabels() {
  for (const track of state.project.tracks) {
    const r = rows.get(track.id);
    if (r) r.dbLabel.textContent = fmtDb(track.volumeDb);
  }
}

/** Refresh widgets in place. Rebuilding here would yank the fader out from
 *  under a drag started in the mixer, and drop focus from a name field. */
function syncValues() {
  for (const track of state.project.tracks) {
    const r = rows.get(track.id);
    if (!r) continue;
    r.vol.set(track.volumeDb);
    r.dbLabel.textContent = fmtDb(track.volumeDb);
    r.swatch.style.background = track.color;
    if (document.activeElement !== r.name) r.name.value = track.name;
    r.mBtn.classList.toggle("on-m", track.mute);
    r.sBtn.classList.toggle("on-s", track.solo);
    r.rBtn.classList.toggle("on-r", track.armed);
    r.rBtn.title = armTitle(track);
  }
}

/** Called from the UI frame loop. */
export function updateTrackMeters(levels) {
  for (const [id, r] of rows) r.meter.update(levels.get(id)?.peak ?? 0);
}

export { drawTimeline };
