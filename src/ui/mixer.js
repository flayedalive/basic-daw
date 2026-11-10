// Mixer: one strip per track plus master, each with its insert chain, pan,
// fader and meter. Strips are built once and updated in place; only a change
// to the track list or an insert chain rebuilds them.

import { $, el, coalesce, popupMenu, fmtDb, clamp } from "../util.js";
import { analyzerPanel, updateAnalyzer } from "./analyzer.js";
import { bus, changed, pushUndo, state, trackById } from "../state.js";
import { engine } from "../audio/engine.js";
import { labelOf, newEffect, pluginsByCategory } from "../plugins/registry.js";
import { fader, knob, parsePan } from "./controls.js";
import { showInspector } from "./inspector.js";

let host;
const strips = new Map(); // id ("master" | trackId) -> handles

export function initMixer() {
  host = $("#mixer-strips");
  $("#btn-mixer-toggle").addEventListener("click", toggleMixer);
  const refresh = coalesce(render);
  bus.on("tracks", refresh);
  bus.on("project", refresh);
  bus.on("mix", coalesce(syncValues));
  bus.on("mixlive", syncLabels);
  bus.on("mixfocus", highlight);
  bus.on("selection", highlight);
  render();
}

export function toggleMixer(force) {
  const app = $("#app");
  const collapsed = force ?? !app.classList.contains("mixer-collapsed");
  app.classList.toggle("mixer-collapsed", collapsed);
  $("#btn-mixer-toggle").textContent = collapsed ? "▴" : "▾";
  requestAnimationFrame(() => bus.emit("view"));
}

function render() {
  if (!host) return;
  host.replaceChildren();
  strips.clear();
  for (const track of state.project.tracks) host.append(buildStrip(track.id));
  host.append(buildStrip("master"), analyzerPanel());
  highlight();
}

function target(id) {
  return id === "master" ? state.project.master : trackById(id);
}

