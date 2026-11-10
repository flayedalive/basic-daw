// Phase 4.3–4.5: bus compressor, the multiband on it, de-esser. The processors
// themselves are tested in Node (test/node/dynamics.test.mjs); this is the
// plugins through the real bounce and a real-time context.

import { test, assert, makeBuffer, noise, plucks, renderWith, liveRender, diffDb, stats, toneLevel, fmt } from "../lib.js";

const SR = 48000;
const rnd = noise(0.3, 6);
/** Kick, bass and noise hats: something for a bus compressor to chew on. */
const loop = makeBuffer(SR, 3, (t) => {
  const b = t % 0.5;
  return 0.6 * Math.exp(-b * 12) * Math.sin(2 * Math.PI * (55 + 70 * Math.exp(-b * 30)) * b) + 0.2 * Math.sin(2 * Math.PI * 110 * t) + ((t * 4) % 1 < 0.05 ? rnd() : 0);
});

for (const [type, params] of [
  ["core.buscomp", { threshold: -24, ratio: 4 }],
  ["core.buscomp", { threshold: -30, ratio: 10, auto: true, detector: "peak", scHpf: 200, mix: 0.5, makeup: 6 }],
  ["core.deesser", { frequency: 5000, threshold: -45, range: 18 }],
  ["core.multiband", { lowRatio: 6, midRatio: 3, highRatio: 4, lowThresh: -30 }],
]) {
  test(`${type} ${JSON.stringify(params)}: bounce matches live playback sample for sample`, async () => {
    const fx = [{ type, params }];
    const off = await renderWith(loop, fx);
    const on = await liveRender(loop, fx);
    const d = diffDb(off, on);
    assert(d < -120, `difference ${fmt(d)} dBFS`);
    const change = stats(off).rmsDb - stats(loop).rmsDb;
    assert(diffDb(off, loop) > -40, "the plugin did nothing to this material");
    return `difference ${fmt(d, 0)} dBFS (level change ${fmt(change, 1)} dB)`;
  });
}

test("bus compressor: at 1:1, and at any parallel mix of 1:1, it is the dry signal exactly", async () => {
  for (const mix of [1, 0.5, 0]) {
    const d = diffDb(await renderWith(loop, [{ type: "core.buscomp", params: { ratio: 1, mix } }]), loop);
    assert(d < -130, `mix ${mix}: differs by ${fmt(d)} dBFS`);
  }
});

test("bus compressor: the sidechain high-pass stops the kick pumping the hats", async () => {
  // Level of the 110 Hz bass note as the compressor works: with the detector
  // hearing the kick it is pulled down; with the detector filtered it is not.
  const level = async (scHpf) => {
    const out = await renderWith(loop, [{ type: "core.buscomp", params: { threshold: -30, ratio: 8, scHpf, attack: 3, release: 150 } }]);
    return 20 * Math.log10(toneLevel(out.getChannelData(0), SR, 110, SR, 3 * SR) / toneLevel(loop.getChannelData(0), SR, 110, SR, 3 * SR));
  };
  const open = await level(20);
  const filtered = await level(400);
  assert(filtered - open > 4, `bass at ${fmt(open)} dB unfiltered, ${fmt(filtered)} dB with the detector high-passed`);
  return `110 Hz: ${fmt(open, 1)} dB with a full-range detector, ${fmt(filtered, 1)} dB high-passed at 400 Hz`;
});

test("de-esser: tames a loud sibilant band and leaves the voice alone", async () => {
  // A "voice" at 200 Hz with bursts of 6.5 kHz hiss on top.
  const r = noise(1, 2);
  const src = makeBuffer(SR, 2, (t) => 0.3 * Math.sin(2 * Math.PI * 200 * t) + (t % 0.5 < 0.15 ? 0.25 * Math.sin(2 * Math.PI * 6500 * t) : 0) + 0 * r());
  const out = await renderWith(src, [{ type: "core.deesser", params: { frequency: 6500, threshold: -30, range: 12 } }]);
  const at = (buf, hz, from, to) => 20 * Math.log10(toneLevel(buf.getChannelData(0), SR, hz, Math.round(from * SR), Math.round(to * SR)));
  const ess = at(out, 6500, 0.55, 0.64) - at(src, 6500, 0.55, 0.64);
  const voice = at(out, 200, 0.2, 1.8) - at(src, 200, 0.2, 1.8);
  assert(ess < -8 && Math.abs(voice) < 0.1, `sibilance ${fmt(ess)} dB, voice ${fmt(voice)} dB`);
  const listen = await renderWith(src, [{ type: "core.deesser", params: { frequency: 6500, listen: true } }]);
  assert(at(listen, 200, 0.2, 1.8) < at(src, 200, 0.2, 1.8) - 30, "listen should drop everything outside the band");
  return `sibilance ${fmt(ess, 1)} dB, voice ${fmt(voice, 2)} dB`;
});

test("multiband on the worklet compressor reports no latency and sits on the timeline", async () => {
  const { latencyOf, newEffect } = await import("../../../src/plugins/registry.js");
  assert(latencyOf(newEffect("core.multiband")) === 0 && latencyOf(newEffect("core.buscomp")) === 0, "should add no delay");
  const click = makeBuffer(SR, 0.25, (t, i) => (i === 6000 ? 0.5 : 0));
  const out = await renderWith(click, [{ type: "core.buscomp", params: { ratio: 1 } }]);
  assert(Math.abs(out.getChannelData(0)[6000] - 0.5) < 1e-6, "impulse moved");
});
