// 2.8 Master spectrum analyzer and correlation meter.

import { test, assert, openApp, sleep, makeBuffer, noise, fmt } from "../lib.js";
import { spectrumColumns, correlation } from "../../../src/ui/analyzer.js";

const SR = 48000;

test("spectrumColumns: a tone lands in the column for its frequency; tilt pivots at 1 kHz", () => {
  const bins = 4096;
  const db = new Float32Array(bins).fill(-120);
  const hzPerBin = SR / 2 / bins;
  for (const hz of [100, 1000, 10000]) db[Math.round(hz / hzPerBin)] = -20;
  const w = 300;
  const cols = spectrumColumns(db, SR, w);
  const xOf = (hz) => Math.floor((Math.log(hz / 20) / Math.log(1000)) * w);
  for (const hz of [100, 1000, 10000]) {
    const near = Math.max(cols[xOf(hz) - 1], cols[xOf(hz)], cols[xOf(hz) + 1]);
    assert(near > -40, `${hz} Hz column reads ${fmt(near)} dB`);
  }
  assert(cols[xOf(3000)] < -100, "energy where there is none");
  const tilted = spectrumColumns(db, SR, w, { tilt: true });
  const peak = (arr, hz) => Math.max(arr[xOf(hz) - 1], arr[xOf(hz)], arr[xOf(hz) + 1]);
  const up = peak(tilted, 10000) - peak(cols, 10000);
  const down = peak(tilted, 100) - peak(cols, 100);
  const pivot = peak(tilted, 1000) - peak(cols, 1000);
  assert(Math.abs(up - 14.95) < 0.6 && Math.abs(down + 14.95) < 0.6 && Math.abs(pivot) < 0.3, `tilt: ${fmt(down)} / ${fmt(pivot)} / ${fmt(up)} dB`);
  return `tilt at 100 Hz / 1 kHz / 10 kHz: ${fmt(down, 1)} / ${fmt(pivot, 1)} / +${fmt(up, 1)} dB`;
});

test("correlation: +1 identical, -1 inverted, ~0 unrelated, null when silent", () => {
  const a = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i / 7));
  const inv = a.map((v) => -v);
  const r1 = noise(1, 1);
  const r2 = noise(1, 99);
  const n1 = Float32Array.from({ length: 2048 }, () => r1());
  const n2 = Float32Array.from({ length: 2048 }, () => r2());
  assert(Math.abs(correlation(a, a) - 1) < 1e-6 && Math.abs(correlation(a, inv) + 1) < 1e-6, "identical / inverted");
  assert(Math.abs(correlation(n1, n2)) < 0.1, `unrelated noise reads ${correlation(n1, n2)}`);
  assert(correlation(a, new Float32Array(2048)) === null, "silence");
});

test("in the app: the panel shows a playing tone and an out-of-phase mix", async () => {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  await daw.engine.ctx.resume();
  // 1 kHz with the right channel inverted: a peak at 1 kHz, correlation -1.
  const buffer = makeBuffer(SR, 3, (t, i, c) => (c ? -0.4 : 0.4) * Math.sin(2 * Math.PI * 1000 * t));
  const asset = await daw.pool.addAsset({ name: "phase", buffer });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  const panel = win.document.querySelector(".strip.analyzer");
  assert(panel && panel.querySelector("canvas"), "no analyzer panel in the mixer");
  daw.engine.play(0);
  await sleep(900);
  const { analyzerState } = await win.eval('import("/src/ui/analyzer.js")');
  const st = analyzerState();
  daw.engine.stop();
  const cols = Array.from(st.columns);
  const top = cols.indexOf(Math.max(...cols));
  const hz = 20 * Math.pow(1000, top / cols.length);
  assert(Math.abs(Math.log2(hz / 1000)) < 0.1, `spectrum peaks at ${fmt(hz, 0)} Hz`);
  assert(st.corr < -0.9, `correlation reads ${fmt(st.corr)}`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return `peak at ${fmt(hz, 0)} Hz (${fmt(Math.max(...cols), 0)} dB), correlation ${fmt(st.corr)}`;
});

test("in the app: the live loudness readout agrees with the bounce's report", async () => {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  await daw.engine.ctx.resume();
  const rate = daw.engine.sampleRate;
  const a = Math.pow(10, -20 / 20);
  const asset = await daw.pool.addAsset({ name: "tone", buffer: makeBuffer(rate, 6, (t) => a * Math.sin(2 * Math.PI * 1000 * t)) });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  Object.assign(daw.state.project.clips[0], { fadeIn: 0, fadeOut: 0 });
  for (let i = 0; i < 100 && !daw.engine.master.loudnessNode; i++) await sleep(30);
  assert(daw.engine.master.loudnessNode, "the loudness meter never attached");
  daw.engine.play(0);
  await sleep(4500);
  const { analyzerState } = await win.eval('import("/src/ui/analyzer.js")');
  const shown = analyzerState().loudness;
  const live = { ...daw.engine.loudness };
  daw.engine.stop();
  const { measureBuffer } = await win.eval('import("/src/audio/loudness.js")');
  const ref = measureBuffer(await daw.render.renderRange(0, 4, { sampleRate: rate, tailSec: 0 }));
  assert(Math.abs(live.integrated - ref.integrated) < 0.2, `live ${fmt(live.integrated)} vs bounce ${fmt(ref.integrated)} LUFS`);
  assert(Math.abs(live.truePeak - ref.truePeakDb) < 0.2, `true peak ${fmt(live.truePeak)} vs ${fmt(ref.truePeakDb)}`);
  assert(Math.abs(Number(shown.integrated) - live.integrated) < 0.2 && shown.truePeak !== "–", `panel shows ${JSON.stringify(shown)}`);
  // Pressing play again starts the integration afresh.
  daw.engine.play(5.5);
  await sleep(300);
  daw.engine.stop();
  assert(!win.__errors.length, win.__errors.join("; "));
  return `live ${fmt(live.integrated, 1)} LUFS / ${fmt(live.truePeak, 1)} dBTP; bounce ${fmt(ref.integrated, 1)} / ${fmt(ref.truePeakDb, 1)}`;
});
