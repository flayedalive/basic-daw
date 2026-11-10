// Phase 3: worklet plugins, latency compensation, and the gate that pilots them.

import { test, assert, ready, makeBuffer, noise, sine, renderWith, liveRender, diffDb, stats, openApp, sleep, captureEngine, firstSound, fmt } from "../lib.js";
import { newTrack, newClip } from "../../../src/state.js";
import { newEffect, registerPlugin, latencyOf } from "../../../src/plugins/registry.js";

const SR = 48000;
/** Bursts of tone with a low hiss between them: the classic thing to gate. */
const rnd = noise(0.002, 9);
const bursts = makeBuffer(SR, 2, (t) => {
  const on = t % 0.5 < 0.2;
  return (on ? 0.4 * Math.sin(2 * Math.PI * 220 * t) * Math.min(1, (t % 0.5) / 0.004) : 0) + rnd();
});
const peakIndex = (buf) => {
  const d = buf.getChannelData(0);
  let at = 0;
  for (let i = 1; i < d.length; i++) if (Math.abs(d[i]) > Math.abs(d[at])) at = i;
  return at;
};

test("gate: a bounce is gated (it used to come out ungated)", async () => {
  const out = await renderWith(bursts, [{ type: "core.gate", params: { threshold: -30, hold: 0.02, release: 0.03 } }]);
  const between = stats(out, 0.35 * SR, 0.48 * SR).rmsDb; // well into a gap
  const during = stats(out, 0.05 * SR, 0.18 * SR).rmsDb;
  assert(between < -90 && during > -15, `gap ${fmt(between)} dB, burst ${fmt(during)} dB`);
  return `burst ${fmt(during, 1)} dB, gap ${fmt(between, 0)} dB (hiss in the source: ${fmt(stats(bursts, 0.35 * SR, 0.48 * SR).rmsDb, 0)} dB)`;
});

for (const params of [{ threshold: -30 }, { threshold: -30, lookahead: 5, hold: 0.01, release: 0.05, attack: 0.001 }, { threshold: -20, range: -20 }]) {
  test(`gate ${JSON.stringify(params)}: bounce matches live playback sample for sample`, async () => {
    const fx = [{ type: "core.gate", params }];
    const off = await renderWith(bursts, fx);
    const on = await liveRender(bursts, fx);
    const d = diffDb(off, on);
    assert(d < -120, `difference ${fmt(d)} dBFS`);
    return `difference ${fmt(d, 0)} dBFS`;
  });
}

test("gate: with 5 ms look-ahead the attack passes whole, and the track stays in time with an ungated one", async () => {
  // A click, on two tracks. One has a look-ahead gate; if its delay were not
  // compensated the two copies would land 5 ms apart instead of summing.
  const click = makeBuffer(SR, 0.5, (t, i) => (i >= 4800 && i < 4848 ? 0.4 * Math.sin((Math.PI * (i - 4800)) / 48) : 0));
  const gate = { type: "core.gate", params: { threshold: -40, lookahead: 5, attack: 0.001 } };
  const both = await renderWith(click, [gate], {
    setup(project, track, clip) {
      const dry = newTrack("dry", 1);
      project.tracks.push(dry);
      project.clips.push(newClip(clip.assetId, dry.id, 0, { fadeIn: 0, fadeOut: 0 }));
    },
  });
  const want = peakIndex(click);
  const got = peakIndex(both);
  assert(got === want, `peak at sample ${got}, expected ${want}`);
  const d = diffDb(both, makeBuffer(SR, 0.5, (t, i) => 2 * click.getChannelData(0)[i]), 0, 4700, 5000);
  // (The gate's exponential attack has covered 99.3% of the way after 5 ms, hence not a perfect null.)
  assert(d < -45, `the two tracks do not sum to twice the click (${fmt(d)} dBFS)`);
  // Without look-ahead the first samples of the click are lost to the attack.
  const alone = await renderWith(click, [gate]);
  const lossy = await renderWith(click, [{ type: "core.gate", params: { threshold: -40, lookahead: 0, attack: 0.001 } }]);
  const head = (buf) => stats(buf, 4800, 4812).rmsDb - stats(click, 4800, 4812).rmsDb;
  assert(Math.abs(head(alone)) < 0.5 && head(lossy) < -3, `first 0.25 ms: ${fmt(head(alone))} dB with look-ahead, ${fmt(head(lossy))} dB without`);
  return `peak on sample ${got}; attack kept to ${fmt(head(alone), 2)} dB with look-ahead vs ${fmt(head(lossy), 1)} dB without`;
});

test("latency compensation: a compressed track lines up with a dry one", async () => {
  const click = makeBuffer(SR, 0.5, (t, i) => (i >= 4800 && i < 4848 ? 0.01 * Math.sin((Math.PI * (i - 4800)) / 48) : 0));
  const comp = { type: "core.comp", params: { ratio: 1, makeup: 0 } };
  assert(Math.abs(latencyOf(newEffect("core.comp")) - 0.006) < 1e-9, "compressor should report 6 ms");
  const out = await renderWith(click, [comp], {
    setup(project, track, clip) {
      const dry = newTrack("dry", 1);
      project.tracks.push(dry);
      project.clips.push(newClip(clip.assetId, dry.id, 0, { fadeIn: 0, fadeOut: 0 }));
    },
  });
  assert(peakIndex(out) === peakIndex(click), `peak at ${peakIndex(out)}, expected ${peakIndex(click)}`);
  const ratio = stats(out).peak / stats(click).peak;
  assert(Math.abs(ratio - 2) < 0.02, `sum is ${fmt(ratio, 3)}× one track, expected 2×`);
  // And on the master: its latency comes off the head of the bounce.
  const mastered = await renderWith(click, [], { masterFx: [comp] });
  assert(peakIndex(mastered) === peakIndex(click), "master-chain latency was not trimmed from the bounce");
  return `two tracks sum to ${fmt(ratio, 3)}× on the source's own sample`;
});

