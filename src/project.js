// Project IO: autosave to IndexedDB, open/save-as, JSON export/import, and
// bounce (master mixdown, stems, selection).

import { assets, bus, changed, clearHistory, newProject, PROJECT_VERSION, state } from "./state.js";
import { clamp, dialog, download, el, fmtBytes, fmtDur, toast, uid, $ } from "./util.js";
import { engine } from "./audio/engine.js";
import { renderRange, finishBounce } from "./audio/render.js";
import { encodeWav } from "./audio/wav.js";
import { masterToTarget, MASTER_PRESETS } from "./audio/master.js";
import { rehydrateAssets, serializeAssets } from "./assets.js";
import { missingInProject } from "./plugins/registry.js";
import { getAssetBlob, putAssetBlob, putProject, getProject, listProjects, deleteProject, setMeta, getMeta, storageEstimate } from "./storage/db.js";

/* ── save / load ──────────────────────────────────────────────────────── */

export function serializeProject() {
  return { version: PROJECT_VERSION, project: state.project, assets: serializeAssets(), savedAt: Date.now() };
}

export async function saveProject(silent = false) {
  const doc = serializeProject();
  await putProject({ id: state.project.id, name: state.project.name, doc, updatedAt: Date.now() });
  await setMeta("lastProject", state.project.id);
  state.dirty = false;
  bus.emit("saved");
  if (!silent) toast(`Saved “${state.project.name}”`, "ok");
}

export async function loadProjectDoc(doc) {
  engine.stop();
  state.project = doc.project;
  state.selection.clear();
  state.selectedTrackId = state.project.tracks[0]?.id ?? null;
  state.playhead = 0;
  clearHistory();
  await rehydrateAssets(doc.assets);
  engine.syncGraph();
  state.dirty = false;
  changed("project", false);
  bus.emit("tracks");
  bus.emit("assets");
}

export async function openProjectById(id) {
  const rec = await getProject(id);
  if (!rec) return toast("Project not found", "err");
  await loadProjectDoc(rec.doc);
  await setMeta("lastProject", id);
  toast(`Opened “${rec.doc.project.name}”`, "ok");
}

export async function restoreLastSession() {
  const id = await getMeta("lastProject");
  if (!id) return false;
  const rec = await getProject(id);
  if (!rec) return false;
  await loadProjectDoc(rec.doc);
  return true;
}

export async function newSession() {
  if (state.dirty && !confirm("Discard unsaved changes?")) return;
  engine.stop();
  state.project = newProject(`Session ${new Date().toISOString().slice(0, 10)}`);
  state.selection.clear();
  state.selectedTrackId = state.project.tracks[0].id;
  clearHistory();
  engine.syncGraph();
  changed("project", false);
  bus.emit("tracks");
  toast("New session", "ok");
}

let autosaveTimer = null;
export function startAutosave(intervalMs = 20000) {
  clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => {
    if (state.dirty && !engine.recording) saveProject(true).catch(() => {});
  }, intervalMs);
}

/* ── project menu ─────────────────────────────────────────────────────── */

export function projectMenu(anchor) {
  return [
    { title: "Project" },
    { label: "New session", onClick: () => newSession() },
    { label: "Save", sc: "Ctrl+S", onClick: () => saveProject() },
    { label: "Save as…", onClick: () => saveAs() },
    { label: "Open…", onClick: () => openDialog() },
    "-",
    { label: "Export project file", onClick: () => exportProjectFile(false) },
    { label: "Export bundle (with audio)", onClick: () => exportProjectFile(true) },
    { label: "Import project file…", onClick: () => $("#proj-input").click() },
    "-",
    { label: "Audio setup…", onClick: () => import("./ui/audio-setup.js").then((m) => m.audioSetup()) },
    { label: "Plugins…", onClick: () => import("./ui/plugins.js").then((m) => m.pluginManager()) },
    { label: "Storage…", onClick: () => storageDialog() },
  ];
}

async function saveAs() {
  const name = prompt("Save session as", `${state.project.name} copy`);
  if (!name) return;
  state.project = { ...state.project, id: uid("prj"), name };
  await saveProject();
  changed("project", false);
}

async function openDialog() {
  const list = await listProjects();
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  dialog("Open project", (body, close) => {
    if (!list.length) body.append(el("div.insp-empty", null, "No saved projects yet."));
    for (const rec of list) {
      body.append(
        el(
          "div.prow",
          null,
          el("div.grow", null, el("b", null, rec.name), el("div.a-meta", null, new Date(rec.updatedAt).toLocaleString())),
          el("button.btn.primary", {
            onclick: async () => {
              close();
              await openProjectById(rec.id);
            },
            textContent: "Open",
          }),
          el("button.btn.warn", {
            onclick: async () => {
              if (!confirm(`Delete “${rec.name}”?`)) return;
              await deleteProject(rec.id);
              close();
              openDialog();
            },
            textContent: "Delete",
          }),
        ),
      );
    }
  });
}

