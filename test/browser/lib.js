// In-page test helpers: a tiny test registry, signal generators, measurements,
// and a way to render a one-track project through the app's real bounce path.

import { state, assets, newProject, newClip, newTrack } from "../../src/state.js";
import { initPlugins } from "../../src/plugins/loader.js";
import { newEffect, getPlugin } from "../../src/plugins/registry.js";
import { renderRange } from "../../src/audio/render.js";

export const tests = [];
export const test = (name, fn) => tests.push({ name, fn });

export async function runAll() {
  const out = [];
  for (const t of tests) {
    try {
      const note = await t.fn();
      out.push({ name: t.name, ok: true, note: typeof note === "string" ? note : "" });
    } catch (err) {
      out.push({ name: t.name, ok: false, error: err?.stack ?? String(err) });
    }
  }
  return out;
}

export function assert(cond, msg = "assertion failed") {
  if (!cond) throw new Error(msg);
}

let pluginsReady = null;
export const ready = () => (pluginsReady ??= initPlugins());

/* ── signals ──────────────────────────────────────────────────────────── */

// Stereo by default: the track panner is unity for stereo at centre, but -3 dB for mono.
export function makeBuffer(sampleRate, seconds, fn, channels = 2) {
  const n = Math.round(sampleRate * seconds);
  const buf = new AudioBuffer({ numberOfChannels: channels, length: n, sampleRate });
  for (let c = 0; c < channels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) d[i] = fn(i / sampleRate, i, c);
  }
  return buf;
}

export const sine = (hz, amp = 0.5) => (t) => amp * Math.sin(2 * Math.PI * hz * t);

/** Deterministic white noise (mulberry32), so a failing test fails the same way twice. */
export function noise(amp = 0.25, seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return amp * (((t ^ (t >>> 14)) >>> 0) / 2147483648 - 1);
  };
}

/** Something guitar-ish: decaying plucks with harmonics. */
export function plucks(amp = 0.5) {
  const notes = [82.41, 110, 146.83, 196, 246.94, 329.63];
  return (t) => {
    const k = Math.floor(t / 0.25) % notes.length;
    const local = t % 0.25;
    const env = Math.exp(-local * 9);
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * notes[k] * h * local) / h;
    return amp * env * v * 0.5;
  };
}

/* ── measurements ─────────────────────────────────────────────────────── */

export function stats(buf, from = 0, to = buf.length) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = from; i < Math.min(to, d.length); i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
      sum += d[i] * d[i];
      n++;
    }
  }
  const rms = Math.sqrt(sum / Math.max(1, n));
  return { peak, rms, peakDb: 20 * Math.log10(peak || 1e-12), rmsDb: 20 * Math.log10(rms || 1e-12) };
}

/** Peak of (a - b) in dBFS over the overlapping region, `shift` samples of b delay allowed. */
export function diffDb(a, b, shift = 0, from = 0, to = Infinity) {
  let peak = 0;
  const chans = Math.min(a.numberOfChannels, b.numberOfChannels);
  for (let c = 0; c < chans; c++) {
    const x = a.getChannelData(c);
    const y = b.getChannelData(c);
    const n = Math.min(x.length, y.length - shift, to);
    for (let i = Math.max(from, 0); i < n; i++) {
      const d = Math.abs(x[i] - y[i + shift]);
      if (d > peak) peak = d;
    }
  }
  return 20 * Math.log10(peak || 1e-12);
}

