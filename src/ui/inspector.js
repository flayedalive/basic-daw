// Right-hand inspector. One panel, four modes: clip, track, master, effect.
// Effect parameter rows are generated from the plugin's `params` block, so a
// plugin — built-in, bundled or JSON you wrote — gets a full editor for free.
// The mapping from a parameter's fields to a widget is documented in
// docs/ui-components.md.

import { $, el, clamp, coalesce, dialog, fmtDb, fmtDur, toast, popupMenu } from "../util.js";
import {
  assets,
  bus,
  changed,
  clipById,
  clipMaxDuration,
  clipSourceRate,
  pushUndo,
  state,
  trackById,
  projectDuration,
} from "../state.js";
import { engine } from "../audio/engine.js";
import { DEFAULT_INPUT, input, inputChoices, inputLabel, setTrackInput } from "../audio/input.js";
import { defaultParams, getPlugin, labelOf, newEffect, pluginsByCategory, resolveId } from "../plugins/registry.js";
import { sliderRow, parseDb, parsePan } from "./controls.js";
import { drawPeaks } from "../audio/peaks.js";
import { tunerDisplay } from "./tuner.js";
import { geqView } from "./geq.js";
import { STRETCH_MODES } from "../audio/stretch.js";
import { stretchProgress } from "../audio/clipaudio.js";
import { GEQ31_BANDS, GEQ31_Q } from "../plugins/geq31.js";

let body, titleEl;
let mode = { kind: "none" };

export function initInspector() {
  body = $("#insp-body");
  titleEl = $("#insp-title");
  bus.on("selection", () => {
    // Following the selection is what makes the panel feel like part of the
    // arrangement rather than a separate screen.
    if (state.selection.size >= 1) {
      const id = [...state.selection][0];
      if (mode.kind !== "clip" || mode.id !== id) showInspector({ kind: "clip", id });
      else render();
    } else if (mode.kind === "clip") {
      showInspector({ kind: "none" });
    }
  });
  const refresh = coalesce(render);
  bus.on("clips", refresh);
  bus.on("mix", refresh);
  bus.on("tracks", refresh);
  bus.on("project", refresh);
  bus.on("assets", refresh);
  bus.on("stretch", refresh);
  bus.on("audioinput", () => mode.kind === "track" && refresh());
  render();
}

export function showInspector(next) {
  mode = next;
  render();
}

function render() {
  if (!body) return;
  const scroll = body.scrollTop;
  body.replaceChildren();
  switch (mode.kind) {
    case "clip":
      renderClip();
      break;
    case "track":
      renderTrack(trackById(mode.id));
      break;
    case "master":
      renderMaster();
      break;
    case "fx":
      renderFx();
      break;
    default:
      renderNone();
  }
  body.scrollTop = scroll;
}

function section(title, ...children) {
  const head = el("h3", null, title);
  return el("div.sec", null, head, el("div.sec-body", null, ...children));
}

function row(label, ...children) {
  return el("div.prow", null, el("label", null, label), ...children);
}

/* ── nothing selected ─────────────────────────────────────────────────── */

function renderNone() {
  titleEl.textContent = "Project";
  const p = state.project;
  const used = new Set(p.clips.map((c) => c.assetId));
  body.append(
    section(
      "Session",
      row("Name", el("input.txt.grow", { value: p.name, onchange: (e) => rename(e.target.value) })),
      row("Length", el("span.val", null, fmtDur(projectDuration()))),
      row("Tracks", el("span.val", null, String(p.tracks.length))),
      row("Clips", el("span.val", null, String(p.clips.length))),
      row("Pool", el("span.val", null, `${assets.size} (${used.size} used)`)),
      row("Engine", el("span.val", null, engine.ctx ? `${(engine.sampleRate / 1000).toFixed(1)} kHz` : "idle")),
    ),
    section(
      "Getting started",
      el(
        "div.insp-empty",
        null,
        "Drop stems onto the arrangement, or into the pool on the left. ",
        "Drag clip edges to trim, the top corners to fade. ",
        "Double-click a clip to loop it. Press ? for the full key map.",
      ),
    ),
  );
}

function rename(v) {
  pushUndo("rename project");
  state.project.name = v;
  changed("project");
}

