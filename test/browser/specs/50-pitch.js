// 5.5 / 5.6 Pitch editing in the app: the editor, and the render-and-swap that
// applies it. The DSP itself is tested in Node (pitchtrack, pitchshift, pitchedit).

import { test, assert, openApp, sleep, captureEngine, firstSound, fmt } from "../lib.js";
import { sing, addConsonant } from "../../node/voice.mjs";
import { trackPitch } from "../../../src/audio/pitchtrack.js";

const SR = 48000; // voice.mjs sings at 48 kHz

/** Three notes, each out of tune: A3 30 ct flat, C4 20 ct sharp, D4 35 ct sharp. */
function phrase() {
  const midiAt = (t) => {
    if (t < 0.2 || (t >= 1.6 && t < 1.75) || t >= 2.4) return NaN;
    if (t < 0.9) return 56.7;
    if (t < 0.98) return 56.7 + ((60.2 - 56.7) * (t - 0.9)) / 0.08;
    if (t < 1.6) return 60.2;
    return 62.35;
  };
  const { x } = sing(2.6, midiAt);
  addConsonant(x, 1.63, 0.09);
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: x.length, sampleRate: SR });
  buffer.copyToChannel(x, 0);
  buffer.copyToChannel(x, 1);
  return buffer;
}

function medianPitch(buffer, from, to) {
  const track = trackPitch(buffer.getChannelData(0), buffer.sampleRate);
  const v = [];
  for (let f = Math.ceil(from / track.hop); f <= Math.floor(to / track.hop); f++) if (!Number.isNaN(track.midi[f])) v.push(track.midi[f]);
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}

async function setup() {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  // With a blob, as an imported file has, so it is stored and can be reloaded.
  const { encodeWav } = await win.eval('import("/src/audio/wav.js")');
  const buffer = phrase();
  const asset = await daw.pool.addAsset({ name: "vox", buffer, blob: encodeWav(buffer, 24) });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  const clip = daw.state.project.clips[0];
  Object.assign(clip, { fadeIn: 0, fadeOut: 0 });
  const mod = await win.eval('import("/src/audio/pitchedit.js")');
  const ui = await win.eval('import("/src/ui/pitcheditor.js")');
  return { win, daw, asset, clip, mod, ui };
}

const sameSamples = (a, b) => {
  if (a.length !== b.length) return false;
  for (let c = 0; c < a.numberOfChannels; c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
};

async function openEditor(env) {
  env.ui.openPitchEditor(env.clip);
  const doc = env.win.document;
  for (let i = 0; i < 400 && !doc.querySelector(".pe-canvas")?.__editor; i++) await sleep(50);
  const canvas = doc.querySelector(".pe-canvas");
  assert(canvas?.__editor, "the editor never finished analysing");
  return { canvas, ed: canvas.__editor, doc };
}
const clickButton = (doc, label) => {
  const b = [...doc.querySelectorAll("#overlay .d-foot button")].find((x) => x.textContent === label);
  assert(b, `no “${label}” button`);
  b.click();
};

test("editor: notes are found and drawn; drag, double-click, split, join and undo edit them", async () => {
  const env = await setup();
  const { win } = env;
  const { canvas, ed, doc } = await openEditor(env);
  assert(ed.notes.length === 3, `expected 3 notes, found ${ed.notes.length}`);
  const targets = ed.notes.map((n) => Math.round(n.center));
  assert(targets.join() === "57,60,62", `notes at ${targets}`);

  // Something was actually painted on the grid.
  const px = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let blue = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i + 2] > 180 && px[i] < 140) blue++;
  assert(blue > 200, "no notes or curves drawn");

  // Drag the second note up two semitones.
  const r = canvas.getBoundingClientRect();
  const { w, h } = ed.size();
  const n = ed.notes[1];
  const x = r.left + ed.xOf((n.startSec + n.endSec) / 2, w);
  const y0 = r.top + ed.yOf(60, h);
  const y1 = r.top + ed.yOf(62, h);
  const ev = (type, y, extra = {}) => new win.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true, ...extra });
  canvas.dispatchEvent(ev("pointerdown", y0));
  canvas.dispatchEvent(ev("pointermove", (y0 + y1) / 2));
  canvas.dispatchEvent(ev("pointermove", y1));
  canvas.dispatchEvent(ev("pointerup", y1));
  assert(ed.edit.notes[n.id]?.target === 62, `drag set target ${ed.edit.notes[n.id]?.target}`);
  assert(ed.selected.has(n.id), "dragged note is not selected");
  assert(doc.querySelectorAll(".pe-sel input[type=range]").length === 5, "no per-note sliders for the selection");
  // The corrected curve now sits on D for that note.
  const mid = Math.round((n.startSec + n.endSec) / 2 / (n.endSec - n.startSec) * (n.end - n.start));
  const at = ed.curve.midi[n.start + Math.round((n.end - n.start) * 0.7)];
  assert(Math.abs(at - 62) < 0.15, `corrected curve at ${fmt(at)} after the drag (${mid})`);

  // Double-click sends it back to the scale.
  canvas.dispatchEvent(new win.MouseEvent("dblclick", { clientX: x, clientY: y1, bubbles: true }));
  assert(ed.edit.notes[n.id]?.target == null, "double-click did not clear the target");

  // Split the first note, then join it back.
  const first = ed.notes[0];
  ed.splitAt((first.startSec + first.endSec) / 2);
  assert(ed.notes.length === 4, `split gave ${ed.notes.length} notes`);
  ed.selected.clear();
  ed.selected.add(ed.notes[1].id);
  ed.joinSelected();
  assert(ed.notes.length === 3, `join gave ${ed.notes.length} notes`);

  // Undo walks back: join, split, double-click, drag.
  ed.undo();
  assert(ed.notes.length === 4, "undo did not restore the split");
  ed.undo();
  ed.undo();
  assert(ed.edit.notes[n.id]?.target === 62, "undo did not restore the dragged target");

  // A global slider changes the edit.
  const amount = doc.querySelector(".pe-controls input[type=range]");
  amount.value = 0.5;
  amount.dispatchEvent(new win.Event("input"));
  assert(ed.edit.amount === 0.5, "amount slider not written");

  clickButton(doc, "Cancel");
  await sleep(50);
  assert(doc.querySelector("#overlay").hidden, "dialog did not close");
  assert(!env.clip.pitchEdit, "Cancel changed the clip");
  assert(!win.__errors.length, win.__errors.join("; "));
  return "3 notes at A3, C4, D4; drag, reset, split, join, undo";
});

