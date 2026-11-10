// 2.5 Harmonic exciter.

import { test, assert, makeBuffer, sine, plucks, renderWith, liveRender, diffDb, toneLevel, dcOf, fmt } from "../lib.js";

const SR = 48000;

test("exciter: mix 0 leaves the signal untouched", async () => {
  const src = makeBuffer(SR, 1, plucks(0.4));
  const d = diffDb(await renderWith(src, [{ type: "json.exciter", params: { mix: 0 } }]), src);
  assert(d < -100, `difference ${fmt(d)} dBFS`);
});

test("exciter: adds harmonics above the corner and none below it", async () => {
  const run = async (hz) => {
    const out = await renderWith(makeBuffer(SR, 1, sine(hz, 0.2)), [{ type: "json.exciter", params: { freq: 3000, drive: 8, mix: 1 } }]);
    const d = out.getChannelData(0);
    return 20 * Math.log10(toneLevel(d, SR, hz * 2, 9600) / toneLevel(d, SR, hz, 9600));
  };
  const above = await run(4000);
  const below = await run(300);
  assert(above > -40 && below < -70, `2nd harmonic: ${fmt(above)} dB at 4 kHz, ${fmt(below)} dB at 300 Hz`);
  return `2nd harmonic ${fmt(above, 0)} dB re fundamental at 4 kHz; ${fmt(below, 0)} dB at 300 Hz`;
});

test("exciter: bounce matches live playback, no DC", async () => {
  const src = makeBuffer(SR, 1, plucks(0.4));
  const fx = [{ type: "json.exciter", params: { drive: 10, mix: 0.6 } }];
  const off = await renderWith(src, fx);
  const d = diffDb(off, await liveRender(src, fx));
  assert(d < -80, `difference ${fmt(d)} dBFS`);
  assert(Math.abs(dcOf(off) - dcOf(src)) < 1e-4, "adds DC");
  return `difference ${fmt(d, 0)} dBFS`;
});
