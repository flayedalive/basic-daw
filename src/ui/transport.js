// Top bar: transport buttons, tempo/grid fields, position readout, master meter.

import { $, clamp, fmtBBT, fmtTime, popupMenu, toast } from "../util.js";
import { bus, changed, newClip, pushUndo, state } from "../state.js";
import { engine } from "../audio/engine.js";
import { input } from "../audio/input.js";
import { assetFromBuffer } from "../assets.js";
import { scrollToPlayhead } from "./timeline.js";
import { exportMenu, projectMenu } from "../project.js";

let follow = true;

export function initTransport() {
  const btn = (id, fn) => $(id).addEventListener("click", fn);

  btn("#btn-play", togglePlay);
  btn("#btn-stop", stop);
  btn("#btn-goto-start", () => {
    engine.seek(0);
    scrollToPlayhead(true);
    changed("view", false);
  });
  btn("#btn-record", toggleRecord);
  btn("#btn-loop", toggleLoop);
  btn("#btn-metro", () => {
    engine.metronome = !engine.metronome;
    syncButtons();
  });
  btn("#btn-follow", () => {
    follow = !follow;
    syncButtons();
  });
  btn("#btn-export", (e) => popupMenu(e.clientX, e.clientY - 4, exportMenu()));
  btn("#btn-project", (e) => popupMenu(e.clientX, e.clientY - 4, projectMenu()));

  const bpm = $("#in-bpm");
  bpm.addEventListener("change", () => {
    pushUndo("tempo");
    state.project.bpm = clamp(Number(bpm.value) || 120, 20, 300);
    bpm.value = String(state.project.bpm);
    changed("project");
  });
  const num = $("#in-sig-num");
  const den = $("#in-sig-den");
  num.addEventListener("change", () => {
    pushUndo("time signature");
    state.project.sigNum = clamp(Number(num.value) || 4, 1, 16);
    changed("project");
  });
  den.addEventListener("change", () => {
    pushUndo("time signature");
    state.project.sigDen = Number(den.value) || 4;
    changed("project");
  });
  $("#in-snap").addEventListener("change", (e) => {
    state.project.snap = e.target.value;
    changed("view", false);
  });

  // Anything that stops the transport mid-take (loading a session, the device
  // going away) finishes the take rather than dropping it.
  engine.onRecordStop = () => void finishRecording();
  input.onLost = () => {
    if (engine.recording) {
      toast("Input device disconnected — take saved up to here", "err", 5000);
      finishRecording();
    }
  };

  bus.on("project", syncFields);
  bus.on("loop", syncButtons);
  bus.on("history", syncButtons);
  syncFields();
  syncButtons();
}

export function togglePlay() {
  engine.ensure();
  if (engine.recording) finishRecording();
  if (engine.playing) engine.pause();
  else engine.play(state.playhead);
  syncButtons();
  changed("view", false);
}

export function stop() {
  if (engine.recording) finishRecording();
  engine.stop(); // parks the playhead itself
  syncButtons();
  changed("view", false);
}

export function toggleLoop() {
  const loop = state.project.loop;
  if (loop.end <= loop.start) {
    // No region yet: make one bar at the playhead so the button always does something.
    const bar = (60 / state.project.bpm) * state.project.sigNum;
    loop.start = state.playhead;
    loop.end = state.playhead + bar * 4;
  }
  loop.enabled = !loop.enabled;
  changed("loop");
  engine.invalidate();
}

async function toggleRecord() {
  if (engine.recording) return void finishRecording();
  const armed = state.project.tracks.filter((t) => t.armed);
  if (!armed.length) return toast("Arm a track first (● on the track header)", "err");
  try {
    engine.ensure();
    await input.startCapture(armed);
    // Restart if already rolling, so the take's timing starts from a logged
    // segment (and a loop in progress is set aside).
    if (engine.playing) engine.invalidate();
    else engine.play(state.playhead);
    syncButtons();
    const usesMain = input.capture?.parts.some((p) => p.key === "");
    const where = usesMain && input.fellBack ? " (saved device missing — using the default)" : "";
    const loopNote = state.project.loop.enabled ? " · loop off while recording" : "";
    toast(`Recording ${armed.length > 1 ? `${armed.length} tracks` : armed[0].name} from ${input.captureLabel()}${where}${loopNote}`, "ok", 3500);
  } catch (err) {
    syncButtons();
    toast(`Can't record: ${err.message || err.name}. Check Project ▾ → Audio setup…`, "err", 6000);
  }
}

let finishing = null;

