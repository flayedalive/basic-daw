// 2.9 Time stretch: the clip plumbing around audio/stretch.js (whose DSP is
// tested in Node — test/node/stretch.test.mjs).

import { test, assert, makeBuffer, renderWith, openApp, sleep, captureEngine, firstSound, stats, toneLevel, fmt } from "../lib.js";
import { stretch } from "../../../src/audio/stretch.js";
import { detectPitch, refinePitch } from "../../../src/plugins/pitch.js";

const SR = 48000;
/** A sung-ish phrase: three notes with harmonics, so pitch and timing are both measurable. */
const phrase = (t) => {
  const hz = t < 0.7 ? 220 : t < 1.4 ? 261.63 : 329.63;
  const local = t % 0.7;
  const env = Math.min(1, local / 0.02) * Math.min(1, (0.7 - local) / 0.05);
  let v = 0;
  for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * hz * h * t) / h;
  return 0.25 * env * v;
};
const src = makeBuffer(SR, 2.1, phrase);
const pitchAt = (buf, sec) => {
  const seg = buf.getChannelData(0).subarray(Math.round(sec * SR), Math.round(sec * SR) + 8192);
  return refinePitch(seg, SR, detectPitch(seg, SR, { minHz: 80, maxHz: 1000 }).hz);
};
const cents = (a, b) => 1200 * Math.log2(a / b);
const maxDiff = (a, b, n) => {
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(a[i] - b[i]));
  return 20 * Math.log10(p + 1e-12);
};

test("a pitch-locked clip bounces as the stretched copy, sample for sample", async () => {
  const rate = 0.8; // 125% length
  const out = await renderWith(src, [], { clip: { rate, pitchLock: true, stretchMode: "mono", duration: src.duration / rate } });
  const want = stretch([src.getChannelData(0), src.getChannelData(1)], SR, { ratio: 1 / rate, mode: "mono" });
  assert(Math.abs(out.length - want[0].length) <= 2, `length ${out.length} vs ${want[0].length}`);
  const d = maxDiff(out.getChannelData(0), want[0], Math.min(out.length, want[0].length));
  assert(d < -100, `bounce differs from the stretch by ${fmt(d)} dBFS`);
  const c = cents(pitchAt(out, 0.2), 220);
  assert(Math.abs(c) < 2, `pitch moved ${fmt(c)} cents`);
  return `length ×${fmt(out.duration / src.duration, 3)}, pitch ${fmt(c, 2)} cents from source`;
});

test("without pitch lock a slowed clip still drops in pitch, as before", async () => {
  const out = await renderWith(src, [], { clip: { rate: 0.8, duration: src.duration / 0.8 } });
  const c = cents(pitchAt(out, 0.2), 220);
  assert(Math.abs(c - 1200 * Math.log2(0.8)) < 3, `pitch moved ${fmt(c)} cents`);
  return `${fmt(c, 0)} cents`;
});

test("pitch shift alone: pitch moves, length and timing stay", async () => {
  const out = await renderWith(src, [], { clip: { detune: 300, pitchLock: true, stretchMode: "mono" } });
  assert(Math.abs(out.length - src.length) <= 2, "length changed");
  const c = cents(pitchAt(out, 0.2), 220);
  assert(Math.abs(c - 300) < 4, `pitch moved ${fmt(c)} cents`);
  const c2 = cents(pitchAt(out, 1.6), 329.63);
  assert(Math.abs(c2 - 300) < 4, `third note moved ${fmt(c2)} cents: timing slipped`);
  return `+${fmt(c, 1)} cents on note 1, +${fmt(c2, 1)} on note 3`;
});

test("a trimmed, offset, stretched clip plays the right part of the stretch", async () => {
  const rate = 1.25; // 80% length
  // Start 0.7 s into the source (the second note) and play 0.4 s of timeline.
  const out = await renderWith(src, [], { clip: { rate, pitchLock: true, stretchMode: "mono", offset: 0.7, duration: 0.4 }, end: 0.4 });
  const c = cents(pitchAt(out, 0.1), 261.63);
  assert(Math.abs(c) < 3, `expected the second note, got ${fmt(c)} cents away`);
});

test("reverse and stretch combine", async () => {
  const rate = 0.8;
  const out = await renderWith(src, [], { clip: { rate, pitchLock: true, stretchMode: "mono", reverse: true, duration: src.duration / rate } });
  // Reversed: the last note (E) comes first.
  const c = cents(pitchAt(out, 0.3), 329.63);
  assert(Math.abs(c) < 3, `first note is ${fmt(c)} cents from E`);
});

