// The bounce itself, independent of any one plugin.

import { test, assert, makeBuffer, sine, plucks, renderWith, liveRender, diffDb, stats, fmt } from "../lib.js";

const SR = 48000;

test("a bounce through the compressor does not duck its first moments", async () => {
  // A DynamicsCompressorNode created cold attenuates by up to 14 dB while its
  // detector wakes up. Playback never hears that (the chain was built long
  // before); the bounce's pre-roll is what keeps it out of the file.
  const src = makeBuffer(SR, 1, sine(440, 0.05));
  const out = await renderWith(src, [{ type: "core.comp", params: { ratio: 1, makeup: 0, release: 2 } }]);
  const early = stats(out, 0.02 * SR, 0.06 * SR).rmsDb; // just past the 6 ms look-ahead
  const late = stats(out, 0.8 * SR, 0.9 * SR).rmsDb;
  assert(Math.abs(early - late) < 0.05, `first 60 ms at ${fmt(early)} dB, steady state ${fmt(late)} dB`);
  return `20–60 ms: ${fmt(early)} dB, steady: ${fmt(late)} dB`;
});

// Several times each: a freshly built live compressor that has not been woken
// (see `prime` in audio/effects.js) ducks the first note, and whether it had
// been woken used to depend on how old the context was.
for (const [type, params] of [
  ["core.comp", { threshold: -30, ratio: 6 }],
  ["core.limiter", { drive: 9 }],
  ["core.limiter", { drive: 0 }],
  ["core.limiter", { drive: 9, release: 0.3 }],
]) {
  test(`${type} ${JSON.stringify(params)}: bounce matches live playback`, async () => {
    const src = makeBuffer(SR, 1.5, plucks(0.8));
    const fx = [{ type, params }];
    const off = await renderWith(src, fx);
    const on = await liveRender(src, fx, { settle: 1 });
    const d = diffDb(off, on);
    assert(Math.abs(stats(off).rmsDb - stats(on).rmsDb) < 0.1, `rms ${fmt(stats(off).rmsDb)} vs ${fmt(stats(on).rmsDb)}`);
    assert(d < -60, `difference ${fmt(d)} dBFS`);
    return `difference ${fmt(d, 0)} dBFS`;
  });
}
