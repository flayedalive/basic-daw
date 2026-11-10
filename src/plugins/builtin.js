// The effects that ship with the app as JS-tier plugins.
//
// These predate the registry and are kept in JS deliberately: several of them
// do things the JSON tier cannot express (the gate's envelope follower needs a
// real `tick`, the limiter's ceiling depends on a curve constant), and having
// them here keeps a working reference for what a JS plugin looks like.
//
// Native Web Audio nodes only. That constraint is what lets the identical
// `create` run inside an OfflineAudioContext during bounce, so what you hear is
// what you render.

import { clamp, dbToGain } from "../util.js";
import { registerPlugin } from "./registry.js";
import {
  setAudioParam,
  makeImpulse,
  makeDriveCurve,
  makeSoftClipCurve,
  LIMIT_MAX,
} from "./dsp.js";
import { tunerPlugin } from "./tuner.js";
import { ampPlugin, cabPlugin } from "./amp.js";
import { geq31Plugin } from "./geq31.js";
import { multibandPlugin } from "./multiband.js";

const P = (key, label, min, max, def, extra = {}) => ({ key, label, min, max, def, ...extra });

export function registerBuiltins() {
  const add = (spec) => registerPlugin(spec, "builtin");

  add({
    id: "core.eq",
    name: "EQ (4-band)",
    category: "EQ / Filter",
    description: "Low shelf, two peaking bands, high shelf. The inspector draws its live response.",
    params: [
      P("lowFreq", "Low F", 20, 1000, 120, { unit: "Hz", log: true }),
      P("lowGain", "Low", -18, 18, 0, { unit: "dB" }),
      P("midFreq", "Mid F", 100, 8000, 800, { unit: "Hz", log: true }),
      P("midGain", "Mid", -18, 18, 0, { unit: "dB" }),
      P("midQ", "Mid Q", 0.2, 8, 1),
      P("hiMidFreq", "HiMid F", 500, 16000, 3200, { unit: "Hz", log: true }),
      P("hiMidGain", "HiMid", -18, 18, 0, { unit: "dB" }),
      P("hiMidQ", "HiMid Q", 0.2, 8, 1),
      P("highFreq", "High F", 1000, 20000, 8000, { unit: "Hz", log: true }),
      P("highGain", "High", -18, 18, 0, { unit: "dB" }),
    ],
    create(ctx, offline) {
      const bands = [ctx.createBiquadFilter(), ctx.createBiquadFilter(), ctx.createBiquadFilter(), ctx.createBiquadFilter()];
      bands[0].type = "lowshelf";
      bands[1].type = "peaking";
      bands[2].type = "peaking";
      bands[3].type = "highshelf";
      bands.reduce((a, b) => (a.connect(b), b));
      return {
        input: bands[0],
        output: bands[3],
        bands,
        update(p) {
          setAudioParam(ctx, bands[0].frequency, p.lowFreq, offline);
          setAudioParam(ctx, bands[0].gain, p.lowGain, offline);
          setAudioParam(ctx, bands[1].frequency, p.midFreq, offline);
          setAudioParam(ctx, bands[1].gain, p.midGain, offline);
          setAudioParam(ctx, bands[1].Q, p.midQ, offline);
          setAudioParam(ctx, bands[2].frequency, p.hiMidFreq, offline);
          setAudioParam(ctx, bands[2].gain, p.hiMidGain, offline);
          setAudioParam(ctx, bands[2].Q, p.hiMidQ, offline);
          setAudioParam(ctx, bands[3].frequency, p.highFreq, offline);
          setAudioParam(ctx, bands[3].gain, p.highGain, offline);
        },
      };
    },
  });

  add({
    id: "core.filter",
    name: "Filter",
    category: "EQ / Filter",
    description: "One resonant biquad, switchable between the four common responses.",
    params: [
      { key: "mode", label: "Mode", choices: ["lowpass", "highpass", "bandpass", "notch"], def: "lowpass" },
      P("freq", "Cutoff", 20, 20000, 1200, { unit: "Hz", log: true }),
      P("q", "Reso", 0.1, 20, 1),
    ],
    create(ctx, offline) {
      const f = ctx.createBiquadFilter();
      return {
        input: f,
        output: f,
        node: f,
        update(p) {
          f.type = p.mode ?? "lowpass";
          setAudioParam(ctx, f.frequency, p.freq, offline);
          setAudioParam(ctx, f.Q, p.q, offline);
        },
      };
    },
  });

  add({
    id: "core.comp",
    name: "Compressor",
    category: "Dynamics",
    description: "The native dynamics compressor with a makeup stage.",
    params: [
      P("threshold", "Thresh", -60, 0, -18, { unit: "dB" }),
      P("ratio", "Ratio", 1, 20, 3, { unit: ":1" }),
      P("knee", "Knee", 0, 40, 6, { unit: "dB" }),
      P("attack", "Attack", 0, 0.3, 0.006, { unit: "s", prec: 3 }),
      P("release", "Release", 0.01, 2, 0.18, { unit: "s", prec: 3 }),
      P("makeup", "Makeup", -12, 24, 0, { unit: "dB" }),
    ],
    create(ctx, offline) {
      const c = ctx.createDynamicsCompressor();
      const makeup = ctx.createGain();
      c.connect(makeup);
      return {
        input: c,
        output: makeup,
        node: c,
        update(p) {
          setAudioParam(ctx, c.threshold, p.threshold, offline);
          setAudioParam(ctx, c.ratio, p.ratio, offline);
          setAudioParam(ctx, c.knee, p.knee, offline);
          setAudioParam(ctx, c.attack, p.attack, offline);
          setAudioParam(ctx, c.release, p.release, offline);
          setAudioParam(ctx, makeup.gain, dbToGain(p.makeup), offline);
        },
        readout: () => c.reduction,
      };
    },
  });

  add({
    id: "core.limiter",
    name: "Limiter",
    category: "Dynamics",
    description: "Drive into a fast high-ratio compressor, then soft-clip so the ceiling is a guarantee.",
    params: [
      P("ceiling", "Ceiling", -12, 0, -0.3, { unit: "dB" }),
      P("drive", "Drive", 0, 18, 0, { unit: "dB" }),
      P("release", "Release", 0.01, 0.5, 0.05, { unit: "s", prec: 3 }),
    ],
    create(ctx, offline) {
      const drive = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      const shaper = ctx.createWaveShaper();
      const out = ctx.createGain();
      shaper.curve = makeSoftClipCurve();
      drive.connect(comp).connect(shaper).connect(out);
      comp.knee.value = 0;
      comp.ratio.value = 20;
      comp.attack.value = 0.001;
      return {
        input: drive,
        output: out,
        node: comp,
        update(p) {
          setAudioParam(ctx, drive.gain, dbToGain(p.drive), offline);
          setAudioParam(ctx, comp.threshold, clamp(p.ceiling - 2, -60, 0), offline);
          setAudioParam(ctx, comp.release, p.release, offline);
          // The shaper's output is bounded by LIMIT_MAX, so this trim *is* the ceiling.
          setAudioParam(ctx, out.gain, dbToGain(p.ceiling) / LIMIT_MAX, offline);
        },
        readout: () => comp.reduction,
      };
    },
  });

  add({
    id: "core.gate",
    name: "Noise Gate",
    category: "Dynamics",
    description: "Envelope-followed gate. Needs a per-frame tick, which is why it cannot be a JSON plugin.",
    params: [
      P("threshold", "Thresh", -80, 0, -45, { unit: "dB" }),
      P("attack", "Attack", 0, 0.1, 0.002, { unit: "s", prec: 3 }),
      P("release", "Release", 0.01, 1, 0.12, { unit: "s", prec: 3 }),
    ],
    create(ctx) {
      // No native gate: track the envelope with an analyser on a side path and
      // drive the gain node from the render loop (engine calls tick()).
      const input = ctx.createGain();
      const vca = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      input.connect(vca);
      input.connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      let open = 0;
      let params = { threshold: -45, attack: 0.002, release: 0.12 };
      return {
        input,
        output: vca,
        needsTick: true,
        update(p) {
          params = p;
        },
        tick(dt) {
          analyser.getFloatTimeDomainData(buf);
          let peak = 0;
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i]);
            if (a > peak) peak = a;
          }
          const target = peak >= dbToGain(params.threshold) ? 1 : 0;
          const tau = target > open ? Math.max(0.001, params.attack) : Math.max(0.005, params.release);
          open += (target - open) * clamp(dt / tau, 0, 1);
          vca.gain.setTargetAtTime(open, ctx.currentTime, 0.005);
        },
        readout: () => open,
      };
    },
  });

  add({
    id: "core.delay",
    name: "Delay",
    category: "Delay / Reverb",
    description: "Stereo delay with damped feedback and an optional ping-pong cross-feed.",
    params: [
      P("time", "Time", 0.01, 2, 0.32, { unit: "s", prec: 3 }),
      P("feedback", "Feedback", 0, 0.95, 0.35),
      P("damp", "Damp", 500, 18000, 6000, { unit: "Hz", log: true }),
      { key: "pingpong", label: "Ping-pong", bool: true, def: false },
      P("mix", "Mix", 0, 1, 0.25),
    ],
    create(ctx, offline) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const out = ctx.createGain();
      const dL = ctx.createDelay(2.5);
      const dR = ctx.createDelay(2.5);
      const fbL = ctx.createGain();
      const fbR = ctx.createGain();
      const dampL = ctx.createBiquadFilter();
      const dampR = ctx.createBiquadFilter();
      dampL.type = dampR.type = "lowpass";
      const merger = ctx.createChannelMerger(2);
      input.connect(dry).connect(out);
      input.connect(dL);
      input.connect(dR);
      dL.connect(dampL).connect(fbL);
      dR.connect(dampR).connect(fbR);
      dL.connect(merger, 0, 0);
      dR.connect(merger, 0, 1);
      merger.connect(wet).connect(out);
      let pingpong = false;
      const rewire = (pp) => {
        fbL.disconnect();
        fbR.disconnect();
        if (pp) {
          fbL.connect(dR);
          fbR.connect(dL);
        } else {
          fbL.connect(dL);
          fbR.connect(dR);
        }
        pingpong = pp;
      };
      rewire(false);
      return {
        input,
        output: out,
        update(p) {
          setAudioParam(ctx, dL.delayTime, p.time, offline);
          setAudioParam(ctx, dR.delayTime, p.pingpong ? p.time * 1.0 : p.time * 1.02, offline);
          setAudioParam(ctx, fbL.gain, p.feedback, offline);
          setAudioParam(ctx, fbR.gain, p.feedback, offline);
          setAudioParam(ctx, dampL.frequency, p.damp, offline);
          setAudioParam(ctx, dampR.frequency, p.damp, offline);
          setAudioParam(ctx, wet.gain, p.mix, offline);
          setAudioParam(ctx, dry.gain, 1 - p.mix * 0.4, offline);
          if (!!p.pingpong !== pingpong) rewire(!!p.pingpong);
        },
      };
    },
  });

  add({
    id: "core.reverb",
    name: "Reverb",
    category: "Delay / Reverb",
    description: "Convolution against a generated decaying-noise impulse.",
    params: [
      P("size", "Size", 0.2, 8, 2.2, { unit: "s", prec: 2 }),
      P("decay", "Decay", 0.5, 8, 2.4),
      P("damp", "Damp", 800, 18000, 5200, { unit: "Hz", log: true }),
      P("predelay", "Pre-dly", 0, 0.2, 0.02, { unit: "s", prec: 3 }),
      P("mix", "Mix", 0, 1, 0.22),
    ],
    create(ctx, offline) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const out = ctx.createGain();
      const pre = ctx.createDelay(0.5);
      const conv = ctx.createConvolver();
      conv.normalize = true;
      input.connect(dry).connect(out);
      input.connect(pre).connect(conv).connect(wet).connect(out);
      let irKey = "";
      return {
        input,
        output: out,
        update(p) {
          const key = `${p.size}|${p.decay}|${p.damp}`;
          if (key !== irKey) {
            conv.buffer = makeImpulse(ctx, p.size, p.decay, p.damp);
            irKey = key;
          }
          setAudioParam(ctx, pre.delayTime, p.predelay, offline);
          setAudioParam(ctx, wet.gain, p.mix, offline);
          setAudioParam(ctx, dry.gain, 1 - p.mix * 0.5, offline);
        },
      };
    },
  });

  add({
    id: "core.chorus",
    name: "Chorus",
    category: "Modulation",
    description: "Two LFO-modulated delay voices spread across the stereo field.",
    params: [
      P("rate", "Rate", 0.05, 8, 0.6, { unit: "Hz", prec: 2 }),
      P("depth", "Depth", 0, 0.01, 0.003, { unit: "s", prec: 4 }),
      P("delay", "Delay", 0.003, 0.05, 0.018, { unit: "s", prec: 3 }),
      P("mix", "Mix", 0, 1, 0.3),
    ],
    create(ctx, offline) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const out = ctx.createGain();
      const dL = ctx.createDelay(0.1);
      const dR = ctx.createDelay(0.1);
      const lfo = ctx.createOscillator();
      const lfo2 = ctx.createOscillator();
      const depthL = ctx.createGain();
      const depthR = ctx.createGain();
      const merger = ctx.createChannelMerger(2);
      lfo.type = lfo2.type = "sine";
      lfo.connect(depthL).connect(dL.delayTime);
      lfo2.connect(depthR).connect(dR.delayTime);
      input.connect(dry).connect(out);
      input.connect(dL).connect(merger, 0, 0);
      input.connect(dR).connect(merger, 0, 1);
      merger.connect(wet).connect(out);
      lfo.start(0);
      lfo2.start(0);
      return {
        input,
        output: out,
        update(p) {
          setAudioParam(ctx, lfo.frequency, p.rate, offline);
          setAudioParam(ctx, lfo2.frequency, p.rate * 1.17, offline);
          setAudioParam(ctx, depthL.gain, p.depth, offline);
          setAudioParam(ctx, depthR.gain, -p.depth, offline);
          setAudioParam(ctx, dL.delayTime, p.delay, offline);
          setAudioParam(ctx, dR.delayTime, p.delay * 1.3, offline);
          setAudioParam(ctx, wet.gain, p.mix, offline);
          setAudioParam(ctx, dry.gain, 1 - p.mix * 0.5, offline);
        },
        dispose() {
          try {
            lfo.stop();
            lfo2.stop();
          } catch {
            /* already stopped */
          }
        },
      };
    },
  });

  add({
    id: "core.drive",
    name: "Saturator",
    category: "Distortion",
    description: "Oversampled tanh saturation with a tone tilt and parallel mix.",
    params: [
      P("drive", "Drive", 1, 60, 8),
      P("tone", "Tone", 500, 18000, 9000, { unit: "Hz", log: true }),
      P("mix", "Mix", 0, 1, 1),
      P("out", "Output", -24, 6, -3, { unit: "dB" }),
    ],
    create(ctx, offline) {
      const input = ctx.createGain();
      const dry = ctx.createGain();
      const wet = ctx.createGain();
      const shaper = ctx.createWaveShaper();
      const tone = ctx.createBiquadFilter();
      const out = ctx.createGain();
      tone.type = "lowpass";
      shaper.oversample = "4x";
      input.connect(dry).connect(out);
      input.connect(shaper).connect(tone).connect(wet).connect(out);
      let driveKey = -1;
      return {
        input,
        output: out,
        update(p) {
          if (p.drive !== driveKey) {
            shaper.curve = makeDriveCurve(p.drive);
            driveKey = p.drive;
          }
          setAudioParam(ctx, tone.frequency, p.tone, offline);
          setAudioParam(ctx, wet.gain, p.mix, offline);
          setAudioParam(ctx, dry.gain, 1 - p.mix, offline);
          setAudioParam(ctx, out.gain, dbToGain(p.out), offline);
        },
      };
    },
  });

  add({
    id: "core.width",
    name: "Stereo Width",
    category: "Stereo",
    description: "Mid/side width control with a bass-mono crossover on the side signal.",
    params: [P("width", "Width", 0, 2, 1.2), P("bassMono", "Bass mono", 0, 400, 0, { unit: "Hz" })],
    create(ctx, offline) {
      // M = (L+R)/2, S = (L-R)/2, then L = M+S*w, R = M-S*w.
      // Forcing two channels at the input means a mono source still up-mixes
      // before the split, instead of leaving the right side silent.
      const input = ctx.createGain();
      input.channelCount = 2;
      input.channelCountMode = "explicit";
      input.channelInterpretation = "speakers";
      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const mid = ctx.createGain();
      const side = ctx.createGain();
      const sideInvert = ctx.createGain();
      const sideWidth = ctx.createGain();
      const sideHp = ctx.createBiquadFilter();
      const outL = ctx.createGain();
      const outR = ctx.createGain();
      sideHp.type = "highpass";
      sideInvert.gain.value = -1;
      mid.gain.value = 0.5;
      side.gain.value = 0.5;
      input.connect(splitter);
      splitter.connect(mid, 0);
      splitter.connect(mid, 1);
      splitter.connect(side, 0);
      splitter.connect(sideInvert, 1);
      sideInvert.connect(side);
      side.connect(sideHp).connect(sideWidth);
      mid.connect(outL);
      mid.connect(outR);
      sideWidth.connect(outL);
      const negSide = ctx.createGain();
      negSide.gain.value = -1;
      sideWidth.connect(negSide).connect(outR);
      outL.connect(merger, 0, 0);
      outR.connect(merger, 0, 1);
      return {
        input,
        output: merger,
        update(p) {
          setAudioParam(ctx, sideWidth.gain, p.width, offline);
          setAudioParam(ctx, sideHp.frequency, Math.max(10, p.bassMono), offline);
        },
      };
    },
  });

  add({
    id: "core.gain",
    name: "Trim / Gain",
    category: "Utility",
    description: "A single gain stage, for matching levels between inserts.",
    params: [P("gain", "Gain", -36, 24, 0, { unit: "dB" })],
    create(ctx, offline) {
      const g = ctx.createGain();
      return {
        input: g,
        output: g,
        update(p) {
          setAudioParam(ctx, g.gain, dbToGain(p.gain), offline);
        },
      };
    },
  });

  // Lives in its own module: the pitch detector is the bulk of it.
  add(tunerPlugin);
  // Likewise: the amp is a chain of two dozen nodes and its cabinet loader.
  add(ampPlugin);
  add(cabPlugin);
  add(geq31Plugin);
  add(multibandPlugin);
}