test("in the app: playback of a stretched clip is the bounce, sample for sample", async () => {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  const rate = daw.engine.sampleRate;
  const buffer = makeBuffer(rate, 2.1, phrase);
  const asset = await daw.pool.addAsset({ name: "phrase", buffer });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  const clip = daw.state.project.clips[0];
  Object.assign(clip, { rate: 0.8, pitchLock: true, stretchMode: "poly", duration: buffer.duration / 0.8, fadeIn: 0, fadeOut: 0 });
  const { requestStretch, stretchProgress } = await win.eval('import("/src/audio/clipaudio.js")');
  assert(stretchProgress(clip) === 0, "should start un-rendered");
  await requestStretch(clip);
  assert(stretchProgress(clip) === 1, "stretch did not finish");
  daw.engine.invalidate();
  const cap = await captureEngine(win, 3.6);
  daw.engine.play(0);
  const live = await cap.done;
  daw.engine.stop();
  const bounce = await daw.render.renderRange(0, clip.duration, { sampleRate: rate, tailSec: 0 });
  const a = firstSound(live);
  const b = firstSound(bounce);
  assert(a > 0 && b >= 0, "nothing captured");
  const n = Math.min(live.length - a, bounce.length - b) - 64;
  const x = live.getChannelData(0).subarray(a);
  const y = bounce.getChannelData(0).subarray(b);
  const d = maxDiff(x, y, n);
  assert(d < -80, `playback and bounce differ by ${fmt(d)} dBFS over ${fmt(n / rate, 2)} s`);
  return `difference ${fmt(d, 0)} dBFS over ${fmt(n / rate, 2)} s at ${rate} Hz`;
});

test("in the app: inspector controls and Alt-drag stretch", async () => {
  const win = await openApp();
  const { daw } = win;
  const doc = win.document;
  daw.engine.ensure();
  const asset = await daw.pool.addAsset({ name: "phrase", buffer: makeBuffer(SR, 2.1, phrase) });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  const clip = () => daw.state.project.clips[0];
  daw.state.selection.clear();
  daw.state.selection.add(clip().id);
  const { showInspector } = await win.eval('import("/src/ui/inspector.js")');
  showInspector({ kind: "clip" });
  daw.bus.emit("selection");
  await sleep(150);

  // Alt-drag the right edge out to 1.5× the length.
  const lanes = doc.querySelector("#lanes");
  const r = lanes.getBoundingClientRect();
  const rect = daw.timeline.clipRect(clip());
  const y = r.top + rect.y + rect.h / 2;
  const x0 = r.left + rect.x + rect.w - 2;
  const x1 = r.left + rect.x + rect.w * 1.5;
  const ev = (type, x, extra = {}) => new win.PointerEvent(type, { clientX: x, clientY: y, button: 0, pointerId: 1, bubbles: true, altKey: true, shiftKey: true, ...extra });
  lanes.dispatchEvent(ev("pointerdown", x0));
  win.dispatchEvent(ev("pointermove", (x0 + x1) / 2));
  win.dispatchEvent(ev("pointermove", x1));
  win.dispatchEvent(ev("pointerup", x1));
  await sleep(100);
  const c = clip();
  assert(c.pitchLock === true, "Alt-drag did not turn pitch lock on");
  assert(Math.abs(c.duration / 2.1 - 1.5) < 0.03 && Math.abs(c.rate - 1 / 1.5) < 0.02, `duration ×${fmt(c.duration / 2.1, 3)}, rate ${fmt(c.rate, 3)}`);

  // The background render starts by itself once edits settle, and finishes.
  const { stretchProgress } = await win.eval('import("/src/audio/clipaudio.js")');
  for (let i = 0; i < 200 && stretchProgress(clip()) !== 1; i++) await sleep(50);
  assert(stretchProgress(clip()) === 1, "background stretch never completed");

  // The inspector shows the lock, a mode picker and the length in percent.
  await sleep(150);
  const body = doc.querySelector("#insp-body");
  const lock = [...body.querySelectorAll("input[type=checkbox]")].find((i) => i.closest(".prow")?.textContent.includes("Pitch lock"));
  assert(lock?.checked, "pitch lock checkbox not shown as on");
  const mode = [...body.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "drums"));
  assert(mode, "no stretch mode picker");
  mode.value = "mono";
  mode.dispatchEvent(new win.Event("change"));
  await sleep(50);
  assert(clip().stretchMode === "mono", "mode not written");
  daw.undo();
  daw.undo();
  await sleep(50);
  assert(!clip().pitchLock && Math.abs(clip().duration - 2.1) < 1e-6, "undo did not restore the unstretched clip");
  assert(!win.__errors.length, win.__errors.join("; "));
  return `Alt-drag → ${fmt(100 / c.rate, 0)}% length, pitch lock on, rendered in the background`;
});
