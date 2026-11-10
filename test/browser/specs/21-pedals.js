// 2.1 Pedal pack. A DI-ish signal through each pedal: sane audio, no DC, and
// the bounce equal to live playback — sample-for-sample for the static pedals,
// by level for the two with a free-running LFO (its phase is wherever the
// transport happened to start, live).

import { test, assert, makeBuffer, plucks, sine, renderWith, liveRender, stats, diffDb, dcOf, toneLevel, fmt } from "../lib.js";

const SR = 48000;
const di = makeBuffer(SR, 1.5, plucks(0.4));
const STATIC = ["pedal.overdrive", "pedal.distortion", "pedal.fuzz", "pedal.boost", "pedal.octaveup"];
const MODULATED = ["pedal.phaser", "pedal.flanger"];

for (const id of STATIC) {
  test(`${id}: bounce matches live playback`, async () => {
    const off = await renderWith(di, [{ type: id }]);
    const on = await liveRender(di, [{ type: id }]);
    const a = stats(off);
    const b = stats(on);
    assert(a.rms > 1e-3, "silent");
    assert(Math.abs(dcOf(off)) < 2e-3, `DC offset ${dcOf(off)}`);
    const d = diffDb(off, on);
    assert(Math.abs(a.peakDb - b.peakDb) < 0.1 && Math.abs(a.rmsDb - b.rmsDb) < 0.1, `peak ${fmt(a.peakDb)} vs ${fmt(b.peakDb)}, rms ${fmt(a.rmsDb)} vs ${fmt(b.rmsDb)}`);
    assert(d < -60, `difference ${fmt(d)} dBFS`);
    return `rms ${fmt(a.rmsDb, 1)} dB (DI ${fmt(stats(di).rmsDb, 1)}), live-vs-bounce diff ${fmt(d, 0)} dBFS`;
  });
}

for (const id of MODULATED) {
  test(`${id}: bounce matches live playback by level`, async () => {
    // Several LFO cycles, so where the sweep happened to start averages out.
    const long = makeBuffer(SR, 4, plucks(0.4));
    const fx = [{ type: id, params: { rate: 3 } }];
    const off = await renderWith(long, fx);
    const on = await liveRender(long, fx);
    const a = stats(off);
    const b = stats(on);
    assert(Math.abs(a.rmsDb - b.rmsDb) < 0.5, `rms ${fmt(a.rmsDb)} vs ${fmt(b.rmsDb)}`);
    assert(Math.abs(dcOf(off)) < 2e-3 + 2 * Math.abs(dcOf(long)), `DC offset ${dcOf(off)} (input ${dcOf(long)})`);
    return `rms ${fmt(a.rmsDb, 1)} vs live ${fmt(b.rmsDb, 1)} dB`;
  });
}

test("phaser and flanger with the sweep stopped are sample-identical live and bounced", async () => {
  const notes = [];
  for (const id of MODULATED) {
    const fx = [{ type: id, params: { depth: 0 } }];
    const d = diffDb(await renderWith(di, fx), await liveRender(di, fx));
    assert(d < -60, `${id}: difference ${fmt(d)} dBFS`);
    notes.push(`${id.split(".")[1]} ${fmt(d, 0)} dBFS`);
  }
  return notes.join(", ");
});

test("overdrive drives the mids and leaves the lows clean", async () => {
  const thd = async (hz) => {
    const out = await renderWith(makeBuffer(SR, 1, sine(hz, 0.3)), [{ type: "pedal.overdrive", params: { tone: 8000 } }]);
    const d = out.getChannelData(0);
    return toneLevel(d, SR, hz * 3, 9600) / toneLevel(d, SR, hz, 9600);
  };
  const low = await thd(90);
  const mid = await thd(1500);
  assert(mid > low * 4, `3rd harmonic ratio: 90 Hz ${fmt(low, 3)}, 1.5 kHz ${fmt(mid, 3)}`);
  return `3rd harmonic: ${fmt(low * 100, 1)}% at 90 Hz, ${fmt(mid * 100, 1)}% at 1.5 kHz`;
});

test("octave-up puts the octave above the fundamental", async () => {
  const out = await renderWith(makeBuffer(SR, 1, sine(440, 0.4)), [{ type: "pedal.octaveup", params: { mix: 1, focus: 5000, tone: 12000 } }]);
  const d = out.getChannelData(0);
  const f1 = toneLevel(d, SR, 440, 9600);
  const f2 = toneLevel(d, SR, 880, 9600);
  assert(f2 > f1 * 10, `880 Hz ${fmt(f2, 4)} vs 440 Hz ${fmt(f1, 4)}`);
  return `880 Hz is ${fmt(20 * Math.log10(f2 / f1), 0)} dB above 440 Hz`;
});

test("fuzz is asymmetric (even harmonics present)", async () => {
  const out = await renderWith(makeBuffer(SR, 1, sine(220, 0.3)), [{ type: "pedal.fuzz", params: { tone: 10000 } }]);
  const d = out.getChannelData(0);
  const h2 = toneLevel(d, SR, 440, 9600) / toneLevel(d, SR, 220, 9600);
  assert(h2 > 0.05, `2nd harmonic only ${fmt(h2 * 100, 1)}%`);
  return `2nd harmonic ${fmt(h2 * 100, 0)}%`;
});

test("phaser stage switch and flanger extremes render cleanly", async () => {
  for (const fx of [
    { type: "pedal.phaser", params: { six: true, depth: 1, reso: 4 } },
    { type: "pedal.flanger", params: { feedback: 0.9, depth: 1, manual: 3 } },
    { type: "pedal.flanger", params: { feedback: -0.9, depth: 1, manual: 10 } },
  ]) {
    const s = stats(await renderWith(di, [fx], { tailSec: 0.5 }));
    assert(Number.isFinite(s.peak) && s.peak < 4, `${fx.type} peak ${s.peak}`);
  }
});