function buildStrip(id) {
  const isMaster = id === "master";
  const t = target(id);
  if (!t) return el("div");

  const name = el("div.s-name", {
    style: isMaster ? { color: "#8a90a4" } : { color: t.color },
    title: isMaster ? "Master bus" : "Click to focus, double-click to rename",
    textContent: isMaster ? "MASTER" : t.name,
    onclick: () => focus(id),
    ondblclick: () => {
      if (isMaster) return;
      const v = prompt("Track name", t.name);
      if (v == null) return;
      pushUndo("rename track");
      t.name = v;
      changed("tracks");
    },
  });

  const fxBox = el("div.s-fx");
  const renderFx = () => {
    fxBox.replaceChildren();
    (t.fx ?? []).forEach((def, i) => {
      const slot = el(
        `div.fx-slot${def.on === false ? ".bypassed" : ""}`,
        {
          title: `${labelOf(def.type)} — click to edit, right-click for options`,
          onclick: () => {
            focus(id);
            showInspector({ kind: "fx", ownerId: id, fxId: def.id });
          },
          oncontextmenu: (e) => {
            e.preventDefault();
            popupMenu(e.clientX, e.clientY, fxMenu(id, i));
          },
        },
        el("span.fx-name", null, labelOf(def.type)),
      );
      fxBox.append(slot);
    });
    fxBox.append(
      el("div.fx-add", { onclick: (e) => popupMenu(e.clientX, e.clientY, addFxMenu(id)), textContent: "+ insert" }),
    );
  };
  renderFx();

  const meterL = el("i");
  const meterR = el("i");
  const meter = el(
    "div.s-meter",
    null,
    el("div.meter-ch", null, meterL),
    isMaster ? el("div.meter-ch", null, meterR) : null,
  );

  const dbLabel = el("div.s-db.db-edit", { title: "Click to type a level (or double-click the fader)", onclick: () => vol.edit() }, fmtDb(t.volumeDb));
  const vol = fader({
    value: t.volumeDb,
    width: 30,
    height: 84,
    onInput: (db) => {
      t.volumeDb = db;
      dbLabel.textContent = fmtDb(db);
      engine.updateMix();
      bus.emit("mixlive");
    },
    onChange: () => changed("mix"),
  });

  const pan = isMaster
    ? null
    : knob({
        label: "pan",
        value: t.pan,
        min: -1,
        max: 1,
        def: 0,
        size: 24,
        format: (v) => (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`),
        parse: parsePan,
        onInput: (v) => {
          t.pan = v;
          engine.updateMix();
        },
        onChange: () => changed("mix"),
      });

  const mBtn = isMaster
    ? null
    : el(
        `button.tgl${t.mute ? ".on-m" : ""}`,
        { title: "Mute", onclick: () => flag(t, "mute") },
        "M",
      );
  const sBtn = isMaster
    ? null
    : el(
        `button.tgl${t.solo ? ".on-s" : ""}`,
        { title: "Solo", onclick: () => flag(t, "solo") },
        "S",
      );

  const clipLed = el(
    "button.clip-led",
    {
      title: isMaster
        ? "Lights when the master reaches 0 dBFS — that clips at the interface and in a 16/24-bit bounce. Click to clear."
        : "Lights when this track goes over 0 dBFS. Click to clear.",
      onclick: (e) => {
        e.stopPropagation();
        engine.resetClips(id);
      },
    },
    "CLIP",
  );
  const mid = el("div.s-mid", null, el("div.s-fader", null, vol.root), meter);
  // The strip is a flex column inside a resizable panel: let the fader take
  // whatever height is left rather than overflowing when the mixer is short.
  new ResizeObserver(() => vol.resize(30, Math.max(30, mid.clientHeight))).observe(mid);

  const root = el(
    `div.strip${isMaster ? ".master" : ""}`,
    { dataset: { id }, onpointerdown: () => focus(id) },
    name,
    fxBox,
    clipLed,
    mid,
    dbLabel,
    el("div.s-row", null, mBtn, sBtn, pan?.root),
  );

  strips.set(id, { root, name, vol, dbLabel, meterL, meterR, mBtn, sBtn, pan, renderFx, clipLed, shown: 0, shownR: 0 });
  return root;
}

function flag(t, key) {
  pushUndo(key);
  t[key] = !t[key];
  engine.updateMix();
  changed("mix");
}

function focus(id) {
  state.focusedStrip = id;
  if (id !== "master") state.selectedTrackId = id;
  bus.emit("mixfocus");
  showInspector({ kind: id === "master" ? "master" : "track", id });
}

function highlight() {
  for (const [id, s] of strips) s.root.classList.toggle("sel", id === state.focusedStrip);
}

function syncLabels() {
  for (const [id, s] of strips) {
    const t = target(id);
    if (t) s.dbLabel.textContent = fmtDb(t.volumeDb);
  }
}

function syncValues() {
  for (const [id, s] of strips) {
    const t = target(id);
    if (!t) continue;
    s.vol.set(t.volumeDb);
    s.dbLabel.textContent = fmtDb(t.volumeDb);
    if (s.pan) s.pan.set(t.pan);
    s.mBtn?.classList.toggle("on-m", !!t.mute);
    s.sBtn?.classList.toggle("on-s", !!t.solo);
    if (id !== "master") s.name.textContent = t.name;
    s.renderFx();
  }
}

/* ── insert chain menus ───────────────────────────────────────────────── */

function addFxMenu(ownerId) {
  const add = (type) => {
    const t = target(ownerId);
    pushUndo("add insert");
    t.fx.push(newEffect(type));
    applyChain(ownerId);
    showInspector({ kind: "fx", ownerId, fxId: t.fx.at(-1).id });
  };
  return [
    { title: "Add insert" },
    ...pluginsByCategory().flatMap(([category, list]) => [
      { title: category },
      ...list.map((p) => ({ label: p.name, onClick: () => add(p.id) })),
    ]),
    "-",
    { label: "Manage plugins…", onClick: () => import("./plugins.js").then((m) => m.pluginManager()) },
  ];
}

function fxMenu(ownerId, index) {
  const t = target(ownerId);
  const def = t.fx[index];
  return [
    { title: labelOf(def.type) },
    {
      label: def.on === false ? "Enable" : "Bypass",
      onClick: () => {
        pushUndo("bypass insert");
        def.on = def.on === false;
        applyChain(ownerId);
      },
    },
    {
      label: "Move up",
      disabled: index === 0,
      onClick: () => {
        pushUndo("reorder inserts");
        t.fx.splice(index - 1, 0, t.fx.splice(index, 1)[0]);
        applyChain(ownerId);
      },
    },
    {
      label: "Move down",
      disabled: index === t.fx.length - 1,
      onClick: () => {
        pushUndo("reorder inserts");
        t.fx.splice(index + 1, 0, t.fx.splice(index, 1)[0]);
        applyChain(ownerId);
      },
    },
    "-",
    {
      label: "Remove",
      onClick: () => {
        pushUndo("remove insert");
        t.fx.splice(index, 1);
        applyChain(ownerId);
      },
    },
  ];
}

/** Rebuild the audio chain for one strip and refresh its slot list. */
export function applyChain(ownerId) {
  engine.syncGraph();
  engine.updateMix();
  changed("mix");
}

/* ── metering ─────────────────────────────────────────────────────────── */

const METER_FLOOR = 60;
const meterPct = (peak) => (peak <= 0.0001 ? 0 : clamp(1 + (20 * Math.log10(peak)) / METER_FLOOR, 0, 1));

export function updateMixerMeters(levels) {
  updateAnalyzer();
  for (const [id, s] of strips) {
    const lv = levels.get(id);
    if (!lv) continue;
    const clip = engine.clips.has(id);
    if (s.clipLed.classList.contains("on") !== clip) s.clipLed.classList.toggle("on", clip);
    const l = meterPct(lv.peak);
    s.shown = l > s.shown ? l : s.shown * 0.86;
    s.meterL.style.height = `${(s.shown * 100).toFixed(1)}%`;
    if (id === "master") {
      const r = meterPct(lv.peakR);
      s.shownR = r > s.shownR ? r : s.shownR * 0.86;
      s.meterR.style.height = `${(s.shownR * 100).toFixed(1)}%`;
    }
  }
}
