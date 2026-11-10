// The gate's processor, run block by block in Node (no browser involved).

import test from "node:test";
import assert from "node:assert/strict";
import { loadWorkletModule, runProcessor } from "../../.claude/skills/daw-plugin/mock-audio.mjs";
import { sine, rms, db } from "./helpers.mjs";

const SR = 48000;
await loadWorkletModule(new URL("../../src/plugins/worklets/gate.js", import.meta.url).href, SR);

/** Silence, a 0.3 s tone, silence. */
function burst(level = 0.5) {
  const x = new Float32Array(SR);
  sine(Math.round(0.3 * SR), SR, 1000, level).forEach((v, i) => (x[Math.round(0.2 * SR) + i] = v));
  return x;
}
const run = (x, params) => runProcessor("daw-gate", [x, x], params, { sampleRate: SR })[0];

test("opens above the threshold and closes below it", () => {
  const y = run(burst(), { threshold: -20, attack: 0.001, hold: 0.01, release: 0.02 });
  assert.ok(Math.abs(db(rms(y, 0.3 * SR, 0.45 * SR)) - db(0.5 / Math.SQRT2)) < 0.1, "burst should pass at full level");
  assert.equal(rms(y, 0.7 * SR, SR), 0, "should be closed (and exactly zero, no denormals) after the burst");
  const quiet = run(burst(0.05), { threshold: -20 });
  assert.equal(rms(quiet, 0, SR), 0, "a burst under the threshold should never open it");
});

test("hold keeps it open for the time asked, then release takes over", () => {
  const x = burst();
  const end = Math.round(0.5 * SR);
  // Feed a steady low tone after the burst so the gate's gain is visible.
  for (let i = end; i < SR; i++) x[i] = 0.001 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  const y = run(x, { threshold: -20, hold: 0.1, release: 0.02, attack: 0.001 });
  const g = (from, to) => rms(y, from * SR, to * SR) / rms(x, from * SR, to * SR);
  assert.ok(g(0.52, 0.58) > 0.98, `during hold the gain is ${g(0.52, 0.58).toFixed(3)}`);
  assert.ok(g(0.75, 0.8) < 0.01, `after hold + release the gain is ${g(0.75, 0.8).toFixed(4)}`);
});

test("look-ahead delays the audio by exactly that much and opens before the attack", () => {
  const x = burst();
  const start = Math.round(0.2 * SR);
  const y = run(x, { threshold: -20, attack: 0.001, lookahead: Math.round(0.005 * SR) }); // the processor takes samples
  const late = Math.round(0.005 * SR);
  // 5 ms is five attack time constants: the gain is within 1% of open when the burst arrives.
  for (let i = 1; i < 40; i++) assert.ok(Math.abs(y[start + late + i] - x[start + i]) < 0.01 * 0.5 + 1e-6, `sample ${i} of the attack is off`);
  const plain = run(x, { threshold: -20, attack: 0.001, lookahead: 0 });
  assert.ok(Math.abs(plain[start + 5]) < Math.abs(x[start + 5]) * 0.2, "without look-ahead the first samples are attenuated");
});

test("range leaves a closed gate at the attenuation asked", () => {
  const x = sine(SR, SR, 1000, 0.001);
  const y = run(x, { threshold: -20, range: -12 });
  assert.ok(Math.abs(db(rms(y, SR / 2, SR) / rms(x, SR / 2, SR)) + 12) < 0.05);
});