/* ── clip ─────────────────────────────────────────────────────────────── */

function renderClip() {
  const clip = clipById(mode.id) ?? clipById([...state.selection][0]);
  if (!clip) return renderNone();
  const many = state.selection.size > 1;
  titleEl.textContent = many ? `${state.selection.size} clips` : "Clip";
  const asset = assets.get(clip.assetId);

  const each = (fn, label) => {
    pushUndo(label);
    for (const c of state.project.clips) if (state.selection.has(c.id)) fn(c);
    changed("clips");
    engine.invalidate();
  };

  const canvas = el("canvas.clipwave");
  requestAnimationFrame(() => paintClipWave(canvas, clip, asset));

  body.append(
    section(
      many ? "Common" : clip.name,
      canvas,
      row(
        "Name",
        el("input.txt.grow", {
          value: clip.name,
          onchange: (e) => each((c) => (c.name = e.target.value), "rename clip"),
        }),
      ),
      row("Source", el("span.val", null, asset ? asset.name : "missing")),
      row(
        "Position",
        numField(clip.start, 0.001, (v) => each((c) => (c.start = Math.max(0, v)), "move clip")),
        el("span.val", null, "s"),
      ),
      row(
        "Length",
        numField(clip.duration, 0.001, (v) => each((c) => (c.duration = clamp(v, 0.02, clipMaxDuration(c))), "resize clip")),
        el("span.val", null, "s"),
      ),
      row(
        "Src offset",
        numField(clip.offset, 0.001, (v) =>
          each((c) => (c.offset = clamp(v, 0, (assets.get(c.assetId)?.duration ?? 0) - 0.02)), "clip offset"),
        ),
        el("span.val", null, "s"),
      ),
    ),
    section(
      "Level & fades",
      sliderRow({
        label: "Gain",
        value: clip.gainDb,
        min: -48,
        max: 12,
        def: 0,
        format: (v) => `${fmtDb(v)} dB`, parse: parseDb,
        onInput: (v) => {
          for (const c of state.project.clips) if (state.selection.has(c.id)) c.gainDb = v;
          changed("clips", false);
        },
        onChange: (v) => each((c) => (c.gainDb = v), "clip gain"),
      }).root,
      sliderRow({
        label: "Fade in",
        value: clip.fadeIn,
        min: 0,
        max: Math.max(0.5, clip.duration),
        def: 0.005,
        prec: 3,
        unit: " s",
        onChange: (v) => each((c) => (c.fadeIn = clamp(v, 0, c.duration)), "fade in"),
      }).root,
      sliderRow({
        label: "Fade out",
        value: clip.fadeOut,
        min: 0,
        max: Math.max(0.5, clip.duration),
        def: 0.005,
        prec: 3,
        unit: " s",
        onChange: (v) => each((c) => (c.fadeOut = clamp(v, 0, c.duration)), "fade out"),
      }).root,
      row(
        "Shape",
        select(["equal", "linear", "exp"], clip.fadeShape, (v) => each((c) => (c.fadeShape = v), "fade shape")),
      ),
    ),
    section(
      "Pitch & speed",
      sliderRow({
        label: "Rate",
        value: clip.rate,
        min: 0.25,
        max: 4,
        def: 1,
        log: true,
        prec: 3,
        unit: "×",
        onChange: (v) => each((c) => setClipRate(c, v), "clip rate"),
      }).root,
      // The same setting, the two other ways people think about it.
      row(
        "Length",
        numField(100 / clip.rate, 0.1, (v) => each((c) => setClipRate(c, 100 / clamp(v || 100, 25, 400)), "clip rate")),
        el("span.val", null, "%"),
      ),
      row(
        "Source BPM",
        numField(state.project.bpm / clip.rate, 0.01, (v) => each((c) => setClipRate(c, state.project.bpm / clamp(v || state.project.bpm, 20, 999)), "clip rate")),
        el("span.val", { title: "The tempo this clip was recorded at, if it now sits in time with the project" }, `→ ${state.project.bpm}`),
      ),
      sliderRow({
        label: "Pitch",
        value: (clip.detune || 0) / 100,
        min: -24,
        max: 24,
        def: 0,
        prec: 2,
        unit: " st",
        onChange: (v) => each((c) => (c.detune = Math.round(v * 100)), "pitch"),
      }).root,
      row(
        "Pitch lock",
        el("input", {
          type: "checkbox",
          checked: !!clip.pitchLock,
          title: "On: Rate changes length only and Pitch changes pitch only (time stretch). Off: they are one resampling and move together, like tape.",
          onchange: (e) =>
            each((c) => {
              // Keep what the clip covers in the source: with the lock off, pitch is part of the speed.
              const srcLen = c.duration * clipSourceRate(c);
              c.pitchLock = e.target.checked;
              c.duration = clamp(srcLen / clipSourceRate(c), 0.02, clipMaxDuration(c));
            }, "pitch lock"),
        }),
        clip.pitchLock
          ? select(STRETCH_MODES, clip.stretchMode ?? "auto", (v) => each((c) => (c.stretchMode = v), "stretch mode"))
          : el("span.val", { title: "Pitch follows speed, like tape" }, "off"),
      ),
      stretchNote(clip),
      el(
        "div.btnrow",
        null,
        btn(clip.reverse ? "Un-reverse" : "Reverse", () => each((c) => (c.reverse = !c.reverse), "reverse")),
        btn(clip.mute ? "Unmute" : "Mute", () => each((c) => (c.mute = !c.mute), "mute clip")),
        btn("Match tempo…", () => matchTempo(clip)),
      ),
    ),
    section(
      "Actions",
      el(
        "div.btnrow",
        null,
        btn("Split at playhead", async () => (await import("./timeline.js")).splitSelection(state.playhead)),
        btn("Duplicate", async () => (await import("./timeline.js")).duplicateSelection()),
        btn("Loop over", async () => (await import("./timeline.js")).setLoopToSelection()),
        btn("Normalize gain", () => normalizeClipGain()),
        btn("Edit pitch…", async () => (await import("./pitcheditor.js")).openPitchEditor(clip)),
        btn("Delete", async () => (await import("./timeline.js")).deleteSelection(), true),
      ),
    ),
  );
}

