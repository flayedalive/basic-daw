// Loudness metering against the EBU conformance signals — Tech 3341 (loudness,
// true peak) and Tech 3342 (range) — synthesized here from their published
// definitions rather than read from the EBU's WAV files.

import test from "node:test";
import assert from "node:assert/strict";
import { measureLoudness, truePeak, gainToTarget } from "../../src/audio/loudness.js";

const dbfs = (db) => Math.pow(10, db / 20);

/** Stereo 1 kHz sine through a list of [dBFS, seconds] segments. */
function tone(sr, segments, hz = 1000) {
  const total = Math.round(segments.reduce((n, s) => n + s[1], 0) * sr);
  const x = new Float32Array(total);
  let i = 0;
  for (const [level, secs] of segments) {
    const a = dbfs(level);
    const end = Math.min(total, i + Math.round(secs * sr));
    for (; i < end; i++) x[i] = a * Math.sin((2 * Math.PI * hz * i) / sr);
  }
  return [x, x];
}
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual.toFixed(2)}, expected ${expected} ±${tol}`);

for (const sr of [44100, 48000, 96000]) {
  test(`Tech 3341 cases 1–5 at ${sr / 1000} kHz: integrated loudness within 0.1 LU`, () => {
    near(measureLoudness(tone(sr, [[-23, 20]]), sr).integrated, -23, 0.1, "case 1");
    near(measureLoudness(tone(sr, [[-33, 20]]), sr).integrated, -33, 0.1, "case 2");
    near(measureLoudness(tone(sr, [[-36, 10], [-23, 60], [-36, 10]]), sr).integrated, -23, 0.1, "case 3 (relative gate)");
    near(measureLoudness(tone(sr, [[-72, 10], [-36, 10], [-23, 60], [-36, 10], [-72, 10]]), sr).integrated, -23, 0.1, "case 4 (absolute gate)");
    near(measureLoudness(tone(sr, [[-26, 20], [-20, 20.1], [-26, 20]]), sr).integrated, -23, 0.1, "case 5");
  });
}

test("Tech 3341 case 9: short-term maximum within 0.1 LU", () => {
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push([-20, 1.34], [-30, 1.66]);
  near(measureLoudness(tone(48000, seq), 48000).shortTermMax, -23, 0.1, "short-term max");
});

test("Tech 3341 case 12: momentary maximum within 0.1 LU", () => {
  const seq = [];
  for (let i = 0; i < 25; i++) seq.push([-20, 0.18], [-30, 0.22]);
  near(measureLoudness(tone(48000, seq), 48000).momentaryMax, -23, 0.1, "momentary max");
});

test("K-weighting is not flat: 100 Hz reads lower and 4 kHz higher than 1 kHz", () => {
  const at = (hz) => measureLoudness(tone(48000, [[-23, 10]], hz), 48000).integrated;
  assert.ok(at(100) < -23.5 && at(4000) > -21.5 && at(4000) < -19.5, `100 Hz ${at(100).toFixed(2)}, 4 kHz ${at(4000).toFixed(2)}`);
});

test("Tech 3342 cases 1–4: loudness range within 1 LU", () => {
  const lra = (segs) => measureLoudness(tone(48000, segs), 48000).range;
  near(lra([[-20, 20], [-30, 20]]), 10, 1, "case 1");
  near(lra([[-20, 20], [-15, 20]]), 5, 1, "case 2");
  near(lra([[-40, 20], [-20, 20]]), 20, 1, "case 3");
  near(lra([[-50, 20], [-35, 20], [-20, 20], [-35, 20], [-50, 20]]), 15, 1, "case 4");
});

test("Tech 3341 cases 15–18: true peak of sines whose samples miss the crest", () => {
  // [period in samples, phase in degrees]: all peak at -6.0 dBFS between samples.
  for (const [div, deg] of [[4, 0], [4, 45], [6, 60], [8, 67.5]]) {
    const x = new Float32Array(48000);
    const a = dbfs(-6);
    for (let i = 0; i < x.length; i++) x[i] = a * Math.sin((2 * Math.PI * i) / div + (deg * Math.PI) / 180);
    const tp = 20 * Math.log10(truePeak([x]));
    assert.ok(tp >= -6.4 && tp <= -5.8, `fs/${div} at ${deg}°: ${tp.toFixed(2)} dBTP, expected -6.0 +0.2/-0.4`);
  }
});

test("true peak exceeds sample peak where it should, and PLR follows", () => {
  const sr = 48000;
  const x = new Float32Array(sr * 4);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin((2 * Math.PI * i) / 4 + Math.PI / 4); // samples at ±0.707
  const r = measureLoudness([x, x], sr);
  near(r.samplePeakDb, -3.01, 0.01, "sample peak");
  near(r.truePeakDb, 0, 0.3, "true peak");
  near(r.plr, r.truePeakDb - r.integrated, 1e-9, "PLR");
});

test("silence measures as -Infinity without throwing, and needs no gain", () => {
  const r = measureLoudness([new Float32Array(48000 * 2)], 48000);
  assert.equal(r.integrated, -Infinity);
  assert.equal(gainToTarget(r, -14).gainDb, 0);
});

test("gainToTarget holds the true peak under the ceiling and reports the shortfall", () => {
  const r = measureLoudness(tone(48000, [[-23, 10]]), 48000);
  const free = gainToTarget(r, -30, -1);
  near(free.gainDb, -7, 0.1, "gain down");
  assert.equal(free.limited, false);
  const capped = gainToTarget(r, -14, -1); // +9 dB would put the -23 dBFS peak at -14: fine
  assert.equal(capped.limited, false);
  const hot = gainToTarget(r, 0, -1); // +23 dB would clip
  assert.equal(hot.limited, true);
  near(r.truePeakDb + hot.gainDb, -1, 0.01, "peak after gain");
  near(hot.shortfall, 1, 0.1, "shortfall");
});