/** Level of one frequency in `data` (Goertzel), as linear amplitude. */
export function toneLevel(data, sampleRate, hz, from = 0, to = data.length) {
  const w = (2 * Math.PI * hz) / sampleRate;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = data[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const n = to - from;
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / n;
}

/* ── rendering through the app ────────────────────────────────────────── */

/**
 * Put `buffer` on a one-track project with `fx` (an array of
 * { type, params?, on? }) and bounce it with the app's own renderer.
 * opts: { sampleRate, tailSec, masterFx, clip }
 */
export async function renderWith(buffer, fx = [], opts = {}) {
  await ready();
  const project = newProject("test");
  const track = newTrack("t", 0);
  project.tracks = [track];
  const mk = (f) => {
    if (!getPlugin(f.type)) throw new Error(`no plugin "${f.type}"`);
    const def = newEffect(f.type);
    Object.assign(def.params, f.params ?? {});
    if (f.on === false) def.on = false;
    return def;
  };
  track.fx = fx.map(mk);
  project.master.fx = (opts.masterFx ?? []).map(mk);
  state.project = project;
  const id = "ast_test";
  assets.set(id, { id, name: "test", buffer, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels });
  const clip = newClip(id, track.id, 0, { fadeIn: 0, fadeOut: 0, ...(opts.clip ?? {}) });
  project.clips = [clip];
  opts.setup?.(project, track, clip);
  return renderRange(0, opts.end ?? clip.duration, { sampleRate: opts.sampleRate ?? buffer.sampleRate, tailSec: opts.tailSec ?? 0 });
}

export const fmt = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

/* ── live capture ─────────────────────────────────────────────────────── */

const CAPTURE = `
class TestCapture extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.start = o.processorOptions.start;
    this.n = o.processorOptions.frames;
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
    this.w = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.w < this.n) {
      const l = inp[0], r = inp[1] ?? inp[0];
      for (let i = 0; i < 128 && this.w < this.n; i++) {
        if (currentFrame + i < this.start) continue;
        this.L[this.w] = l ? l[i] : 0;
        this.R[this.w] = r ? r[i] : 0;
        this.w++;
      }
      if (this.w >= this.n) this.port.postMessage({ L: this.L, R: this.R });
    }
    return true;
  }
}
registerProcessor("test-capture", TestCapture);`;

let liveCtx = null;
/** One shared real-time context at 48 kHz, with the capture processor loaded. */
export async function live() {
  if (!liveCtx) {
    liveCtx = new AudioContext({ sampleRate: 48000 });
    await liveCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" })));
  }
  if (liveCtx.state !== "running") await liveCtx.resume();
  return liveCtx;
}

/**
 * Play `buffer` through `fx` in a real-time AudioContext — the same buildChain
 * the engine uses, in live mode — and capture what comes out, sample-aligned
 * with the start of the buffer. The counterpart of renderWith for parity checks.
 */
export async function liveRender(buffer, fx = [], opts = {}) {
  await ready();
  const ctx = await live();
  const { buildChain, disposeChain } = await import("../../src/audio/effects.js");
  const { prepareContext } = await import("../../src/plugins/worklets.js").catch(() => ({}));
  if (prepareContext) await prepareContext(ctx);
  const defs = fx.map((f) => {
    const def = newEffect(f.type);
    Object.assign(def.params, f.params ?? {});
    return def;
  });
  const input = ctx.createGain();
  const output = ctx.createGain();
  const chain = buildChain(ctx, defs, input, output, false);
  const frames = Math.round((buffer.duration + (opts.tailSec ?? 0)) * ctx.sampleRate);
  // Long enough for the 20 ms parameter ramps a live build starts with to settle.
  // …and on a render-block boundary, as an offline render's time zero is: the
  // native compressor updates its gain in fixed sub-blocks of that grid.
  const start = Math.ceil(((ctx.currentTime + (opts.settle ?? 0.25)) * ctx.sampleRate) / 128) * 128;
  // The engine and the bounce both take a chain's reported latency back out;
  // here that means starting the recording that much after the source.
  const { chainLatency } = await import("../../src/plugins/registry.js");
  const late = Math.round(chainLatency(defs, ctx.sampleRate) * ctx.sampleRate);
  const cap = new AudioWorkletNode(ctx, "test-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: { start: start + late, frames },
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  output.connect(cap).connect(mute).connect(ctx.destination);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(input);
  src.start(start / ctx.sampleRate);
  // Effects that follow their own envelope on the UI clock get their tick, as
  // the engine's frame loop would give them.
  const ticker = setInterval(() => chain.forEach((f) => f.tick?.(1 / 60)), 16);
  const data = await new Promise((res) => (cap.port.onmessage = (e) => res(e.data)));
  clearInterval(ticker);
  disposeChain(chain);
  src.disconnect();
  cap.disconnect();
  mute.disconnect();
  const out = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: ctx.sampleRate });
  out.copyToChannel(data.L, 0);
  out.copyToChannel(data.R, 1);
  return out;
}

/** Mean of every sample: a DC offset shows up here and clicks on bypass. */
export function dcOf(buf) {
  let s = 0;
  let n = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) s += d[i];
    n += d.length;
  }
  return s / Math.max(1, n);
}

/* ── the whole app ────────────────────────────────────────────────────── */

/**
 * Boot the real app in a full-size iframe and hand back its window once the
 * debug handle (`daw`) exists. UI specs drive it through `daw` and the DOM.
 */
export async function openApp() {
  document.querySelector("iframe")?.remove();
  const frame = document.createElement("iframe");
  frame.src = "/index.html";
  frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0";
  document.body.append(frame);
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (frame.contentWindow?.daw) break;
  }
  const win = frame.contentWindow;
  assert(win?.daw, "the app did not boot");
  win.__errors = [];
  // "ResizeObserver loop…" is the browser reporting a skipped layout pass, not a fault.
  win.addEventListener("error", (e) => /ResizeObserver/.test(e.message) || win.__errors.push(e.message));
  win.addEventListener("unhandledrejection", (e) => win.__errors.push(String(e.reason?.message ?? e.reason)));
  return win;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Record what the running app's engine sends to its output for `seconds`,
 * starting now. Returns an AudioBuffer at the engine's sample rate. Start
 * playback after calling this; the recording begins with whatever silence
 * precedes it.
 */
export async function captureEngine(win, seconds) {
  const { engine } = win.daw;
  const ctx = engine.ensure();
  await ctx.resume();
  if (!ctx.__testCapture) {
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([CAPTURE], { type: "text/javascript" })));
    ctx.__testCapture = true;
  }
  const frames = Math.round(seconds * ctx.sampleRate);
  const cap = new win.AudioWorkletNode(ctx, "test-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 2,
    channelCountMode: "explicit",
    processorOptions: { start: 0, frames },
  });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  engine.master.gain.connect(cap).connect(mute).connect(ctx.destination);
  const done = new Promise((res) => (cap.port.onmessage = (e) => res(e.data))).then((data) => {
    engine.master.gain.disconnect(cap);
    const out = new AudioBuffer({ numberOfChannels: 2, length: frames, sampleRate: ctx.sampleRate });
    out.copyToChannel(data.L, 0);
    out.copyToChannel(data.R, 1);
    return out;
  });
  return { done };
}

/** Index of the first sample of channel 0 above `threshold`. */
export function firstSound(buf, threshold = 1e-4) {
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) > threshold) return i;
  return -1;
}
