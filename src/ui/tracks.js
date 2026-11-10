// Track headers, kept as DOM (they are mostly widgets) and absolutely
// positioned so a single transform keeps them locked to the canvas scroll.

import { $, el, popupMenu, drag, clamp, coalesce, uid, TRACK_COLORS, fmtDb } from "../util.js";
import { bus, changed, newTrack, pushUndo, state, trackById } from "../state.js";
import { engine } from "../audio/engine.js";
import { DEFAULT_INPUT, input, inputChoices, parseInput, setTrackInput, trackInputLabel } from "../audio/input.js";
import { fader, meterBar } from "./controls.js";
import { registerTracksApi, draw as drawTimeline, view, viewportHeight, zoomTracks } from "./timeline.js";

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
    if (e.altKey) return zoomTracks(Math.pow(1.0015, -(e.deltaY || e.deltaX)), e.clientY - host.getBoundingClientRect().top);
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

/** A palette popover: the preset colours as swatches, plus any colour you like. */
function colourPicker(x, y, track) {
  const set = (c, undoable = true) => {
    if (undoable) pushUndo("track colour");
    track.color = c;
    changed("tracks");
  };
  const menu = popupMenu(x, y, [{ title: "Track colour" }]);
  const grid = el(
    "div.swatch-grid",
    null,
    TRACK_COLORS.map((c) =>
      el(`button.swatch-pick${c.toLowerCase() === String(track.color).toLowerCase() ? ".on" : ""}`, {
        style: { background: c },
        title: c,
        onclick: (e) => {
          e.stopPropagation();
          set(c);
          menu.remove();
        },
      }),
    ),
  );
  let pushed = false;
  const custom = el("input.swatch-custom", {
    type: "color",
    value: /^#[0-9a-f]{6}$/i.test(track.color) ? track.color : "#5cc8ff",
    title: "Any colour",
    // Live while dragging in the picker; one undo step for the whole drag.
    oninput: (e) => {
      set(e.target.value, !pushed);
      pushed = true;
    },
  });
  menu.append(grid, el("label.swatch-row", null, custom, "Custom…"));
}

function trackMenu(track) {
  return [
    { title: track ? track.name : "Tracks" },
    { label: "Add track", sc: "T", onClick: () => addTrack() },
    ...(track ? [{ label: "Colour…", onClick: () => colourPicker(innerWidth / 2 - 80, innerHeight / 3, track) }] : []),
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
  const curKey = input.keyOf(track);
  const sources = input.sources(track);
  const items = ["-"];
  for (const src of sources) {
    // One device: the familiar flat list. Several: a heading per device.
    items.push({ title: sources.length > 1 ? src.label : "Record from" });
    for (const c of inputChoices(src.channels)) {
      items.push({
        label: c.label,
        checked: src.key === curKey && c.value === current,
        onClick: () => {
          pushUndo("track input");
          setTrackInput(track, src.key, c.value);
          changed("mix");
        },
      });
    }
  }
  return [
    ...items,
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
      colourPicker(e.clientX, e.clientY, track);
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
  const dbLabel = el("span.a-meta.db-edit", { title: "Click to type a level (or double-click the fader)", onclick: (e) => (e.stopPropagation(), vol.edit()) }, fmtDb(track.volumeDb));

  const mBtn = toggle("M", track.mute, "on-m", () => setFlag(track, "mute", !track.mute), "Mute");
  const sBtn = toggle("S", track.solo, "on-s", () => setFlag(track, "solo", !track.solo), "Solo");
  const rBtn = toggle("●", track.armed, "on-r", () => setFlag(track, "armed", !track.armed), armTitle(track));
  // Latches when this track's input (while armed) or output reaches full scale.
  const clipBadge = el(
    "button.clip-badge",
    {
      hidden: true,
      title: "Clipped — click to clear",
      onclick: (e) => {
        e.stopPropagation();
        input.resetClips(input.keyOf(track));
        engine.resetClips(track.id);
      },
    },
    "CLIP",
  );
  const row1 = el("div.row1", null, swatch, name, clipBadge, dbLabel);
  const row2 = el("div.row2", null, mBtn, sBtn, rBtn, el("div.minifader", null, vol.root), meter.root);
  rows.set(track.id, { swatch, name, dbLabel, meter, vol, mBtn, sBtn, rBtn, clipBadge });

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
  `Arm for recording · ${trackInputLabel(track)}${track.monitor ? " · monitoring" : ""} (right-click to change)`;

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
/**
 * Armed tracks meter their *input* — what is about to be recorded, before the
 * fader — so levels can be set with the app's monitoring off (listening
 * through the interface instead). Everything else meters its output.
 */
export function updateTrackMeters(levels) {
  const byDevice = new Map();
  for (const [id, r] of rows) {
    const t = trackById(id);
    const dev = t?.armed ? input.deviceOf(t) : null;
    let peak;
    let clip;
    if (dev) {
      if (!byDevice.has(dev.key)) byDevice.set(dev.key, dev.levels());
      const lv = byDevice.get(dev.key);
      const chans = parseInput(t.input, dev.channels);
      peak = Math.max(...chans.map((c) => lv[c] ?? 0));
      clip = chans.some((c) => dev.clip[c]);
    } else {
      peak = levels.get(id)?.peak ?? 0;
      clip = engine.clips.has(id);
    }
    r.meter.update(peak);
    if (r.clipBadge.hidden === clip) {
      r.clipBadge.hidden = !clip;
      r.clipBadge.title = dev
        ? "The input hit full scale — lower the gain on your interface (the fader can't undo it). Click to clear."
        : "This track went over 0 dBFS — pull its fader or clip gain down. Click to clear.";
    }
  }
}

export { drawTimeline };