/** End the take and drop one clip per armed track. Safe to call twice. */
function finishRecording() {
  if (!engine.recording) return finishing;
  const proj = state.project;
  const pending = input.stopCapture(); // ends the take synchronously
  syncButtons();
  finishing = placeTakes(pending, proj).finally(() => (finishing = null));
  return finishing;
}

async function placeTakes(pending, proj) {
  let takes;
  try {
    takes = await pending;
  } catch (err) {
    console.error(err);
    return toast(`Recording failed: ${err.message}`, "err", 5000);
  }
  if (!takes.length) return toast("Nothing was recorded", "err");

  const ctx = engine.ensure();
  const stamp = new Date().toLocaleTimeString();
  const made = [];
  for (const take of takes) {
    const track = proj.tracks.find((t) => t.id === take.trackId);
    const buffer = ctx.createBuffer(take.channels.length, take.channels[0].length, take.sampleRate);
    take.channels.forEach((d, c) => buffer.copyToChannel(d, c));
    const name = takes.length > 1 && track ? `Take ${stamp} · ${track.name}` : `Take ${stamp}`;
    made.push({ asset: await assetFromBuffer(name, buffer), track, startPos: take.startPos, overs: countOvers(take.channels) });
  }

  // The session was swapped out mid-take: keep the audio, don't guess where.
  if (state.project !== proj) return toast("Take saved to the pool", "ok");

  pushUndo("record");
  state.selection.clear();
  for (const { asset, track, startPos } of made) {
    if (!track) continue;
    const clip = newClip(asset.id, track.id, startPos);
    state.project.clips.push(clip);
    state.selection.add(clip.id);
  }
  changed("clips");
  engine.invalidate();
  const secs = made[0].asset.duration;
  const clipped = made.filter((m) => m.overs > 0);
  if (clipped.length) {
    const which = clipped.map((m) => `${m.track?.name ?? "take"} (${m.overs}×)`).join(", ");
    toast(`Recorded ${secs.toFixed(1)}s — clipped on ${which}. Lower the input gain on your interface and record again.`, "err", 8000);
  } else {
    toast(`Recorded ${secs.toFixed(1)}s${made.length > 1 ? ` on ${made.length} tracks` : ""}`, "ok");
  }
}

/**
 * Count clipped passages: runs of two or more consecutive full-scale samples.
 * One sample at full scale can be a legitimate peak; a flat run is the
 * converter running out of headroom.
 */
export function countOvers(channels, level = 0.999) {
  let overs = 0;
  for (const d of channels) {
    let run = 0;
    for (let i = 0; i < d.length; i++) {
      if (d[i] >= level || d[i] <= -level) {
        if (++run === 2) overs++;
      } else run = 0;
    }
  }
  return overs;
}

export function setFollow(v) {
  follow = v;
}
export const getFollow = () => follow;

function syncFields() {
  $("#in-bpm").value = String(state.project.bpm);
  $("#in-sig-num").value = String(state.project.sigNum);
  $("#in-sig-den").value = String(state.project.sigDen);
  $("#in-snap").value = state.project.snap;
  syncButtons();
}

export function syncButtons() {
  $("#btn-play").classList.toggle("on", engine.playing);
  $("#btn-play").textContent = engine.playing ? "⏸" : "▶";
  $("#btn-record").classList.toggle("on", engine.recording);
  $("#btn-loop").classList.toggle("on", state.project.loop.enabled);
  $("#btn-metro").classList.toggle("on", engine.metronome);
  $("#btn-follow").classList.toggle("on", follow);
}

/* ── per-frame readouts ───────────────────────────────────────────────── */

let peakHold = 0;
let peakHoldUntil = 0;

export function updateReadouts(levels) {
  const p = state.project;
  const pos = engine.playing ? engine.position : state.playhead;
  $("#pos-bbt").textContent = fmtBBT(pos, p.bpm, p.sigNum, p.sigDen);
  $("#pos-time").textContent = fmtTime(pos);

  const m = levels.get("master") ?? { peak: 0, peakR: 0 };
  const pct = (v) => `${Math.round(clamp(1 + (v > 0 ? 20 * Math.log10(v) : -60) / 60, 0, 1) * 100)}%`;
  $("#mm-l").style.width = pct(m.peak);
  $("#mm-r").style.width = pct(m.peakR);

  const now = performance.now();
  const peak = Math.max(m.peak, m.peakR);
  if (peak > peakHold || now > peakHoldUntil) {
    peakHold = peak;
    peakHoldUntil = now + 1600;
    const el = $("#mm-peak");
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    el.textContent = isFinite(db) ? db.toFixed(1) : "-∞";
    el.classList.toggle("clip", db > -0.1);
  }

  if (follow && engine.playing) scrollToPlayhead();
}
