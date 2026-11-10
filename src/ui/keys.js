// Keyboard map. One place so the help dialog and the handler can't drift.

import { $, dialog, el, toast } from "../util.js";
import { bus, changed, historyInfo, redo, state, undo } from "../state.js";
import { engine } from "../audio/engine.js";
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  nudgeSelection,
  pasteClipboard,
  selectAllClips,
  setLoopToSelection,
  splitSelection,
  stretchSelection,
  toggleMuteSelection,
  zoomBy,
  zoomToFit,
  scrollToPlayhead,
  addMarker,
  revealTrack,
  scrollTracksTo,
  view,
  viewportHeight,
} from "./timeline.js";
import { addTrack } from "./tracks.js";
import { toggleMixer } from "./mixer.js";
import { syncButtons, togglePlay, stop, toggleLoop } from "./transport.js";
import { saveProject } from "../project.js";
import { snapStep } from "../state.js";

const KEYMAP = [
  ["Transport", null],
  ["Space", "Play / pause"],
  ["Return", "Stop (again: return to zero)"],
  ["Home", "Go to start"],
  ["L", "Loop on/off"],
  ["K", "Metronome"],
  ["R", "Record onto armed tracks (right-click a track header to pick its input)"],
  ["F", "Follow playhead on/off"],
  ["Editing", null],
  ["S", "Split selected clips at the playhead"],
  ["Ctrl/⌘ D", "Duplicate selection"],
  ["Ctrl/⌘ C / X / V", "Copy / cut / paste"],
  ["⌫ / Delete", "Delete selection"],
  ["M", "Mute selected clips"],
  ["← →", "Nudge by one grid step (⇧ = fine)"],
  ["Alt ← →", "Resize selection by one grid step"],
  ["Ctrl/⌘ A", "Select all clips"],
  ["Esc", "Clear selection"],
  ["P", "Drop a marker at the playhead"],
  ["Ctrl/⌘ Z", "Undo (⇧ to redo)"],
  ["View", null],
  ["+ / −", "Zoom in / out"],
  ["Z", "Zoom to fit"],
  ["↑ ↓", "Select the previous / next track (scrolls it into view)"],
  ["Page Up / Down", "Scroll tracks a screen at a time"],
  ["Wheel", "Scroll tracks up / down"],
  ["⇧ wheel", "Scroll horizontally"],
  ["Ctrl/⌘ wheel", "Zoom at pointer"],
  ["Alt wheel", "Make every track taller / shorter"],
  ["Middle-drag / Alt-drag", "Pan the arrangement"],
  ["Scrollbars", "Drag, or click either side of the thumb to page"],
  ["F3", "Show / hide the mixer"],
  ["Session", null],
  ["Ctrl/⌘ S", "Save"],
  ["Ctrl/⌘ I", "Import audio"],
  ["T", "Add track"],
  ["?", "This help"],
];

export function initKeys() {
  $("#btn-help").addEventListener("click", showHelp);
  $("#btn-undo").addEventListener("click", doUndo);
  $("#btn-redo").addEventListener("click", doRedo);
  bus.on("history", () => {
    const h = historyInfo();
    $("#btn-undo").disabled = !h.canUndo;
    $("#btn-redo").disabled = !h.canRedo;
    $("#btn-undo").title = h.canUndo ? `Undo ${h.undoLabel}` : "Undo";
    $("#btn-redo").title = h.canRedo ? `Redo ${h.redoLabel}` : "Redo";
  });

  addEventListener("keydown", onKey);
}

function doUndo() {
  const label = undo();
  if (label) {
    engine.syncGraph();
    engine.invalidate();
    toast(`Undo ${label}`);
  }
}

function doRedo() {
  const label = redo();
  if (label) {
    engine.syncGraph();
    engine.invalidate();
    toast(`Redo ${label}`);
  }
}