function paintClipWave(canvas, clip, asset) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || 220;
  const h = 64;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#0d0f14";
  c.fillRect(0, 0, w, h);
  if (!asset?.peaks) {
    c.fillStyle = "#8a90a4";
    c.font = "10px ui-monospace, monospace";
    c.fillText(asset?.missing ? "source missing" : "no waveform", 6, h / 2);
    return;
  }
  const sr = asset.peaks.sampleRate;
  c.fillStyle = "#2c3142";
  drawPeaks(c, asset.peaks, 0, asset.peaks.frames, 0, 0, w, h);
  // Highlight the part of the source this clip uses.
  const effRate = clipSourceRate(clip);
  const x0 = (clip.offset / asset.duration) * w;
  const x1 = ((clip.offset + clip.duration * effRate) / asset.duration) * w;
  c.save();
  c.beginPath();
  c.rect(x0, 0, Math.max(1, x1 - x0), h);
  c.clip();
  c.fillStyle = "#5cc8ff";
  drawPeaks(c, asset.peaks, 0, asset.peaks.frames, 0, 0, w, h);
  c.restore();
  c.strokeStyle = "#5cc8ff";
  c.strokeRect(x0 + 0.5, 0.5, Math.max(1, x1 - x0 - 1), h - 1);
}

function normalizeClipGain() {
  const sel = state.project.clips.filter((c) => state.selection.has(c.id));
  if (!sel.length) return;
  pushUndo("normalize clip gain");
  for (const c of sel) {
    const a = assets.get(c.assetId);
    if (!a?.peak) continue;
    c.gainDb = clamp(-0.5 - 20 * Math.log10(a.peak), -24, 24);
  }
  changed("clips");
  engine.invalidate();
  toast("Clip gain set for -0.5 dB peak", "ok");
}

/** Change a clip's rate, keeping the stretch of source it covers: the timeline length follows. */
function setClipRate(c, rate) {
  const srcLen = c.duration * c.rate;
  c.rate = clamp(rate, 0.25, 4);
  c.duration = clamp(srcLen / c.rate, 0.02, clipMaxDuration(c));
}

