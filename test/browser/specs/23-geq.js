// 2.4 Graphic EQs.

import { test, assert, makeBuffer, noise, sine, renderWith, liveRender, diffDb, toneLevel, fmt } from "../lib.js";
import { GEQ31_BANDS } from "../../../src/plugins/geq31.js";

const SR = 48000;
const rnd = noise(0.25, 3);
const src = makeBuffer(SR, 1, () => rnd());
const GEQ10 = { hz31: 31.5, hz63: 63, hz125: 125, hz250: 250, hz500: 500, hz1k: 1000, hz2k: 2000, hz4k: 4000, hz8k: 8000, hz16k: 16000 };

for (const type of ["json.geq10", "core.geq31"]) {
  test(`${type}: flat settings null against the dry signal`, async () => {
    const d = diffDb(await renderWith(src, [{ type }]), src);
    assert(d < -100, `difference ${fmt(d)} dBFS`);
    return `difference ${fmt(d, 0)} dBFS`;
  });
}

async function gainAt(type, key, hz, db) {
  const tone = makeBuffer(SR, 1, sine(hz, 0.1));
  const out = await renderWith(tone, [{ type, params: { [key]: db } }]);
  return 20 * Math.log10(toneLevel(out.getChannelData(0), SR, hz, 24000) / toneLevel(tone.getChannelData(0), SR, hz, 24000));
}

test("geq10: each band moves its own centre frequency by what its slider says", async () => {
  let worst = 0;
  for (const [key, hz] of Object.entries(GEQ10)) {
    for (const db of [9, -9]) worst = Math.max(worst, Math.abs((await gainAt("json.geq10", key, hz, db)) - db));
  }
  assert(worst < 0.1, `worst error ${fmt(worst, 3)} dB`);
  return `worst error ${fmt(worst, 3)} dB over 10 bands, ±9 dB`;
});

test("geq31: each band moves its own centre frequency by what its slider says", async () => {
  let worst = 0;
  for (const b of GEQ31_BANDS) {
    worst = Math.max(worst, Math.abs((await gainAt("core.geq31", b.key, b.hz, 6)) - 6));
  }
  assert(worst < 0.1, `worst error ${fmt(worst, 3)} dB`);
  return `worst error ${fmt(worst, 3)} dB over 31 bands at +6 dB`;
});

test("geq31: bounce matches live playback with a curve dialled in", async () => {
  const params = Object.fromEntries(GEQ31_BANDS.map((b, i) => [b.key, Math.round(8 * Math.sin(i / 3))]));
  const fx = [{ type: "core.geq31", params }];
  const d = diffDb(await renderWith(src, fx), await liveRender(src, fx));
  assert(d < -80, `difference ${fmt(d)} dBFS`);
  return `difference ${fmt(d, 0)} dBFS`;
});
