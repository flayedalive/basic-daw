// Phase 4.1 and 4.2: the true-peak limiter as an insert, and mastering a bounce
// to a loudness target with it. (The processor's own behaviour is tested in
// Node: test/node/limiter.test.mjs.)

import { test, assert, ready, makeBuffer, noise, renderWith, liveRender, diffDb, openApp, sleep, fmt } from "../lib.js";
import { measureBuffer } from "../../../src/audio/loudness.js";
import { masterToTarget, limitBuffer, MASTER_PRESETS } from "../../../src/audio/master.js";

/** A dynamic test mix: kick, snare, bass, a chord and hats, with headroom. */
function mix(sr, seconds, level = 0.25) {
  const rnd = noise(1, 4);
  return makeBuffer(sr, seconds, (t, i, c) => {
    const beat = t % 0.5;
    const kick = Math.exp(-beat * 14) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 35)) * beat);
    const s = (t + 0.25) % 0.5;
    const snare = s < 0.12 ? Math.exp(-s * 30) * rnd() : 0;
    const bass = 0.35 * Math.sin(2 * Math.PI * 55 * t) + 0.15 * Math.sin(2 * Math.PI * 110 * t);
    let chord = 0;
    for (const hz of [220, 277.18, 329.63]) chord += Math.sin(2 * Math.PI * hz * t + hz + c);
    const hat = (t * 8) % 1 < 0.04 ? rnd() * 0.3 : 0;
    // A quieter middle eight, so there is some loudness range to keep.
    const section = t > seconds * 0.4 && t < seconds * 0.6 ? 0.5 : 1;
    return level * section * (0.9 * kick + 0.6 * snare + bass + 0.15 * chord + (c ? -hat : hat));
  });
}

for (const sr of [44100, 48000, 96000]) {
  test(`limiter insert at ${sr / 1000} kHz: the bounce holds its true-peak ceiling`, async () => {
    const src = mix(sr, 4, 0.6);
    const out = await renderWith(src, [], { masterFx: [{ type: "core.maximizer", params: { gain: 12, ceiling: -1 } }], sampleRate: sr });
    const r = measureBuffer(out);
    assert(r.truePeakDb <= -1, `true peak ${fmt(r.truePeakDb, 3)} dBTP`);
    assert(r.truePeakDb > -1.5, `not actually limiting: ${fmt(r.truePeakDb)} dBTP`);
    return `true peak ${fmt(r.truePeakDb, 2)} dBTP, ${fmt(r.integrated, 1)} LUFS`;
  });
}

test("limiter insert: bounce matches live playback sample for sample, and stays on the timeline", async () => {
  const src = mix(48000, 3, 0.6);
  const fx = [{ type: "core.maximizer", params: { gain: 9, ceiling: -1, lookahead: 5 } }];
  const off = await renderWith(src, fx);
  const on = await liveRender(src, fx);
  const d = diffDb(off, on);
  assert(d < -120, `difference ${fmt(d)} dBFS`);
  // Under the ceiling it is transparent, and its look-ahead has been taken back out.
  const quiet = mix(48000, 1, 0.05);
  const through = await renderWith(quiet, [{ type: "core.maximizer" }]);
  const t = diffDb(through, quiet, 0, 0, quiet.length - 400);
  assert(t < -120, `not transparent under the ceiling (${fmt(t)} dBFS)`);
  return `live vs bounce ${fmt(d, 0)} dBFS; transparent and in place under the ceiling`;
});

for (const preset of MASTER_PRESETS) {
  test(`master to target — ${preset.label}`, async () => {
    await ready();
    const src = await renderWith(mix(48000, 24), []);
    const before = measureBuffer(src);
    const m = await masterToTarget(src, { target: preset.target, ceiling: preset.ceiling, plrFloor: 4 });
    assert(Math.abs(m.report.integrated - preset.target) <= 0.2, `landed at ${fmt(m.report.integrated)} LUFS`);
    assert(m.report.truePeakDb <= preset.ceiling, `true peak ${fmt(m.report.truePeakDb, 3)} dBTP over ${preset.ceiling}`);
    assert(m.buffer.length === src.length, "length changed");
    return `${fmt(before.integrated, 1)} LUFS / ${fmt(before.truePeakDb, 1)} dBTP → ${fmt(m.report.integrated, 2)} LUFS / ${fmt(m.report.truePeakDb, 2)} dBTP in ${m.passes} pass${m.passes > 1 ? "es" : ""} (+${fmt(m.gainDb, 1)} dB in, PLR ${fmt(m.report.plr, 1)})`;
  });
}

