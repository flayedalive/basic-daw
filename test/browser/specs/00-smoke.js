import { test, assert, ready, makeBuffer, sine, renderWith, diffDb, stats, fmt } from "../lib.js";
import { allPlugins } from "../../../src/plugins/registry.js";

test("every built-in and bundled plugin registers", async () => {
  await ready();
  const { loadErrors } = await import("../../../src/plugins/loader.js");
  assert(!loadErrors.length, JSON.stringify(loadErrors));
  return `${allPlugins().length} plugins`;
});

test("an empty chain bounces the source unchanged", async () => {
  const src = makeBuffer(48000, 1, sine(440));
  const out = await renderWith(src);
  const d = diffDb(out, src);
  assert(d < -120, `difference ${fmt(d)} dBFS`);
  return `diff ${fmt(d)} dBFS`;
});

test("every plugin renders finite audio at its defaults, and the same audio twice", async () => {
  await ready();
  const src = makeBuffer(48000, 0.5, sine(220, 0.4));
  const notes = [];
  for (const p of allPlugins()) {
    const a = await renderWith(src, [{ type: p.id }], { tailSec: 0.2 });
    const s = stats(a);
    assert(Number.isFinite(s.peak) && Number.isFinite(s.rms), `${p.id} rendered non-finite audio`);
    // Plugins that draw fresh noise per instance (reverbs) are allowed to differ.
    if (/reverb|plate/.test(p.id)) continue;
    const b = await renderWith(src, [{ type: p.id }], { tailSec: 0.2 });
    const d = diffDb(a, b);
    assert(d < -100, `${p.id} is not deterministic: two bounces differ by ${fmt(d)} dBFS`);
  }
  return notes.join(", ");
});