test("a worklet plugin registered at run time loads and renders, live and bounced", async () => {
  await ready();
  const code = `
    class Halve extends AudioWorkletProcessor {
      static get parameterDescriptors() { return [{ name: "amount", defaultValue: 0.5, automationRate: "k-rate" }]; }
      process(inputs, outputs, params) {
        const g = params.amount[0];
        for (let c = 0; c < outputs[0].length; c++) {
          const x = inputs[0][c];
          for (let i = 0; i < outputs[0][c].length; i++) outputs[0][c][i] = x ? x[i] * g : 0;
        }
        return true;
      }
    }
    registerProcessor("test-halve", Halve);`;
  const { workletNode } = await import("../../../src/plugins/worklets.js");
  registerPlugin(
    {
      id: "test.halve",
      name: "Halve",
      params: [{ key: "amount", label: "Amount", min: 0, max: 1, def: 0.5 }],
      worklets: [{ name: "test-halve", code }],
      create(ctx, offline) {
        const node = workletNode(ctx, "test-halve");
        return { input: node, output: node, update: (p) => (offline ? node.parameters.get("amount").setValueAtTime(p.amount, 0) : (node.parameters.get("amount").value = p.amount)) };
      },
    },
    "user",
  );
  const src = makeBuffer(SR, 0.5, sine(440, 0.5));
  const off = await renderWith(src, [{ type: "test.halve", params: { amount: 0.25 } }]);
  const on = await liveRender(src, [{ type: "test.halve", params: { amount: 0.25 } }]);
  const want = makeBuffer(SR, 0.5, sine(440, 0.125));
  assert(diffDb(off, want) < -120 && diffDb(on, want) < -120, `bounce ${fmt(diffDb(off, want))}, live ${fmt(diffDb(on, want))} dBFS`);
});

test("in the app: a gate on a track boots as a passthrough, then becomes the gate; playback is the bounce", async () => {
  const win = await openApp();
  const { daw } = win;
  const track = daw.state.project.tracks[0];
  const fx = daw.plugins.newEffect("core.gate");
  Object.assign(fx.params, { threshold: -30, lookahead: 5, hold: 0.02, release: 0.03 });
  track.fx.push(fx);
  // The context does not exist yet: creating it builds the chain before the
  // processor module can possibly have loaded.
  daw.engine.ensure();
  const first = daw.engine.liveEffect(track.id, fx.id);
  assert(first?.pending, "expected a passthrough while the module loads");
  for (let i = 0; i < 100 && daw.engine.liveEffect(track.id, fx.id)?.pending; i++) await sleep(30);
  const live = daw.engine.liveEffect(track.id, fx.id);
  assert(live && !live.pending && live.node, "the chain was not rebuilt with the real gate");
  // Look-ahead is a whole number of samples at the engine's rate.
  const wantLatency = Math.round(0.005 * daw.engine.sampleRate) / daw.engine.sampleRate;
  assert(Math.abs(daw.engine.latency.total - wantLatency) < 1e-9, `engine latency ${daw.engine.latency.total}, expected ${wantLatency}`);

  const rate = daw.engine.sampleRate;
  const r = noise(0.002, 9);
  const buffer = makeBuffer(rate, 2, (t) => (t % 0.5 < 0.2 ? 0.4 * Math.sin(2 * Math.PI * 220 * t) * Math.min(1, (t % 0.5) / 0.004) : 0) + r());
  const asset = await daw.pool.addAsset({ name: "bursts", buffer });
  daw.timeline.dropAssetAt(asset.id, track.id, 0);
  Object.assign(daw.state.project.clips[0], { fadeIn: 0, fadeOut: 0 });
  await sleep(2200); // the freshly built chain's wake-up signal has to finish, or it is in the capture
  const cap = await captureEngine(win, 3);
  daw.engine.play(0);
  const heard = await cap.done;
  // The playhead reports what is being heard, which is behind what is being read.
  daw.engine.stop();
  const bounce = await daw.render.renderRange(0, 2, { sampleRate: rate, tailSec: 0 });
  const a = firstSound(heard, 0.01);
  const b = firstSound(bounce, 0.01);
  const n = Math.min(heard.length - a, bounce.length - b) - 64;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(heard.getChannelData(0)[a + i] - bounce.getChannelData(0)[b + i]));
  const d = 20 * Math.log10(peak + 1e-12);
  assert(d < -80, `playback and bounce differ by ${fmt(d)} dBFS`);
  assert(!win.__errors.length, win.__errors.join("; "));
  return `passthrough → gate after load; latency 5 ms; playback vs bounce ${fmt(d, 0)} dBFS`;
});