/** One line under the pitch controls saying what a pitch-locked clip is doing. */
function stretchNote(clip) {
  if (!clip.pitchLock) return null;
  const p = stretchProgress(clip);
  const modes = { auto: "picked from the material", mono: "one voice or instrument (WSOLA)", poly: "chords and mixes (phase vocoder)", drums: "slices at the hits", vocal: "one voice, formants kept (PSOLA)" };
  const text =
    p === null
      ? `Mode: ${modes[clip.stretchMode ?? "auto"]}. Nothing to stretch at rate 1 and pitch 0.`
      : p < 1
        ? `Rendering the stretch… ${Math.round(p * 100)}%. Until it is done the clip plays resampled, so its pitch is off.`
        : `Mode: ${modes[clip.stretchMode ?? "auto"]}.`;
  return el("div.insp-empty", null, text);
}

/** Fit the clip to a whole number of bars — by stretching it, or by resampling like tape. */
function matchTempo(clip) {
  let bars = 4;
  let keepPitch = true;
  const barSec = (60 / state.project.bpm) * state.project.sigNum;
  dialog(
    "Match tempo",
    (body) => {
      const guess = Math.max(1, Math.round(clip.duration / barSec));
      bars = guess;
      body.append(
        row(
          "Fit to",
          el("input.num", { type: "number", min: 0.25, step: 1, value: guess, onchange: (e) => (bars = Number(e.target.value)) }),
          el("span.val", null, `bars at ${state.project.bpm} BPM`),
        ),
        row(
          "Keep pitch",
          el("input", { type: "checkbox", checked: true, onchange: (e) => (keepPitch = e.target.checked) }),
          el("span.val", null, "time stretch, rather than resample"),
        ),
      );
    },
    [
      { label: "Cancel" },
      {
        label: "Match",
        primary: true,
        onClick: () => {
          if (!Number.isFinite(bars) || bars <= 0) return false;
          const targetLen = bars * barSec;
          pushUndo("match tempo");
          const srcLen = clip.duration * clipSourceRate(clip);
          if (keepPitch) clip.pitchLock = true;
          // What is left of the speed once any (unlocked) detune has had its share.
          const pitchPart = clipSourceRate(clip) / clip.rate;
          clip.rate = clamp(srcLen / targetLen / pitchPart, keepPitch ? 0.25 : 0.05, keepPitch ? 4 : 8);
          clip.duration = srcLen / clipSourceRate(clip);
          changed("clips");
          engine.invalidate();
          toast(`${(100 / clip.rate).toFixed(1)}% · ${bars} bars${keepPitch ? " · pitch kept" : ""}`, "ok");
        },
      },
    ],
  );
}

/* ── track / master ───────────────────────────────────────────────────── */

function renderTrack(track) {
  if (!track) return renderNone();
  titleEl.textContent = track.name;
  body.append(
    section(
      "Track",
      row(
        "Name",
        el("input.txt.grow", {
          value: track.name,
          onchange: (e) => {
            pushUndo("rename track");
            track.name = e.target.value;
            changed("tracks");
          },
        }),
      ),
      row(
        "Colour",
        el(
          "div.btnrow",
          null,
          ...["#5cc8ff", "#ffb454", "#7ee081", "#ff6b9d", "#b48cff", "#4fd6c8"].map((c) =>
            el("button.mini", {
              style: { background: c, width: "18px" },
              onclick: () => {
                pushUndo("track colour");
                track.color = c;
                changed("tracks");
              },
            }),
          ),
        ),
      ),
      sliderRow({
        label: "Volume",
        value: track.volumeDb,
        min: -60,
        max: 6,
        def: 0,
        format: (v) => `${fmtDb(v)} dB`, parse: parseDb,
        onInput: (v) => {
          track.volumeDb = v;
          engine.updateMix();
        },
        onChange: () => changed("mix"),
      }).root,
      sliderRow({
        label: "Pan",
        value: track.pan,
        min: -1,
        max: 1,
        def: 0,
        format: (v) => (Math.abs(v) < 0.02 ? "centre" : `${v < 0 ? "L" : "R"} ${Math.round(Math.abs(v) * 100)}`), parse: parsePan,
        onInput: (v) => {
          track.pan = v;
          engine.updateMix();
        },
        onChange: () => changed("mix"),
      }).root,
      el(
        "div.btnrow",
        null,
        btn(track.mute ? "Unmute" : "Mute", () => toggleTrack(track, "mute")),
        btn(track.solo ? "Unsolo" : "Solo", () => toggleTrack(track, "solo")),
        btn(track.armed ? "Disarm" : "Arm", () => toggleTrack(track, "armed")),
      ),
    ),
    recordingSection(track),
    chainSection(track.id, track),
  );
}

