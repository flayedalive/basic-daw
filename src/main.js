// Bootstrap: wire the panels together, run the UI frame loop, restore the
// last session. Everything below the top of this file is glue — the interesting
// parts live in audio/engine.js and ui/timeline.js.

import { $, toast } from "./util.js";
import { bus, state } from "./state.js";
import { engine } from "./audio/engine.js";
import { initTimeline, draw as drawTimeline, resize as resizeTimeline, zoomToFit } from "./ui/timeline.js";
import { initScrollbars } from "./ui/scrollbars.js";
import { initTracks, updateTrackMeters } from "./ui/tracks.js";
import { initMixer, updateMixerMeters } from "./ui/mixer.js";
import { initInspector } from "./ui/inspector.js";
import { initPool } from "./ui/pool.js";
import { initTransport, updateReadouts, syncButtons } from "./ui/transport.js";
import { initKeys } from "./ui/keys.js";
import { importProjectFile, restoreLastSession, saveProject, startAutosave } from "./project.js";
import { initPlugins } from "./plugins/loader.js";
import { applySavedOutput, input } from "./audio/input.js";

async function boot() {
  // Plugins first: restoring a session builds insert chains, and an effect
  // whose plugin is not registered yet would come back as a passthrough.
  await initPlugins();

  initTimeline();
  initScrollbars();
  initTracks();
  initMixer();
  initInspector();
  initPool();
  initTransport();
  initKeys();
  initSplitters();
  initProjectFileInput();
  initUnloadGuard();

  try {
    const restored = await restoreLastSession();
    if (restored) {
      toast(`Restored “${state.project.name}”`, "ok");
      zoomToFit();
    }
  } catch (err) {
    console.error("restore failed", err);
  }

  bus.on("project", syncButtons);
  // An insert can reference pool audio (a cabinet IR); push parameters again
  // once that audio has finished decoding or has been removed.
  bus.on("assets", () => engine.updateMix());
  // Arming or monitoring a track (or loading a session) re-routes live input.
  for (const evt of ["mix", "tracks", "project"]) bus.on(evt, () => input.syncMonitoring());
  let lastInputError = 0;
  bus.on("audioinput", (info) => {
    if (!info?.error || performance.now() - lastInputError < 10000) return;
    lastInputError = performance.now();
    toast(`Input unavailable: ${info.error.message || info.error.name} — see Project ▾ → Audio setup…`, "err", 6000);
  });
  startAutosave();
  frame();

  // The audio context can only start from a gesture; do it on the first one.
  const unlock = () => {
    engine.ensure();
    applySavedOutput();
    input.syncMonitoring();
    removeEventListener("pointerdown", unlock);
    removeEventListener("keydown", unlock);
  };
  addEventListener("pointerdown", unlock);
  addEventListener("keydown", unlock);

  addEventListener("resize", () => resizeTimeline());
  await exposeDebugApi();
}

/* ── frame loop ───────────────────────────────────────────────────────── */

let lastPos = -1;
function frame() {
  const levels = engine.readLevels();
  updateReadouts(levels);
  updateTrackMeters(levels);
  updateMixerMeters(levels);
  const pos = engine.playing ? engine.position : state.playhead;
  if (engine.playing || pos !== lastPos) {
    lastPos = pos;
    drawTimeline();
  }
  requestAnimationFrame(frame);
}

engine.onTick = (what) => {
  if (what === "ended") syncButtons();
};

/* ── panel splitters ──────────────────────────────────────────────────── */

function initSplitters() {
  const app = $("#app");
  const readVar = (name, fallback) => parseInt(getComputedStyle(app).getPropertyValue(name)) || fallback;

  const vertical = (el, cssVar, min, max, invert = false) => {
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const start = readVar(cssVar, 210);
      const x0 = e.clientX;
      const move = (ev) => {
        const d = (ev.clientX - x0) * (invert ? -1 : 1);
        app.style.setProperty(cssVar, `${Math.max(min, Math.min(max, start + d))}px`);
        resizeTimeline();
      };
      const up = () => {
        removeEventListener("pointermove", move);
        removeEventListener("pointerup", up);
        localStorage.setItem(`daw.${cssVar}`, getComputedStyle(app).getPropertyValue(cssVar));
      };
      addEventListener("pointermove", move);
      addEventListener("pointerup", up);
    });
  };

  vertical($("#split-left"), "--sidebar-w", 120, 460);
  vertical($("#split-right"), "--insp-w", 160, 520, true);

  $("#split-mixer").addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const start = readVar("--mixer-h", 210);
    const y0 = e.clientY;
    const move = (ev) => {
      app.style.setProperty("--mixer-h", `${Math.max(60, Math.min(innerHeight - 220, start - (ev.clientY - y0)))}px`);
      resizeTimeline();
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      localStorage.setItem("daw.--mixer-h", getComputedStyle(app).getPropertyValue("--mixer-h"));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  });

  for (const v of ["--sidebar-w", "--insp-w", "--mixer-h"]) {
    const saved = localStorage.getItem(`daw.${v}`);
    if (saved) app.style.setProperty(v, saved.trim());
  }
}

/* ── project file input & unload guard ────────────────────────────────── */

function initProjectFileInput() {
  const input = $("#proj-input");
  input.addEventListener("change", async () => {
    if (input.files?.[0]) {
      try {
        await importProjectFile(input.files[0]);
        zoomToFit();
      } catch (err) {
        toast(`Import failed: ${err.message}`, "err", 5000);
      }
    }
    input.value = "";
  });

  // A .dawproj dropped anywhere opens it; audio dropped anywhere imports.
  addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  addEventListener("drop", async (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.dawproj$|\.json$/i.test(file.name)) {
      e.preventDefault();
      await importProjectFile(file);
      zoomToFit();
    }
  });
}

function initUnloadGuard() {
  addEventListener("beforeunload", (e) => {
    if (!state.dirty) return;
    // Autosave usually has it, but an in-flight edit is worth one confirm.
    e.preventDefault();
    e.returnValue = "";
  });
  // Save on hide: mobile and tab-close paths never reach beforeunload reliably.
  addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) saveProject(true).catch(() => {});
  });
}

// Debug handle. This is a tool you run locally on your own sessions — being
// able to poke the document and the engine from the console is a feature.
async function exposeDebugApi() {
  const [{ assets }, timeline, tracks, project, pool] = await Promise.all([
    import("./state.js"),
    import("./ui/timeline.js"),
    import("./ui/tracks.js"),
    import("./project.js"),
    import("./assets.js"),
  ]);
  const [effects, render, doc, registry, loader] = await Promise.all([
    import("./audio/effects.js"),
    import("./audio/render.js"),
    import("./state.js"),
    import("./plugins/registry.js"),
    import("./plugins/loader.js"),
  ]);
  globalThis.daw = {
    state,
    assets,
    engine,
    input,
    bus,
    timeline,
    tracks,
    pool,
    project,
    effects,
    render,
    plugins: { ...registry, ...loader },
    undo: doc.undo,
    redo: doc.redo,
  };
}

boot().catch((err) => {
  console.error(err);
  document.body.append(
    Object.assign(document.createElement("pre"), {
      textContent: `Failed to start: ${err.stack ?? err}`,
      style: "color:#ff6b6b;padding:16px;font:12px monospace",
    }),
  );
});