test("master to target: the PLR floor stops it and the shortfall is reported", async () => {
  await ready();
  const src = await renderWith(mix(48000, 24), []);
  const m = await masterToTarget(src, { target: -6, ceiling: -1, plrFloor: 9 });
  assert(m.limited && Math.abs(m.shortfall - 4) < 0.05, `shortfall ${fmt(m.shortfall)} LU`);
  assert(Math.abs(m.report.integrated + 10) <= 0.2, `stopped at ${fmt(m.report.integrated)} LUFS, expected -10`);
  assert(m.report.plr >= 8.8, `PLR ${fmt(m.report.plr)} dB`);
  assert(m.report.truePeakDb <= -1, "ceiling broken");
  return `asked for -6, kept PLR ${fmt(m.report.plr, 1)} dB: stopped at ${fmt(m.report.integrated, 1)} LUFS, ${fmt(m.shortfall, 1)} LU short`;
});

test("master to target: a quiet target is plain gain, one pass", async () => {
  await ready();
  const src = await renderWith(mix(48000, 12), []);
  const m = await masterToTarget(src, { target: -30, ceiling: -1 });
  assert(m.passes === 1 && Math.abs(m.report.integrated + 30) < 0.1, `${m.passes} passes, ${fmt(m.report.integrated)} LUFS`);
});

test("limitBuffer keeps length and timing", async () => {
  await ready();
  const click = makeBuffer(48000, 0.5, (t, i) => (i === 12000 ? 0.5 : 0));
  const out = await limitBuffer(click, { gainDb: 0, ceilingDb: -1 });
  assert(out.length === click.length && Math.abs(out.getChannelData(0)[12000] - 0.5) < 1e-6, "impulse moved");
});

test("bounce dialog: Streaming preset masters the file and reports it", async () => {
  const win = await openApp();
  const { daw } = win;
  daw.engine.ensure();
  const asset = await daw.pool.addAsset({ name: "mix", buffer: mix(daw.engine.sampleRate, 12) });
  daw.timeline.dropAssetAt(asset.id, daw.state.project.tracks[0].id, 0);
  let bytes = 0;
  win.HTMLAnchorElement.prototype.click = function () {
    bytes = 1;
  };
  const { bounceDialog } = await win.eval('import("/src/project.js")');
  bounceDialog("master");
  await sleep(100);
  const doc = win.document;
  const pick = [...doc.querySelectorAll("#overlay select")].find((s) => [...s.options].some((o) => o.value === "streaming"));
  assert(pick, "no master-to-target option");
  pick.value = "streaming";
  pick.dispatchEvent(new win.Event("change"));
  assert(doc.querySelector("#overlay").textContent.includes("Keep PLR"), "target fields not shown");
  [...doc.querySelectorAll("#overlay button")].find((b) => b.textContent === "Bounce").click();
  for (let i = 0; i < 400 && !doc.querySelector("#overlay h3")?.textContent.includes("report"); i++) await sleep(50);
  const text = doc.querySelector("#overlay").textContent.replace(/\s+/g, " ");
  const lufs = Number(/Integrated(-?[\d.]+) LUFS/.exec(text)?.[1]);
  const tp = Number(/True peak(-?[\d.]+) dBTP/.exec(text)?.[1]);
  assert(Math.abs(lufs + 14) <= 0.2 && tp <= -1, `report: ${text.slice(0, 160)}`);
  assert(bytes, "nothing was downloaded");
  assert(!win.__errors.length, win.__errors.join("; "));
  return `report: ${lufs} LUFS, ${tp} dBTP`;
});