function renderMaster() {
  titleEl.textContent = "Master";
  const m = state.project.master;
  body.append(
    section(
      "Master bus",
      sliderRow({
        label: "Volume",
        value: m.volumeDb,
        min: -60,
        max: 6,
        def: 0,
        format: (v) => `${fmtDb(v)} dB`, parse: parseDb,
        onInput: (v) => {
          m.volumeDb = v;
          engine.updateMix();
        },
        onChange: () => changed("mix"),
      }).root,
    ),
    chainSection("master", m),
  );
}

/** Which interface input feeds the track, and whether you hear it while armed. */
function recordingSection(track) {
  const current = String(track.input ?? DEFAULT_INPUT);
  const curKey = input.keyOf(track);
  const sources = input.sources(track);
  // Option values carry both halves: "<device key>|<inputs>".
  const sel = el("select.select.grow", {
    onchange: (e) => {
      const [key, spec] = splitChoice(e.target.value);
      pushUndo("track input");
      setTrackInput(track, key, spec);
      changed("mix");
    },
  });
  let found = false;
  for (const src of sources) {
    const choices = inputChoices(src.channels);
    const opts = choices.map((c) => {
      const on = src.key === curKey && c.value === current;
      found ||= on;
      return el("option", { value: `${src.key}|${c.value}`, selected: on }, c.label);
    });
    if (sources.length > 1) sel.append(el("optgroup", { label: src.label }, opts));
    else sel.append(...opts);
  }
  // A session from a machine with more inputs: keep its choice visible.
  if (!found) {
    sel.append(el("option", { value: `${curKey}|${current}`, selected: true }, `${inputLabel(current)} — not on this device`));
  }

  const mon = el("input", {
    type: "checkbox",
    checked: !!track.monitor,
    onchange: (e) => {
      pushUndo("monitor");
      track.monitor = e.target.checked;
      if (track.monitor) toast("Monitoring on — use headphones to avoid feedback", "", 3500);
      changed("mix");
    },
  });

  return section(
    "Recording",
    row("Input", sel),
    row("Monitor", mon, el("span.a-meta", null, track.armed ? "hear the input through this track" : "heard once the track is armed")),
    el(
      "div.btnrow",
      null,
      btn("Audio setup…", () => import("./audio-setup.js").then((m) => m.audioSetup())),
    ),
  );
}

/** "<key>|<spec>" → [key, spec]. Device ids never contain "|"; specs never do either. */
function splitChoice(v) {
  const i = v.lastIndexOf("|");
  return [v.slice(0, i), v.slice(i + 1)];
}

function toggleTrack(track, key) {
  pushUndo(key);
  track[key] = !track[key];
  engine.updateMix();
  changed("mix");
}