/** Project file. With `withAudio` the pool is inlined as base64 for portability. */
async function exportProjectFile(withAudio) {
  const doc = serializeProject();
  if (withAudio) {
    doc.audio = {};
    for (const id of assets.keys()) {
      const rec = await getAssetBlob(id);
      if (!rec?.blob) continue;
      doc.audio[id] = { type: rec.type, name: rec.name, data: await blobToBase64(rec.blob) };
    }
  }
  const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
  download(blob, `${state.project.name.replace(/[^\w.-]+/g, "_")}${withAudio ? ".bundle" : ""}.dawproj`);
  toast(`Exported ${fmtBytes(blob.size)}`, "ok");
}

export async function importProjectFile(file) {
  const doc = JSON.parse(await file.text());
  if (!doc.project) return toast("Not a project file", "err");
  if (doc.audio) {
    for (const [id, rec] of Object.entries(doc.audio)) {
      const blob = base64ToBlob(rec.data, rec.type);
      await putAssetBlob({ id, name: rec.name, type: rec.type, size: blob.size, blob, createdAt: Date.now() });
    }
  }
  await loadProjectDoc(doc);
  await saveProject(true);
  toast(`Imported “${doc.project.name}”`, "ok");
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(",")[1]);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: type || "audio/wav" });
}

async function storageDialog() {
  const est = await storageEstimate();
  const projects = await listProjects();
  dialog("Storage", (body) => {
    body.append(
      el("div.prow", null, el("label", null, "Projects"), el("span.val", null, String(projects.length))),
      el("div.prow", null, el("label", null, "Pool"), el("span.val", null, String(assets.size))),
      est
        ? el(
            "div.prow",
            null,
            el("label", null, "Used"),
            el("span.val", null, `${fmtBytes(est.usage ?? 0)} / ${fmtBytes(est.quota ?? 0)}`),
          )
        : el("div.insp-empty", null, "Storage estimate unavailable in this browser."),
      el(
        "div.insp-empty",
        null,
        "Audio lives in this browser's IndexedDB, per origin. Export a bundle to move a session to another machine.",
      ),
    );
  });
}

/* ── bounce ───────────────────────────────────────────────────────────── */

export function exportMenu() {
  const loop = state.project.loop;
  return [
    { title: "Export" },
    { label: "Bounce master…", onClick: () => bounceDialog("master") },
    { label: "Bounce loop region…", disabled: !(loop.end > loop.start), onClick: () => bounceDialog("loop") },
    { label: "Bounce selection…", disabled: !state.selection.size, onClick: () => bounceDialog("selection") },
    "-",
    { label: "Export stems (one WAV per track)…", onClick: () => bounceDialog("stems") },
  ];
}

function rangeFor(kind) {
  const p = state.project;
  if (kind === "loop") return [p.loop.start, p.loop.end];
  if (kind === "selection") {
    const sel = p.clips.filter((c) => state.selection.has(c.id));
    if (sel.length) return [Math.min(...sel.map((c) => c.start)), Math.max(...sel.map((c) => c.start + c.duration))];
  }
  let end = 0;
  for (const c of p.clips) end = Math.max(end, c.start + c.duration);
  return [0, end];
}