test("apply: the clip plays corrected audio, and playback is the bounce", async () => {
  const env = await setup();
  const { win, daw, clip, asset } = env;
  const { doc } = await openEditor(env);
  clickButton(doc, "Apply");
  for (let i = 0; i < 600 && !clip.pitchEdit; i++) await sleep(50);
  assert(clip.pitchEdit?.source === asset.id, "Apply did not record the original");
  assert(clip.assetId !== asset.id && daw.assets.get(clip.assetId)?.buffer, "clip does not point at a rendered asset");
  await sleep(100);
  assert(doc.querySelector("#overlay").hidden, "dialog still open after Apply");

  const rate = daw.engine.sampleRate;
  const bounce = await daw.render.renderRange(0, clip.duration, { sampleRate: rate, tailSec: 0 });
  const got = [medianPitch(bounce, 0.35, 0.85), medianPitch(bounce, 1.1, 1.55), medianPitch(bounce, 1.9, 2.35)];
  const want = [57, 60, 62];
  got.forEach((m, i) => assert(Math.abs(m - want[i]) < 0.06, `note ${i + 1} bounced at ${fmt(m, 3)}, wanted ${want[i]}`));

  const cap = await captureEngine(win, 3.4);
  daw.engine.play(0);
  const live = await cap.done;
  daw.engine.stop();
  const a = firstSound(live);
  const b = firstSound(bounce);
  assert(a > 0 && b >= 0, "nothing captured");
  const count = Math.min(live.length - a, bounce.length - b) - 64;
  let peak = 0;
  const x = live.getChannelData(0).subarray(a);
  const y = bounce.getChannelData(0).subarray(b);
  for (let i = 0; i < count; i++) peak = Math.max(peak, Math.abs(x[i] - y[i]));
  const d = 20 * Math.log10(peak + 1e-12);
  assert(d < -80, `playback and bounce differ by ${fmt(d)} dBFS`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return `bounced at ${got.map((m) => fmt(m, 2)).join(", ")}; playback − bounce ${fmt(d, 0)} dBFS`;
});

test("the edit survives save and reload, can be edited again, and Revert is lossless", async () => {
  const env = await setup();
  const { win, daw, asset, mod } = env;
  const edit = mod.editOf(env.clip);
  await mod.applyPitchEdit(env.clip, edit);
  const tunedId = env.clip.assetId;

  // Save, wipe the pool, load.
  const saved = JSON.parse(JSON.stringify(daw.project.serializeProject()));
  assert(saved.assets.some((a) => a.id === asset.id) && saved.assets.some((a) => a.id === tunedId), "saved pool is missing the original or the render");
  daw.assets.clear();
  await daw.project.loadProjectDoc(saved);
  const clip = daw.state.project.clips[0];
  assert(clip.assetId === tunedId && clip.pitchEdit?.source === asset.id, "clip lost its pitch edit on reload");
  assert(daw.assets.get(tunedId)?.buffer && daw.assets.get(asset.id)?.buffer, "assets did not come back");
  assert(clip.pitchEdit.edit.key === edit.key && clip.pitchEdit.edit.scale === edit.scale, "edit data changed in the round trip");
  const original = daw.assets.get(asset.id).buffer;
  const heard = medianPitch(daw.assets.get(tunedId).buffer, 1.9, 2.35);
  assert(Math.abs(heard - 62) < 0.06, `reloaded render plays ${fmt(heard, 3)}`);

  // Edit again: starts from the original, replaces the render.
  env.clip = clip;
  const { ed, doc } = await openEditor(env);
  assert(ed.notes.length === 3 && Math.abs(ed.notes[2].center - 62.35) < 0.06, "re-edit is not working from the original audio");
  ed.edit.notes[ed.notes[2].id] = { target: 64 };
  clickButton(doc, "Apply");
  for (let i = 0; i < 600 && clip.assetId === tunedId; i++) await sleep(50);
  assert(clip.assetId !== tunedId, "second Apply did not render");
  const moved = medianPitch(daw.assets.get(clip.assetId).buffer, 1.9, 2.35);
  assert(Math.abs(moved - 64) < 0.08, `retargeted note plays ${fmt(moved, 3)}, wanted 64`);
  assert(clip.pitchEdit.source === asset.id, "source changed on re-edit");
  await sleep(100);

  // Undo and redo the second apply.
  const second = clip.assetId;
  daw.undo();
  assert(daw.state.project.clips[0].assetId === tunedId, "undo did not go back to the first render");
  assert(daw.assets.get(tunedId)?.buffer, "the first render was dropped while undo still needed it");
  daw.redo();
  assert(daw.state.project.clips[0].assetId === second && daw.assets.get(second)?.buffer, "redo did not bring the second render back");

  // Revert: the clip plays the untouched original again.
  env.clip = daw.state.project.clips[0];
  const again = await openEditor(env);
  clickButton(again.doc, "Revert to original");
  await sleep(200);
  const back = daw.state.project.clips[0];
  assert(back.assetId === asset.id && !back.pitchEdit, "Revert did not restore the clip");
  const now = daw.assets.get(asset.id).buffer;
  assert(sameSamples(now, original), "the original audio is not bit-identical after revert");
  assert(!win.__errors.length, win.__errors.join("; "));
  return `reload kept the edit; re-edit D4→E4 plays ${fmt(moved, 2)}; revert is bit-identical`;
});

test("a clip with nothing to correct, and a pool that knows originals are in use", async () => {
  const env = await setup();
  const { daw, asset, mod, win } = env;
  await mod.analyzeAsset(asset);
  const none = { ...mod.editOf(env.clip), amount: 0 };
  assert(mod.isNoOp(asset, none), "amount 0 should change nothing");
  assert(!mod.isNoOp(asset, mod.editOf(env.clip)), "an out-of-tune phrase should need correcting");
  await mod.applyPitchEdit(env.clip, mod.editOf(env.clip));
  assert(mod.pitchSourceIds(daw.state.project).has(asset.id), "the original is not counted as in use");
  // Splitting keeps both halves on the same render, and re-applying moves both.
  daw.state.selection.clear();
  daw.state.selection.add(env.clip.id);
  daw.timeline.splitSelection(1.2);
  const clips = daw.state.project.clips;
  assert(clips.length === 2 && clips.every((c) => c.pitchEdit?.source === asset.id), "split lost the pitch edit");
  await mod.applyPitchEdit(clips[0], { ...mod.editOf(clips[0]), speed: 0 });
  assert(clips[0].assetId === clips[1].assetId, "the two halves no longer share a render");
  assert(!win.__errors.length, win.__errors.join("; "));
});

// Last, and left open, so the runner's screenshot shows the editor.
test("editor: laid out, with a note selected and one retuned", async () => {
  const env = await setup();
  const { canvas, ed, doc } = await openEditor(env);
  const r = canvas.getBoundingClientRect();
  assert(r.width > 600 && r.height >= 220, `canvas is ${Math.round(r.width)}×${Math.round(r.height)}`);
  ed.edit.notes[ed.notes[2].id] = { target: 64 };
  const { w, h } = ed.size();
  const n = ed.notes[0];
  const at = { clientX: r.left + ed.xOf((n.startSec + n.endSec) / 2, w), clientY: r.top + ed.yOf(57, h), button: 0, pointerId: 1, bubbles: true };
  canvas.dispatchEvent(new env.win.PointerEvent("pointerdown", at));
  canvas.dispatchEvent(new env.win.PointerEvent("pointerup", at));
  assert(ed.selected.size === 1, "click did not select the note");
  const info = doc.querySelector(".pe-info").textContent;
  assert(/^A3 · sung -30 ct/.test(info), `info line reads “${info}”`);
  const foot = doc.querySelector("#overlay .d-foot").getBoundingClientRect();
  assert(foot.bottom <= env.win.innerHeight, "dialog buttons are off screen");
  return info;
});
