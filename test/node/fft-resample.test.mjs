import test from "node:test";
import assert from "node:assert/strict";
import { FFT, magnitudes } from "../../src/audio/fft.js";
import { resample, resampleTo } from "../../src/audio/resample.js";
import { sine, noise, tone, db, diffDb, rms } from "./helpers.mjs";

test("FFT: inverse(forward(x)) = x, and a sine lands in its bin", () => {
  const n = 1024;
  const x = noise(n, 1, 7);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  const f = new FFT(n);
  f.forward(re, im);
  f.inverse(re, im);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(re[i] - x[i]) < 1e-9);
  const m = magnitudes(sine(n, 48000, (48000 * 32) / n, 0.5), { window: false });
  assert.ok(Math.abs(m[32] - 0.5) < 1e-6);
  assert.ok(m[31] < 1e-6 && m[33] < 1e-6);
});

test("resample: 48k → 96k → 48k nulls below -80 dB and keeps level", () => {
  const sr = 48000;
  const x = new Float32Array(sr / 2);
  for (const hz of [110, 1000, 5000, 15000]) sine(x.length, sr, hz, 0.2).forEach((v, i) => (x[i] += v));
  const up = resample(x, sr, 96000);
  assert.equal(up.length, x.length * 2);
  const back = resample(up, 96000, sr);
  const d = diffDb(x, back, 2000, x.length - 2000);
  assert.ok(d < -80, `round trip differs by ${d.toFixed(1)} dB`);
  for (const hz of [110, 1000, 5000, 15000]) {
    const g = db(tone(up, 96000, hz, 4000, up.length - 4000) / 0.2);
    assert.ok(Math.abs(g) < 0.05, `${hz} Hz gain ${g.toFixed(3)} dB after upsampling`);
  }
});

test("resample: downsampling removes what would alias", () => {
  const x = sine(96000, 96000, 30000, 0.5); // above the 22.05 kHz target Nyquist
  const y = resample(x, 96000, 44100);
  assert.ok(db(rms(y, 1000, y.length - 1000)) < -80, `alias at ${db(rms(y)).toFixed(1)} dB`);
  const ok = resample(sine(96000, 96000, 1000, 0.5), 96000, 44100);
  assert.ok(Math.abs(db(tone(ok, 44100, 1000, 1000, ok.length - 1000) / 0.5)) < 0.01);
});

test("resampleTo: an arbitrary step shifts pitch by exactly that ratio", () => {
  const sr = 48000;
  const x = sine(sr, sr, 440, 0.5);
  const step = 2 ** (3 / 12); // up a minor third
  const y = resampleTo(x, Math.floor(x.length / step), step);
  const hz = 440 * step;
  assert.ok(Math.abs(db(tone(y, sr, hz, 1000, y.length - 1000) / 0.5)) < 0.02);
});