export function bounceDialog(kind) {
  const [start, end] = rangeFor(kind);
  if (end <= start) return toast("Nothing to bounce", "err");
  const missing = missingInProject(state.project);

  let bits = 24;
  let rate = engine.sampleRate;
  let normalize = "off"; // "off" | "peak" | "lufs"
  let target = -14; // LUFS, when normalizing to loudness
  // "Master to target": off, or { target, ceiling, plrFloor } for the limiter loop.
  let master = null;
  let tail = 2;

  dialog(
    kind === "stems" ? "Export stems" : "Bounce",
    (body, close) => {
      const bar = el("i");
      const progress = el("div.progress", { style: { display: "none" } }, bar);
      const info = el("div.insp-empty", null, `Range ${fmtDur(start)} → ${fmtDur(end)} (${fmtDur(end - start)})`);
      // Bouncing with an insert that has no plugin would quietly render
      // something other than the session — say so before it costs a render.
      const warn = missing.length
        ? el(
            "div.plug-warn",
            null,
            el("b", null, `${missing.length} insert plugin${missing.length > 1 ? "s are" : " is"} missing`),
            el("div.a-meta", null, `${missing.join(", ")} — those inserts will pass audio through unprocessed.`),
          )
        : null;

      const sel = (label, options, value, onChange) => {
        const s = el("select.select", { onchange: (e) => onChange(e.target.value) });
        for (const o of options) s.append(el("option", { value: String(o.v), selected: o.v === value }, o.l));
        return el("div.prow", null, el("label", null, label), s);
      };

      // Loudness normalizing is a plain gain change: it cannot make a mix
      // louder than its peaks allow. Getting there with a limiter is the
      // "master to a target" bounce.
      const targetRow = el(
        "div.prow",
        { style: { display: "none" } },
        el("label", null, "Target"),
        el("input.field", {
          type: "number",
          min: -40,
          max: -5,
          step: 0.5,
          value: target,
          style: { width: "70px" },
          onchange: (e) => (target = clamp(Number(e.target.value) || -14, -40, -5)),
        }),
        el("span.val", null, "LUFS · true peak ≤ -1 dBTP"),
      );

      // Master to a loudness target: the mix is pushed into a true-peak limiter
      // until it measures on target. Not offered for stems — a stem is not a master.
      const num = (value, min, max, step, onChange) =>
        el("input.field", { type: "number", min, max, step, value, style: { width: "64px" }, onchange: (e) => onChange(clamp(Number(e.target.value), min, max)) });
      const masterFields = el("div", { style: { display: "none" } });
      const showMaster = () => {
        masterFields.style.display = master ? "" : "none";
        masterFields.replaceChildren(
          ...(master
            ? [
                el("div.prow", null, el("label", null, "Loudness"), num(master.target, -30, -5, 0.5, (v) => (master.target = v)), el("span.val", null, "LUFS integrated")),
                el("div.prow", null, el("label", null, "Ceiling"), num(master.ceiling, -6, 0, 0.1, (v) => (master.ceiling = v)), el("span.val", null, "dBTP true peak")),
                el(
                  "div.prow",
                  { title: "Peak-to-loudness ratio to keep. If the target cannot be reached without squashing the mix flatter than this, it stops here and says how far short it fell." },
                  el("label", null, "Keep PLR"),
                  num(master.plrFloor, 3, 20, 0.5, (v) => (master.plrFloor = v)),
                  el("span.val", null, "dB at least"),
                ),
              ]
            : []),
        );
      };
      const masterRow =
        kind === "stems"
          ? null
          : sel("Master to", [{ v: "off", l: "off" }, ...MASTER_PRESETS.map((p) => ({ v: p.id, l: p.label })), { v: "custom", l: "Custom…" }], "off", (v) => {
              const preset = MASTER_PRESETS.find((p) => p.id === v);
              master = v === "off" ? null : { target: preset?.target ?? -14, ceiling: preset?.ceiling ?? -1, plrFloor: 6 };
              showMaster();
            });

      body.append(
        info,
        warn,
        sel(
          "Bit depth",
          [
            { v: 16, l: "16-bit PCM" },
            { v: 24, l: "24-bit PCM" },
            { v: 32, l: "32-bit float" },
          ],
          bits,
          (v) => (bits = Number(v)),
        ),
        sel(
          "Sample rate",
          [
            { v: 44100, l: "44.1 kHz" },
            { v: 48000, l: "48 kHz" },
            { v: 96000, l: "96 kHz" },
          ],
          rate,
          (v) => (rate = Number(v)),
        ),
        sel(
          "Tail",
          [
            { v: 0, l: "none" },
            { v: 2, l: "2 s" },
            { v: 5, l: "5 s" },
          ],
          tail,
          (v) => (tail = Number(v)),
        ),
        sel(
          "Normalize",
          [
            { v: "off", l: "off" },
            { v: "peak", l: "peak to -0.3 dB" },
            { v: "lufs", l: "to loudness…" },
          ],
          normalize,
          (v) => {
            normalize = v;
            targetRow.style.display = v === "lufs" ? "" : "none";
          },
        ),
        targetRow,
        masterRow,
        masterFields,
        progress,
      );

      body.dataset.run = "1";
      body.__run = async () => {
        progress.style.display = "block";
        const onProgress = (p) => (bar.style.width = `${Math.round(p * 100)}%`);
        try {
          if (kind === "stems") {
            await bounceStems({ start, end, bits, rate, normalize, target, tail, onProgress });
            close();
          } else {
            const result = await bounceMix({ start, end, bits, rate, normalize, target, master, tail, onProgress });
            close();
            loudnessDialog(result);
          }
        } catch (err) {
          console.error(err);
          toast(`Bounce failed: ${err.message}`, "err", 6000);
        }
      };
    },
    [
      { label: "Cancel" },
      {
        label: kind === "stems" ? "Export stems" : "Bounce",
        primary: true,
        onClick: (body) => {
          body.__run();
          return false; // the run closes the dialog itself
        },
      },
    ],
  );
}

