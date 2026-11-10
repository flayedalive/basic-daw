// The sample pool: import, audition, drag onto the arrangement.

import { $, el, coalesce, fmtDur, fmtBytes, popupMenu, toast, download } from "../util.js";
import { assets, bus, state, changed, pushUndo } from "../state.js";
import { importFiles, removeAsset, assetFromBuffer } from "../assets.js";
import { engine } from "../audio/engine.js";
import { fxAssetIds } from "../plugins/registry.js";
import { pitchSourceIds } from "../audio/pitchedit.js";
import { quickPeaks } from "../audio/peaks.js";
import { encodeWav } from "../audio/wav.js";
import { dropAssetAt } from "./timeline.js";

let listEl, searchEl;
let filter = "";

export function initPool() {
  listEl = $("#asset-list");
  searchEl = $("#asset-search");
  const fileInput = $("#file-input");

  searchEl.addEventListener("input", () => {
    filter = searchEl.value.toLowerCase();
    render();
  });
  $("#btn-add-asset").addEventListener("click", () => fileInput.click());
  $("#btn-import").addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    await importWithProgress(fileInput.files);
    fileInput.value = "";
  });

  // Drops anywhere in the sidebar land in the pool.
  const zone = $("#sidebar");
  const hint = $("#pool-drop");
  zone.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    hint.classList.add("hot");
  });
  zone.addEventListener("dragleave", () => hint.classList.remove("hot"));
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    hint.classList.remove("hot");
    if (e.dataTransfer.files?.length) await importWithProgress(e.dataTransfer.files);
  });

  const refresh = coalesce(() => (render(), renderInfo()));
  bus.on("assets", refresh);
  bus.on("clips", refresh);
  bus.on("project", refresh);
  render();
  renderInfo();
}

export async function importWithProgress(files) {
  const hint = $("#pool-drop");
  const label = hint.textContent;
  const created = await importFiles(files, (p, name) => {
    hint.textContent = p >= 1 ? label : `${Math.round(p * 100)}% · ${name}`;
  });
  hint.textContent = label;
  return created;
}

function render() {
  if (!listEl) return;
  listEl.replaceChildren();
  const used = new Set(state.project.clips.map((c) => c.assetId));
  // An impulse response loaded into a cabinet is in use though no clip plays it.
  for (const id of fxAssetIds(state.project)) used.add(id);
  // …and so is the original of a clip whose pitch has been edited: Revert needs it.
  for (const id of pitchSourceIds(state.project)) used.add(id);
  const items = [...assets.values()].filter((a) => !filter || a.name.toLowerCase().includes(filter));
  items.sort((a, b) => a.name.localeCompare(b.name));

  for (const asset of items) {
    const thumb = el("canvas.a-wave", { width: 84, height: 32 });
    requestAnimationFrame(() => paintThumb(thumb, asset));

    const li = el(
      `li${state.selectedAssetId === asset.id ? ".sel" : ""}`,
      {
        draggable: true,
        title: `${asset.name}\n${fmtDur(asset.duration)} · ${asset.channels}ch · ${asset.sampleRate} Hz · ${fmtBytes(asset.size)}${
          used.has(asset.id) ? "" : "\n(not used in the arrangement)"
        }`,
        onclick: () => {
          state.selectedAssetId = asset.id;
          engine.previewAsset(asset.id);
          render();
        },
        ondblclick: () => {
          const at = state.playhead;
          dropAssetAt(asset.id, state.selectedTrackId, at);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          popupMenu(e.clientX, e.clientY, assetMenu(asset, used.has(asset.id)));
        },
        ondragstart: (e) => {
          e.dataTransfer.setData("application/x-daw-asset", asset.id);
          e.dataTransfer.effectAllowed = "copy";
          window.__dawDragAssetId = asset.id;
        },
        ondragend: () => {
          window.__dawDragAssetId = null;
        },
      },
      thumb,
      el(
        "div.grow",
        { style: { minWidth: 0, flex: "1" } },
        el("div.a-name", { style: asset.missing ? { color: "#ff6b6b" } : null }, asset.name),
        el("div.a-meta", null, `${fmtDur(asset.duration)} · ${asset.channels}ch${used.has(asset.id) ? "" : " · unused"}`),
      ),
    );
    listEl.append(li);
  }

  if (!items.length) {
    listEl.append(el("li", { style: { color: "#8a90a4", cursor: "default" } }, filter ? "no matches" : "pool is empty"));
  }
}

function paintThumb(canvas, asset) {
  const c = canvas.getContext("2d");
  c.clearRect(0, 0, canvas.width, canvas.height);
  if (!asset.buffer) return;
  const peaks = asset.thumb ?? (asset.thumb = quickPeaks(asset.buffer, 42));
  const w = canvas.width;
  const h = canvas.height;
  const bw = w / peaks.length;
  c.fillStyle = asset.missing ? "#ff6b6b" : "#5cc8ff99";
  for (let i = 0; i < peaks.length; i++) {
    const bh = Math.max(1, peaks[i] * h);
    c.fillRect(i * bw, (h - bh) / 2, Math.max(1, bw - 1), bh);
  }
}

function assetMenu(asset, used) {
  return [
    { title: asset.name },
    { label: "Insert at playhead", onClick: () => dropAssetAt(asset.id, state.selectedTrackId, state.playhead) },
    { label: "Insert on new track", onClick: () => dropAssetAt(asset.id, null, state.playhead) },
    { label: "Preview", onClick: () => engine.previewAsset(asset.id) },
    "-",
    { label: "Rename…", onClick: () => renameAsset(asset) },
    { label: "Reverse copy", disabled: !asset.buffer, onClick: () => reverseCopy(asset) },
    { label: "Export as WAV", disabled: !asset.buffer, onClick: () => download(encodeWav(asset.buffer, 24), `${asset.name}.wav`) },
    "-",
    {
      label: used ? "Remove (used by clips)" : "Remove from pool",
      onClick: () => {
        if (used && !confirm(`"${asset.name}" is used in the arrangement. Remove it and its clips?`)) return;
        pushUndo("remove asset");
        state.project.clips = state.project.clips.filter((c) => c.assetId !== asset.id);
        removeAsset(asset.id);
        changed("clips");
        engine.invalidate();
      },
    },
  ];
}

function renameAsset(asset) {
  const v = prompt("Sample name", asset.name);
  if (v == null) return;
  asset.name = v;
  bus.emit("assets");
}

async function reverseCopy(asset) {
  const src = asset.buffer;
  const ctx = engine.ensure();
  const out = ctx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let c = 0; c < src.numberOfChannels; c++) {
    const from = src.getChannelData(c);
    const to = out.getChannelData(c);
    for (let i = 0, n = from.length; i < n; i++) to[i] = from[n - 1 - i];
  }
  await assetFromBuffer(`${asset.name} (rev)`, out);
  toast("Reversed copy added to the pool", "ok");
}

function renderInfo() {
  const box = $("#project-info");
  if (!box) return;
  const p = state.project;
  const bytes = [...assets.values()].reduce((n, a) => n + (a.size ?? 0), 0);
  box.replaceChildren(
    el("div", null, el("b", null, p.name)),
    el("div", null, `${p.tracks.length} tracks · ${p.clips.length} clips`),
    el("div", null, `pool ${assets.size} · ${fmtBytes(bytes)}`),
    el("div", null, `${p.bpm} BPM · ${p.sigNum}/${p.sigDen}`),
  );
}