function chainSection(ownerId, owner) {
  const list = el("div.sec-body");
  (owner.fx ?? []).forEach((def, i) => {
    list.append(
      el(
        `div.fx-slot${def.on === false ? ".bypassed" : ""}`,
        {
          onclick: () => showInspector({ kind: "fx", ownerId, fxId: def.id }),
          oncontextmenu: (e) => {
            e.preventDefault();
            popupMenu(e.clientX, e.clientY, [
              {
                label: def.on === false ? "Enable" : "Bypass",
                onClick: () => {
                  pushUndo("bypass insert");
                  def.on = def.on === false;
                  engine.syncGraph();
                  changed("mix");
                },
              },
              {
                label: "Remove",
                onClick: () => {
                  pushUndo("remove insert");
                  owner.fx.splice(i, 1);
                  engine.syncGraph();
                  changed("mix");
                },
              },
            ]);
          },
        },
        el("span.fx-name", null, labelOf(def.type)),
        el("span.a-meta", null, "▸"),
      ),
    );
  });
  list.append(
    el("div.fx-add", {
      textContent: "+ add insert",
      onclick: (e) =>
        popupMenu(e.clientX, e.clientY, [
          ...pluginsByCategory().flatMap(([category, list]) => [
            { title: category },
            ...list.map((p) => ({
              label: p.name,
              onClick: () => {
                pushUndo("add insert");
                owner.fx.push(newEffect(p.id));
                engine.syncGraph();
                changed("mix");
                showInspector({ kind: "fx", ownerId, fxId: owner.fx.at(-1).id });
              },
            })),
          ]),
          "-",
          { label: "Manage plugins…", onClick: () => import("./plugins.js").then((m) => m.pluginManager()) },
        ]),
    }),
  );
  return el("div.sec", null, el("h3", null, "Inserts"), list);
}

/* ── effect editor ────────────────────────────────────────────────────── */

/** The 10-band graphic EQ's bands (bundled/geq10.json), for its response curve. */
const GEQ10_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((hz) => {
  const label = hz >= 1000 ? `${hz / 1000}k` : String(Math.floor(hz));
  return { key: `hz${label}`, hz, label };
});

function renderFx() {
  const owner = mode.ownerId === "master" ? state.project.master : trackById(mode.ownerId);
  const def = owner?.fx.find((f) => f.id === mode.fxId);
  if (!def) return renderNone();
  const plugin = getPlugin(def.type);
  if (!plugin) return renderMissingFx(owner, def);
  titleEl.textContent = plugin.name;

  const kind = resolveId(def.type);
  // Custom views. A plugin declares parameters and the inspector draws them;
  // these few are deliberate exceptions, mounted by plugin id.
  const custom = [];
  const hidden = new Set(); // parameters a custom view edits instead of a row
  if (kind === "core.geq31" || kind === "json.geq10") {
    const bands = kind === "core.geq31" ? GEQ31_BANDS : GEQ10_BANDS;
    const bank = kind === "core.geq31";
    if (bank) for (const b of bands) hidden.add(b.key);
    let began = false;
    custom.push(
      geqView({
        bands,
        q: bank ? GEQ31_Q : 1.414,
        params: def.params,
        interactive: bank,
        // One undo step per gesture, however many bands the drag crosses. The
        // panel is not re-rendered until the gesture ends: the view repaints
        // itself, and a re-render would drop the canvas mid-drag.
        onBegin: () => {
          if (!began) pushUndo("graphic EQ");
          began = true;
        },
        onInput: (key, db) => setParam(def, key, db, false),
        onChange: (key, db) => {
          def.params[key] = db;
          engine.updateMix();
          began = false;
          changed("mix", true);
        },
      }),
    );
  }

  const rows = [];
  for (const p of plugin.params) {
    if (hidden.has(p.key)) continue;
    if (p.choices) {
      rows.push(row(p.label, select(p.choices, def.params[p.key], (v) => setParam(def, p.key, v))));
    } else if (p.bool) {
      rows.push(
        row(
          p.label,
          el("input", {
            type: "checkbox",
            checked: !!def.params[p.key],
            onchange: (e) => setParam(def, p.key, e.target.checked),
          }),
        ),
      );
    } else if (p.asset) {
      rows.push(assetRow(p, def));
    } else {
      rows.push(
        sliderRow({
          label: p.label,
          value: def.params[p.key] ?? p.def,
          min: p.min,
          max: p.max,
          def: p.def,
          log: p.log,
          prec: p.prec,
          unit: p.unit ? ` ${p.unit}` : "",
          onInput: (v) => setParam(def, p.key, v, false),
          onChange: (v) => setParam(def, p.key, v),
        }).root,
      );
    }
    // A parameter can carry a one-line note; it is the only prose a plugin
    // author gets, so it renders right under the control it explains.
    if (p.hint) rows.push(el("div.insp-empty.p-hint", null, p.hint));
  }

  const head = el(
    "div.btnrow",
    null,
    btn(def.on === false ? "Enable" : "Bypass", () => {
      pushUndo("bypass insert");
      def.on = def.on === false;
      engine.syncGraph();
      changed("mix");
    }),
    btn("Reset", () => {
      pushUndo("reset insert");
      def.params = defaultParams(def.type);
      engine.updateMix();
      changed("mix");
    }),
    btn("Remove", () => {
      pushUndo("remove insert");
      owner.fx = owner.fx.filter((f) => f.id !== def.id);
      engine.syncGraph();
      changed("mix");
      showInspector({ kind: mode.ownerId === "master" ? "master" : "track", id: mode.ownerId });
    }, true),
    btn("◂ back", () => showInspector({ kind: mode.ownerId === "master" ? "master" : "track", id: mode.ownerId })),
  );

  const parts = [head];
  if (plugin.description) parts.push(el("div.insp-empty", null, plugin.description));
  if (kind === "core.eq" || kind === "core.filter") {
    const canvas = el("canvas.eq-canvas");
    parts.push(canvas);
    // No listener here: the panel already re-renders on "mix", and a
    // subscription per render would pile up one leak per click.
    requestAnimationFrame(() => paintResponse(canvas, def));
  }
  if (kind === "core.tuner") parts.push(tunerDisplay(mode.ownerId, def.id));
  if (plugin.category === "Dynamics") parts.push(reductionMeter(mode.ownerId, def.id));
  body.append(section(plugin.name, ...parts, ...custom, ...rows));
}