async function bounceMix({ start, end, bits, rate, normalize, target, master, tail, onProgress }) {
  const t0 = performance.now();
  // With mastering on, the render is the first two thirds of the progress bar.
  const mix = await renderRange(start, end, { sampleRate: rate, tailSec: tail, onProgress: master ? (p) => onProgress(p * 0.66) : onProgress });
  let buffer = mix;
  let result;
  if (master) {
    const m = await masterToTarget(mix, { ...master, onPass: (n) => onProgress(Math.min(0.98, 0.66 + n * 0.08)) });
    buffer = m.buffer;
    result = { ...m, mode: "master", notes: [`Mastered to ${master.target} LUFS under ${master.ceiling} dBTP with the true-peak limiter.`] };
  } else {
    result = { ...finishBounce(buffer, { mode: normalize, target }), mode: normalize, target };
  }
  const blob = encodeWav(buffer, bits);
  download(blob, `${state.project.name.replace(/[^\w.-]+/g, "_")}.wav`);
  toast(`Bounced ${fmtDur(buffer.duration)} · ${fmtBytes(blob.size)} · ${((performance.now() - t0) / 1000).toFixed(1)}s`, "ok", 5000);
  return result;
}

const fmtLu = (v, unit) => (Number.isFinite(v) ? `${v.toFixed(1)} ${unit}` : `-∞ ${unit}`);

/** What was just written, in the terms a streaming service or a mastering engineer would ask for. */
export function loudnessDialog({ report, gainDb, limited, shortfall, mode, target, passes, notes = [] }) {
  dialog("Bounce report", (body) => {
    const line = (label, value, hint) => el("div.prow", { title: hint ?? "" }, el("label", null, label), el("span.val", null, value));
    body.append(
      line("Integrated", fmtLu(report.integrated, "LUFS"), "Whole-programme loudness (ITU-R BS.1770, gated)"),
      line("Short-term max", fmtLu(report.shortTermMax, "LUFS"), "Loudest 3 seconds"),
      line("Loudness range", `${report.range.toFixed(1)} LU`, "Spread between the quiet and loud passages (EBU Tech 3342)"),
      line("True peak", fmtLu(report.truePeakDb, "dBTP"), "Highest level of the reconstructed waveform, between samples included"),
      line("Sample peak", fmtLu(report.samplePeakDb, "dBFS")),
      line("PLR", `${report.plr.toFixed(1)} dB`, "Peak to loudness ratio: true peak minus integrated loudness"),
    );
    if (mode && mode !== "off") body.append(line(mode === "master" ? "Gain into limiter" : "Gain applied", `${gainDb >= 0 ? "+" : ""}${gainDb.toFixed(1)} dB`));
    if (passes) body.append(line("Passes", String(passes)));
    if (limited) {
      body.append(
        el(
          "div.plug-warn",
          null,
          el("b", null, `${shortfall.toFixed(1)} LU short of ${target} LUFS`),
          el(
            "div.a-meta",
            null,
            mode === "master"
              ? "Getting any closer would squash the mix below the peak-to-loudness ratio you asked to keep. Lower “Keep PLR” to allow it, or make the mix itself denser."
              : "Reaching the target with gain alone would push the true peak over -1 dBTP, so the gain was held back. Use “Master to” to get there with a limiter.",
          ),
        ),
      );
    }
    for (const n of notes) body.append(el("div.plug-warn", null, el("div.a-meta", null, n)));
    if (report.truePeakDb > 0) body.append(el("div.plug-warn", null, el("b", null, "True peak is over 0 dBTP"), el("div.a-meta", null, "This file will clip when converted or played back. Lower the master or normalize.")));
  });
}

async function bounceStems({ start, end, bits, rate, normalize, target, tail, onProgress }) {
  const tracks = state.project.tracks;
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const buffer = await renderRange(start, end, {
      sampleRate: rate,
      tailSec: tail,
      trackIds: [track.id],
      applyMaster: false,
      onProgress: (p) => onProgress((i + p) / tracks.length),
    });
    finishBounce(buffer, { mode: normalize, target });
    const safe = track.name.replace(/[^\w.-]+/g, "_");
    download(encodeWav(buffer, bits), `${String(i + 1).padStart(2, "0")}_${safe}.wav`);
    // Browsers throttle rapid downloads; give each one a beat to land.
    await new Promise((r) => setTimeout(r, 350));
  }
  toast(`Exported ${tracks.length} stems`, "ok");
}
