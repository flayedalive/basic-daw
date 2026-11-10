// 2.6 Multiband compressor.

import { test, assert, makeBuffer, sine, plucks, renderWith, liveRender, diffDb, toneLevel, stats, fmt } from "../lib.js";
import { FFT } from "../../../src/audio/fft.js";

const SR = 48000;
const flat = { lowRatio: 1, midRatio: 1, highRatio: 1 };

test("multiband: at 1:1 the bands sum flat within 0.1 dB, 20 Hz – 20 kHz", async () => {
  let worst = 0;
  // Three crossover placements, including the two extremes.
  for (const x of [{}, { xLow: 60, xHigh: 1000 }, { xLow: 1000, xHigh: 10000 }]) {
    const N = 65536;
    const imp = makeBuffer(SR, N / SR, (t, i) => (i === 0 ? 0.5 : 0));
    const out = await renderWith(imp, [{ type: "core.multiband", params: { ...flat, ...x } }]);
    const re = Float64Array.from(out.getChannelData(0).subarray(0, N));
    const im = new Float64Array(N);
    new FFT(N).forward(re, im);
    for (let k = Math.ceil((20 * N) / SR); k <= Math.floor((20000 * N) / SR); k++) {
      worst = Math.max(worst, Math.abs(20 * Math.log10(Math.hypot(re[k], im[k]) / 0.5)));
    }
  }
  assert(worst < 0.1, `deviation ${fmt(worst, 3)} dB`);
  return `worst deviation ${fmt(worst, 3)} dB`;
});

test("multiband: at 1:1 it is the dry signal, 6 ms late, to within 0.1 dB at any frequency", async () => {
  // Magnitude is flat but phase is not (the crossovers are an all-pass), so the
  // comparison is per tone rather than a waveform null.
  const notes = [];
  for (const hz of [50, 200, 1000, 2500, 8000, 16000]) {
    const src = makeBuffer(SR, 1, sine(hz, 0.25));
    const out = await renderWith(src, [{ type: "core.multiband", params: flat }]);
    const g = 20 * Math.log10(toneLevel(out.getChannelData(0), SR, hz, 24000) / 0.25);
    assert(Math.abs(g) < 0.1, `${hz} Hz: ${fmt(g, 3)} dB`);
    notes.push(fmt(g, 3));
  }
  return `gain at 50 Hz … 16 kHz: ${notes.join(", ")} dB`;
});

test("multiband: the native compressor's hidden makeup gain is cancelled", async () => {
  // Far below every threshold, a band should pass at unity whatever its ratio.
  const notes = [];
  for (const [hz, id] of [[80, "low"], [800, "mid"], [8000, "high"]]) {
    for (const [thr, ratio] of [[-24, 4], [-40, 12], [-12, 2]]) {
      const src = makeBuffer(SR, 1, sine(hz, 0.0005)); // -66 dBFS
      const out = await renderWith(src, [{ type: "core.multiband", params: { ...flat, [`${id}Thresh`]: thr, [`${id}Ratio`]: ratio } }]);
      const g = 20 * Math.log10(toneLevel(out.getChannelData(0), SR, hz, 24000) / 0.0005);
      assert(Math.abs(g) < 0.25, `${id} band, threshold ${thr}, ratio ${ratio}: quiet signal passes at ${fmt(g)} dB`);
      notes.push(fmt(g, 2));
    }
  }
  return `below-threshold gain over 9 settings: ${notes.join(", ")} dB`;
});

test("multiband: a band compresses only its own band", async () => {
  const src = makeBuffer(SR, 1.5, (t) => 0.4 * Math.sin(2 * Math.PI * 80 * t) + 0.05 * Math.sin(2 * Math.PI * 5000 * t));
  const out = await renderWith(src, [{ type: "core.multiband", params: { ...flat, lowThresh: -30, lowRatio: 8 } }]);
  const d = out.getChannelData(0);
  const low = 20 * Math.log10(toneLevel(d, SR, 80, 36000) / 0.4);
  const high = 20 * Math.log10(toneLevel(d, SR, 5000, 36000) / 0.05);
  assert(low < -8 && Math.abs(high) < 0.2, `80 Hz ${fmt(low)} dB, 5 kHz ${fmt(high)} dB`);
  return `80 Hz ${fmt(low, 1)} dB, 5 kHz ${fmt(high, 2)} dB`;
});

test("multiband: bounce matches live playback", async () => {
  const src = makeBuffer(SR, 1.5, plucks(0.6));
  const fx = [{ type: "core.multiband", params: { lowRatio: 4, midRatio: 3, highRatio: 3, midThresh: -30 } }];
  const off = await renderWith(src, fx);
  const on = await liveRender(src, fx, { settle: 1.2 });
  const d = diffDb(off, on);
  assert(Math.abs(stats(off).rmsDb - stats(on).rmsDb) < 0.1, "rms differs");
  assert(d < -60, `difference ${fmt(d)} dBFS`);
  return `difference ${fmt(d, 0)} dBFS`;
});