function onKey(e) {
  const t = e.target;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return;
  if (!$("#overlay").hidden && e.key !== "Escape") return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key;

  if (mod) {
    switch (key.toLowerCase()) {
      case "z":
        e.preventDefault();
        return e.shiftKey ? doRedo() : doUndo();
      case "y":
        e.preventDefault();
        return doRedo();
      case "s":
        e.preventDefault();
        return void saveProject();
      case "i":
        e.preventDefault();
        return $("#file-input").click();
      case "d":
        e.preventDefault();
        return duplicateSelection();
      case "a":
        e.preventDefault();
        return selectAllClips();
      case "c":
        e.preventDefault();
        return copySelection(false);
      case "x":
        e.preventDefault();
        return copySelection(true);
      case "v":
        e.preventDefault();
        return pasteClipboard();
      default:
        return;
    }
  }

  switch (key) {
    case " ":
      e.preventDefault();
      return togglePlay();
    case "Enter":
      e.preventDefault();
      return stop();
    case "Home":
      engine.seek(0);
      scrollToPlayhead(true);
      return changed("view", false);
    case "End": {
      let end = 0;
      for (const c of state.project.clips) end = Math.max(end, c.start + c.duration);
      engine.seek(end);
      scrollToPlayhead(true);
      return changed("view", false);
    }
    case "Backspace":
    case "Delete":
      e.preventDefault();
      return deleteSelection();
    case "Escape":
      state.selection.clear();
      return changed("selection", false);
    case "ArrowLeft":
    case "ArrowRight": {
      e.preventDefault();
      const dir = key === "ArrowRight" ? 1 : -1;
      if (!state.selection.size) {
        engine.seek(Math.max(0, state.playhead + dir * (snapStep() || 0.5)));
        scrollToPlayhead();
        return changed("view", false);
      }
      return e.altKey ? stretchSelection(dir) : nudgeSelection(dir, e.shiftKey);
    }
    case "ArrowUp":
    case "ArrowDown": {
      // Step the selected track and keep it on screen.
      e.preventDefault();
      const ts = state.project.tracks;
      if (!ts.length) return;
      const cur = ts.findIndex((t) => t.id === state.selectedTrackId);
      const i = Math.max(0, Math.min(ts.length - 1, (cur < 0 ? 0 : cur) + (key === "ArrowDown" ? 1 : -1)));
      state.selectedTrackId = ts[i].id;
      state.focusedStrip = ts[i].id;
      revealTrack(i);
      changed("selection", false);
      bus.emit("mixfocus");
      return;
    }
    case "PageUp":
    case "PageDown":
      e.preventDefault();
      return scrollTracksTo(view.scrollY + (key === "PageDown" ? 1 : -1) * viewportHeight() * 0.9);
    case "?":
      return showHelp();
    case "+":
    case "=":
      return zoomBy(1.3);
    case "-":
    case "_":
      return zoomBy(1 / 1.3);
    default:
      break;
  }

  switch (key.toLowerCase()) {
    case "s":
      return splitSelection(state.playhead);
    case "m":
      return toggleMuteSelection();
    case "l":
      return toggleLoop();
    case "k":
      engine.metronome = !engine.metronome;
      return syncButtons();
    case "r":
      return $("#btn-record").click();
    case "t":
      return void addTrack();
    case "z":
      return zoomToFit();
    case "p":
      return addMarker(state.playhead);
    case "o":
      return setLoopToSelection();
    case "f":
      return $("#btn-follow")?.click();
    case "f3":
      return toggleMixer();
    default:
      break;
  }
  if (key === "F3") toggleMixer();
}

export function showHelp() {
  dialog("Keyboard", (body) => {
    const grid = el("div.keys-grid");
    for (const [k, desc] of KEYMAP) {
      if (desc == null) grid.append(el("div.kcat", null, k));
      else {
        grid.append(el("div", null, el("kbd", null, k)), el("div", null, desc));
      }
    }
    body.append(grid);
  });
}
