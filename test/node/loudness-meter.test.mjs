// The live loudness meter's processor against the offline measurement.

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkletModule, runProcessor } from "../../.claude/skills/daw-plugin/mock-audio.mjs";
import { measureLoudness } from "../../src/audio/loudness.js";
import { rng } from "./helpers.mjs";

const SR = 48000;
await loadWorkletModule(new URL("../../src/plugins/worklets/loudness-meter.js", import.meta.url).href, SR);

function lastReport(l, r) {
  let last = null;
  let reports = 0;
  runProcessor("daw-loudness", [l, r], {}, { sampleRate: SR, onMessage: (m) => ((last = m), reports++) });
  return { ...last, reports };
}

test("a -23 dBFS 1 kHz tone reads -23.0 LUFS momentary, short-term and integrated", () => {
  const a = Math.pow(10, -23 / 20);
  const x = Float32Array.from({ length: SR * 8 }, (_, i) => a * Math.sin((2 * Math.PI * 1000 * i) / SR));
  const m = lastReport(x, x);
  for (const key of ["momentary", "shortTerm", "integrated"]) assert.ok(Math.abs(m[key] + 23) < 0.1, `${key}: ${m[key]}`);
  assert.ok(Math.abs(m.truePeak + 23) < 0.1, `true peak ${m.truePeak}`);
  assert.equal(m.reports, 80, "one report per 100 ms");
});

test("on programme material it agrees with the offline measurement", () => {
  const rand = rng(8);
  const n = SR * 20;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const loud = t > 6 && t < 14 ? 1 : 0.2; // a quiet intro and outro for the gate to chew on
    const beat = t % 0.5;
    l[i] = loud * (0.6 * Math.exp(-beat * 12) * Math.sin(2 * Math.PI * 60 * beat) + 0.1 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * (rand() * 2 - 1));
    r[i] = loud * (0.5 * Math.exp(-beat * 12) * Math.sin(2 * Math.PI * 60 * beat) + 0.1 * Math.sin(2 * Math.PI * 554 * t) + 0.05 * (rand() * 2 - 1));
  }
  const live = lastReport(l, r);
  const ref = measureLoudness([l, r], SR);
  assert.ok(Math.abs(live.integrated - ref.integrated) < 0.1, `integrated ${live.integrated.toFixed(2)} vs ${ref.integrated.toFixed(2)}`);
  assert.ok(Math.abs(live.truePeak - ref.truePeakDb) < 0.1, `true peak ${live.truePeak.toFixed(2)} vs ${ref.truePeakDb.toFixed(2)}`);
});

test("silence reports -Infinity and never NaN", () => {
  const z = new Float32Array(SR * 2);
  const m = lastReport(z, z);
  assert.equal(m.integrated, -Infinity);
  assert.equal(m.momentary, -Infinity);
});