/**
 * An insert whose plugin is not registered. Audio passes through untouched and
 * the stored parameters are shown read-only, because they are what makes the
 * effect recoverable — install the plugin and the insert comes back exactly as
 * it was saved.
 */
function renderMissingFx(owner, def) {
  titleEl.textContent = "Missing plugin";
  body.append(
    section(
      def.type,
      el("div.insp-empty", null, `No plugin is registered for "${def.type}".`),
      el(
        "div.insp-empty",
        null,
        "This insert is passing audio through unchanged. Its settings are kept, so installing the plugin restores it.",
      ),
      el("pre.fx-dump", null, JSON.stringify(def.params ?? {}, null, 2)),
      el(
        "div.btnrow",
        null,
        btn("Install plugin…", () => import("./plugins.js").then((m) => m.pluginManager())),
        btn(
          "Remove insert",
          () => {
            pushUndo("remove insert");
            owner.fx = owner.fx.filter((f) => f.id !== def.id);
            engine.syncGraph();
            changed("mix");
            showInspector({ kind: mode.ownerId === "master" ? "master" : "track", id: mode.ownerId });
          },
          true,
        ),
        btn("◂ back", () => showInspector({ kind: mode.ownerId === "master" ? "master" : "track", id: mode.ownerId })),
      ),
    ),
  );
}

/**
 * Gain-reduction meter for a dynamics plugin: whatever its live instance's
 * `readout()` reports, in dB (0 = not working, negative = turning down).
 * Reads the engine's instance each frame, so it survives chain rebuilds, and
 * stops by itself when the panel is re-rendered.
 */
