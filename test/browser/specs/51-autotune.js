// 5.8 Auto-Tune: the real-time pitch corrector as an insert. Its processor is
// tested in Node (test/node/autotune.test.mjs); this is the plumbing — the
// bounce, playback, and the delay the host has to hide.

import { test, assert, renderWith, liveRender, diffDb, firstSound, openApp, sleep, fmt } from "../lib.js";
import { newTrack, newClip } from "../../../src/state.js";
import { sing } from "../../node/voice.mjs";
import { trackPitch } from "../../../src/audio/pitchtrack.js";

const SR = 48000;
function voice(midi = 56.6, seconds = 1.4) {
  const { x } = sing(seconds, (t) => (t < 0.15 || t > seconds - 0.15 ? NaN : midi));
  const b = new AudioBuffer({ numberOfChannels: 2, length: x.length, sampleRate: SR });
  b.copyToChannel(x, 0);
  b.copyToChannel(x, 1);
  return b;
}
function medianPitch(buffer, from, to) {
  const t = trackPitch(buffer.getChannelData(0), buffer.sampleRate);
  const v = [];
  for (let f = Math.ceil(from / t.hop); f <= Math.floor(to / t.hop); f++) if (!Number.isNaN(t.midi[f])) v.push(t.midi[f]);
  v.sort((a, b) => a - b);
  return v[v.length >> 1];
}
const src = voice();
const tune = (params = {}) => [{ type: "core.autotune", params: { speed: 20, ...params } }];

test("bounce: a flat note comes out on the note, and starts where it did", async () => {
  const dry = await renderWith(src, []);
  const out = await renderWith(src, tune());
  const before = medianPitch(dry, 0.5, 1.1);
  const after = medianPitch(out, 0.5, 1.1);
  assert(Math.abs(before - 56.6) < 0.03, `source reads ${fmt(before, 3)}`);
  assert(Math.abs(after - 57) < 0.05, `corrected to ${fmt(after, 3)}, wanted 57`);
  const a = firstSound(dry);
  const b = firstSound(out);
  assert(Math.abs(a - b) <= 2, `the note starts at sample ${b}; without the insert, ${a} — the 32 ms is not compensated`);
  return `${fmt(before, 2)} → ${fmt(after, 2)}; onset moved ${b - a} samples`;
});

test("key and scale reach the processor", async () => {
  const x = voice(61.3);
  const chrom = medianPitch(await renderWith(x, tune()), 0.5, 1.1);
  const major = medianPitch(await renderWith(x, tune({ key: "C", scale: "major" })), 0.5, 1.1);
  const aMinor = medianPitch(await renderWith(x, tune({ key: "A", scale: "minor" })), 0.5, 1.1);
  assert(Math.abs(chrom - 61) < 0.05 && Math.abs(major - 62) < 0.06 && Math.abs(aMinor - 62) < 0.06, `chromatic ${fmt(chrom)}, C major ${fmt(major)}, A minor ${fmt(aMinor)}`);
  return `C♯+30 ct → ${fmt(chrom, 2)} chromatic, ${fmt(major, 2)} in C major`;
});

for (const params of [{}, { speed: 0, key: "C", scale: "major" }, { amount: 0.5, variance: 10, speed: 120 }]) {
  test(`${JSON.stringify(params)}: bounce matches live playback sample for sample`, async () => {
    const off = await renderWith(src, tune(params));
    const on = await liveRender(src, tune(params), { settle: 0.4 });
    const d = diffDb(off, on);
    assert(d < -120, `difference ${fmt(d)} dBFS`);
    return `difference ${fmt(d, 0)} dBFS`;
  });
}

test("amount 0 next to a dry copy: the two tracks sum to twice the source (delay compensated to the sample)", async () => {
  const both = await renderWith(src, tune({ amount: 0 }), {
    setup(project, track, clip) {
      const dry = newTrack("dry", 1);
      project.tracks.push(dry);
      project.clips.push(newClip(clip.assetId, dry.id, 0, { fadeIn: 0, fadeOut: 0 }));
    },
  });
  const twice = new AudioBuffer({ numberOfChannels: 2, length: src.length, sampleRate: SR });
  for (let c = 0; c < 2; c++) twice.copyToChannel(src.getChannelData(c).map((v) => 2 * v), c);
  const d = diffDb(both, twice, 0, 0, src.length);
  assert(d < -100, `sum differs from 2× the source by ${fmt(d)} dBFS`);
  return `difference ${fmt(d, 0)} dBFS`;
});

test("in the app: the editor shows key and scale pickers and what the insert is hearing", async () => {
  const win = await openApp();
  const { daw } = win;
  const doc = win.document;
  daw.engine.ensure();
  const rate = daw.engine.sampleRate;
  const x = sing(3, (t) => (t < 0.15 || t > 2.85 ? NaN : 56.6)).x;
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: x.length, sampleRate: 48000 });
  buffer.copyToChannel(x, 0);
  buffer.copyToChannel(x, 1);
  const asset = await daw.pool.addAsset({ name: "vox", buffer });
  const track = daw.state.project.tracks[0];
  daw.timeline.dropAssetAt(asset.id, track.id, 0);
  const fx = daw.plugins.newEffect("core.autotune");
  track.fx.push(fx);
  daw.bus.emit("mix");
  daw.engine.syncGraph?.();
  await sleep(300);
  const { showInspector } = await win.eval('import("/src/ui/inspector.js")');
  showInspector({ kind: "fx", ownerId: track.id, fxId: fx.id });
  await sleep(100);
  const body = doc.querySelector("#insp-body");
  const selects = [...body.querySelectorAll("select")];
  assert(selects.some((s) => [...s.options].some((o) => o.value === "B♭")), "no key picker");
  assert(selects.some((s) => [...s.options].some((o) => o.value === "minor")), "no scale picker");
  assert(Math.abs(daw.engine.latency.total - Math.round(0.032 * rate) / rate) < 1e-9, `engine reports ${daw.engine.latency.total} s of latency`);
  await daw.engine.ensure().resume();
  daw.engine.play(0);
  let text = "";
  const settled = /A3 -4\d ct · correcting \+[34]\d ct/;
  for (let i = 0; i < 50 && !settled.test(text); i++) {
    await sleep(50);
    text = [...body.querySelectorAll(".prow")].find((r) => r.textContent.startsWith("Hearing"))?.textContent ?? "";
  }
  daw.engine.stop();
  assert(settled.test(text), `readout says “${text}”`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return text.replace("Hearing", "");
});
