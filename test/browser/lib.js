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