function reductionMeter(ownerId, fxId) {
  const fill = el("i");
  const val = el("span.val", null, "0.0 dB");
  const root = el("div.prow", { title: "Gain reduction" }, el("label", null, "Reduction"), el("div.gr-meter", null, fill), val);
  let shown = 0;
  const frame = () => {
    if (!root.isConnected) return;
    const db = engine.liveEffect(ownerId, fxId)?.readout?.();
    const target = Number.isFinite(db) ? Math.min(0, db) : 0;
    shown = target < shown ? target : shown + (target - shown) * 0.15; // fast down, slow back
    fill.style.width = `${clamp(-shown / 24, 0, 1) * 100}%`;
    val.textContent = `${shown.toFixed(1)} dB`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(() => requestAnimationFrame(frame));
  return root;
}

/**
 * An `asset` parameter: pick a file from the pool, or load one straight into
 * it. The stored value is the asset's id, so it survives save and reload with
 * the pool itself.
 */
function assetRow(p, def) {
  const current = def.params[p.key] ?? "";
  const sel = el("select.select.grow", { onchange: (e) => setParam(def, p.key, e.target.value) });
  sel.append(el("option", { value: "", selected: !current }, "— none —"));
  for (const a of assets.values()) {
    sel.append(el("option", { value: a.id, selected: a.id === current, title: fmtDur(a.duration) }, a.missing ? `${a.name} (missing)` : a.name));
  }
  if (current && !assets.has(current)) sel.append(el("option", { value: current, selected: true }, "(not in the pool)"));
  const file = el("input", {
    type: "file",
    accept: "audio/*,.wav,.aif,.aiff,.flac",
    style: { display: "none" },
    onchange: async () => {
      const { importFiles } = await import("../assets.js");
      const [asset] = await importFiles(file.files);
      if (asset) setParam(def, p.key, asset.id);
    },
  });
  return row(p.label, sel, btn("Load…", () => file.click()), file);
}

function setParam(def, key, value, commit = true) {
  if (commit) pushUndo("effect param");
  def.params[key] = value;
  engine.updateMix();
  if (commit) changed("mix", true);
}

/** Draw the combined magnitude response of an EQ/filter using the real nodes. */
function paintResponse(canvas, def) {
  const ctx = engine.ensure();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const w = canvas.clientWidth || 220;
  const h = 90;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#0d0f14";
  c.fillRect(0, 0, w, h);

  const N = Math.max(64, Math.floor(w));
  const freqs = new Float32Array(N);
  for (let i = 0; i < N; i++) freqs[i] = 20 * Math.pow(1000, i / (N - 1)); // 20 Hz … 20 kHz
  const total = new Float32Array(N).fill(1);
  const mag = new Float32Array(N);
  const phase = new Float32Array(N);

  const bands =
    def.type === "filter"
      ? [{ type: def.params.mode, f: def.params.freq, g: 0, q: def.params.q }]
      : [
          { type: "lowshelf", f: def.params.lowFreq, g: def.params.lowGain, q: 1 },
          { type: "peaking", f: def.params.midFreq, g: def.params.midGain, q: def.params.midQ },
          { type: "peaking", f: def.params.hiMidFreq, g: def.params.hiMidGain, q: def.params.hiMidQ },
          { type: "highshelf", f: def.params.highFreq, g: def.params.highGain, q: 1 },
        ];
  for (const b of bands) {
    const node = ctx.createBiquadFilter();
    node.type = b.type;
    node.frequency.value = clamp(b.f, 10, ctx.sampleRate / 2 - 1);
    node.gain.value = b.g;
    node.Q.value = b.q;
    node.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < N; i++) total[i] *= mag[i];
  }

  // Grid: ±18 dB vertical, decades horizontal.
  c.strokeStyle = "#242836";
  c.lineWidth = 1;
  for (const db of [-18, -12, -6, 0, 6, 12, 18]) {
    const y = h / 2 - (db / 24) * (h / 2);
    c.strokeStyle = db === 0 ? "#39405a" : "#1e2230";
    c.beginPath();
    c.moveTo(0, y);
    c.lineTo(w, y);
    c.stroke();
  }
  c.strokeStyle = "#1e2230";
  for (const f of [100, 1000, 10000]) {
    const x = (Math.log(f / 20) / Math.log(1000)) * w;
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
  }

  c.strokeStyle = "#5cc8ff";
  c.lineWidth = 1.5;
  c.beginPath();
  for (let i = 0; i < N; i++) {
    const db = 20 * Math.log10(Math.max(1e-4, total[i]));
    const x = (i / (N - 1)) * w;
    const y = clamp(h / 2 - (db / 24) * (h / 2), -20, h + 20);
    i ? c.lineTo(x, y) : c.moveTo(x, y);
  }
  c.stroke();
}

/* ── small builders ───────────────────────────────────────────────────── */

function btn(label, onclick, warn = false) {
  return el(`button.btn${warn ? ".warn" : ""}`, { onclick }, label);
}

function select(options, value, onChange) {
  const s = el("select.select.grow", { onchange: (e) => onChange(e.target.value) });
  for (const o of options) s.append(el("option", { value: o, selected: o === value }, o));
  return s;
}

function numField(value, step, onChange) {
  return el("input.num", {
    type: "number",
    step,
    value: Number(value).toFixed(3),
    onchange: (e) => onChange(Number(e.target.value)),
  });
}
