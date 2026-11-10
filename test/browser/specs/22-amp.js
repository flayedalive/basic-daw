// 2.2 Amp sim and 2.3 cabinet IR loading.

import { test, assert, ready, makeBuffer, plucks, sine, noise, renderWith, liveRender, stats, diffDb, toneLevel, fmt } from "../lib.js";
import { magnitudes } from "../../../src/audio/fft.js";
import { resample } from "../../../src/audio/resample.js";
import { assets, state } from "../../../src/state.js";
import { addAsset, rehydrateAssets, serializeAssets } from "../../../src/assets.js";
import { encodeWav } from "../../../src/audio/wav.js";
import { fxAssetIds } from "../../../src/plugins/registry.js";

const SR = 48000;
const di = makeBuffer(SR, 1.5, plucks(0.4));
const VOICINGS = ["clean", "crunch", "high gain"];

for (const voicing of VOICINGS) {
  test(`amp (${voicing}): bounce matches live playback`, async () => {
    const fx = [{ type: "core.amp", params: { voicing } }];
    const off = await renderWith(di, fx);
    const on = await liveRender(di, fx);
    const d = diffDb(off, on);
    const a = stats(off);
    const b = stats(on);
    assert(Math.abs(a.peakDb - b.peakDb) < 0.1 && Math.abs(a.rmsDb - b.rmsDb) < 0.1, `peak ${fmt(a.peakDb)} vs ${fmt(b.peakDb)}, rms ${fmt(a.rmsDb)} vs ${fmt(b.rmsDb)}`);
    assert(d < -60, `difference ${fmt(d)} dBFS`);
    return `rms ${fmt(a.rmsDb, 1)} dB, peak ${fmt(a.peakDb, 1)} (DI rms ${fmt(stats(di).rmsDb, 1)}), diff ${fmt(d, 0)} dBFS`;
  });
}

/** Energy that is not at a harmonic of the input, relative to the loudest harmonic. */
async function aliasDb(bin, params) {
  const N = 32768;
  const hz = (bin * SR) / N;
  const out = await renderWith(makeBuffer(SR, 1.5, sine(hz, 0.5)), [{ type: "core.amp", params }]);
  const tail = out.getChannelData(0).subarray(out.length - N);
  const mag = magnitudes(tail, { window: false, n: N });
  let harm = 0;
  let other = 0;
  for (let i = 8; i < mag.length; i++) {
    if (i % bin === 0) harm = Math.max(harm, mag[i]);
    else other = Math.max(other, mag[i]);
  }
  return 20 * Math.log10(other / harm);
}

test("amp: no aliasing whistle on high notes at high gain", async () => {
  // E6 is the top of a 24-fret guitar. Everything in the test sits on an FFT
  // bin, so any energy off the harmonic series is aliasing and nothing else.
  const E6 = 900;
  const worst = await aliasDb(E6, { voicing: "high gain", gain: 10, cab: false });
  const typical = await aliasDb(E6, { voicing: "high gain", gain: 6 });
  const mid = await aliasDb(300, { voicing: "high gain", gain: 10, cab: false });
  assert(worst < -40, `gain 10, cab off: strongest alias ${fmt(worst, 1)} dB re the loudest harmonic`);
  assert(typical < -50, `gain 6, cab on: strongest alias ${fmt(typical, 1)} dB`);
  return `strongest alias re loudest harmonic — E6 gain 10 cab off: ${fmt(worst, 0)} dB; E6 gain 6 with cab: ${fmt(typical, 0)} dB; E4 gain 10 cab off: ${fmt(mid, 0)} dB`;
});

test("amp: tone controls and gain do what they say", async () => {
  const band = async (params, lo, hi) => {
    const out = await renderWith(di, [{ type: "core.amp", params: { voicing: "crunch", cab: false, ...params } }]);
    const mag = magnitudes(out.getChannelData(0).subarray(0, 65536));
    let s = 0;
    for (let i = Math.round((lo / SR) * 65536); i < Math.round((hi / SR) * 65536); i++) s += mag[i] ** 2;
    return 10 * Math.log10(s);
  };
  const treble = (await band({ treble: 10 }, 4000, 8000)) - (await band({ treble: 0 }, 4000, 8000));
  const bass = (await band({ bass: 10 }, 60, 160)) - (await band({ bass: 0 }, 60, 160));
  assert(treble > 6 && bass > 6, `treble swing ${fmt(treble)} dB, bass swing ${fmt(bass)} dB`);
  const thd = async (gain, voicing) => {
    const out = await renderWith(makeBuffer(SR, 1, sine(220, 0.2)), [{ type: "core.amp", params: { voicing, gain, cab: false } }]);
    const d = out.getChannelData(0);
    return toneLevel(d, SR, 660, 9600) / toneLevel(d, SR, 220, 9600);
  };
  const clean = await thd(3, "clean");
  const high = await thd(7, "high gain");
  assert(clean < 0.03 && high > 0.08 && high > clean * 20, `3rd harmonic: clean ${fmt(clean, 3)}, high gain ${fmt(high, 3)}`);
  return `treble ±${fmt(treble / 2, 0)} dB, bass ±${fmt(bass / 2, 0)} dB; 3rd harmonic clean ${fmt(clean * 100, 1)}%, high gain ${fmt(high * 100, 0)}%`;
});

/* ── cabinet impulse responses ────────────────────────────────────────── */

/** The built-in cabinet's own impulse response at `rate`: a realistic IR to load back in. */
async function modelIr(rate = SR) {
  const impulse = makeBuffer(rate, 0.25, (t, i) => (i === 0 ? 1 : 0));
  return renderWith(impulse, [{ type: "core.cab" }], { sampleRate: rate });
}

async function poolIr(rate = SR) {
  await ready();
  const buffer = await modelIr(rate);
  const asset = await addAsset({ name: "test-ir", buffer, blob: encodeWav(buffer, 24) });
  return asset.id;
}

const program = (rate) =>
  makeBuffer(rate, 1, (t) => plucks(0.3)(t) + 0.05 * Math.sin(2 * Math.PI * 200 * t) + 0.05 * Math.sin(2 * Math.PI * 1000 * t) + 0.05 * Math.sin(2 * Math.PI * 3000 * t));

test("cab IR: loading the model's own IR matches the model, level included", async () => {
  const ir = await poolIr();
  const a = await renderWith(program(SR), [{ type: "core.cab" }]);
  const b = await renderWith(program(SR), [{ type: "core.cab", params: { ir } }]);
  const dRms = stats(b).rmsDb - stats(a).rmsDb;
  assert(Math.abs(dRms) < 1, `IR is ${fmt(dRms)} dB off the model's level`);
  return `level-matched to ${fmt(dRms)} dB`;
});

test("cab IR: a 96 kHz bounce of a 48 kHz IR sounds the same", async () => {
  const ir = await poolIr(SR);
  const fx = [{ type: "core.cab", params: { ir } }];
  const at48 = await renderWith(program(SR), fx, { sampleRate: SR });
  const at96 = await renderWith(program(96000), fx, { sampleRate: 96000 });
  const notes = [];
  for (const hz of [200, 1000, 3000]) {
    const a = toneLevel(at48.getChannelData(0), SR, hz, 4800);
    const b = toneLevel(at96.getChannelData(0), 96000, hz, 9600);
    const d = 20 * Math.log10(b / a);
    assert(Math.abs(d) < 0.1, `${hz} Hz differs by ${fmt(d, 3)} dB`);
    notes.push(`${hz} Hz ${d >= 0 ? "+" : ""}${fmt(d, 3)} dB`);
  }
  const down = resample(at96.getChannelData(0), 96000, SR);
  const a = at48.getChannelData(0);
  let peak = 0;
  for (let i = 2000; i < a.length - 2000; i++) peak = Math.max(peak, Math.abs(a[i] - down[i]));
  const nullDb = 20 * Math.log10(peak);
  assert(nullDb < -50, `nulls only to ${fmt(nullDb)} dBFS`);
  return `${notes.join(", ")}; null ${fmt(nullDb, 0)} dBFS`;
});

test("cab IR: the selection survives save and reload", async () => {
  await ready();
  // Deliberately nothing like the built-in cabinet, so using it is unmistakable.
  const rnd = noise(1, 5);
  const irBuf = makeBuffer(SR, 0.05, (t) => rnd() * Math.exp(-t * 120));
  const ir = (await addAsset({ name: "odd-ir", buffer: irBuf, blob: encodeWav(irBuf, 24) })).id;
  const fx = [{ type: "core.amp", params: { voicing: "crunch", ir } }];
  await renderWith(di, fx);
  assert(fxAssetIds(state.project).has(ir), "the pool does not see the IR as in use");
  const saved = JSON.parse(JSON.stringify({ project: state.project, assets: serializeAssets() }));
  assert(saved.project.tracks[0].fx[0].params.ir === ir, "asset id did not serialize");
  // Reload: the pool is rebuilt from the blobs in IndexedDB.
  assets.clear();
  await rehydrateAssets(saved.assets);
  assert(assets.get(ir)?.buffer, "IR did not come back from storage");
  const before = await renderWith(di, fx);
  assets.get(ir).irCache = undefined;
  const again = await renderWith(di, fx);
  const model = await renderWith(di, [{ type: "core.amp", params: { voicing: "crunch" } }]);
  assert(diffDb(before, again) < -100, "reloaded IR renders differently");
  assert(diffDb(before, model) > -40, "IR path is not actually in use");
  return "id serialized, audio rehydrated, render identical";
});

test("cab IR: a missing IR falls back to the built-in cabinet", async () => {
  const model = await renderWith(di, [{ type: "core.cab" }]);
  const missing = await renderWith(di, [{ type: "core.cab", params: { ir: "ast_gone" } }]);
  const d = diffDb(model, missing);
  assert(d < -100, `fallback differs from the model by ${fmt(d)} dBFS`);
});
