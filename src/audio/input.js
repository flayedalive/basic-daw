// Audio input: which devices to listen to, which of their channels each track
// records, hearing yourself through the track's inserts, capturing takes, and
// measuring the round trip so a take lands where it was played.
//
// Tracks record from the main input (chosen in Audio setup) unless they name
// another device — an interface and a USB mic can record side by side. Each
// device gets its own stream, capture node and latency.
//
// Everything here goes through the browser's own audio stack (WASAPI on
// Windows, Core Audio on macOS). There is no ASIO: a web page cannot load a
// driver. Interfaces still work — they expose a standard device alongside
// their ASIO driver — and the latency that ASIO would hide is measured and
// compensated instead.
//
// Device and latency choices belong to the machine, not the session, so they
// live in localStorage. Which input a track records from belongs to the
// session, so it lives on the track (`track.inputDevice`, `track.input`,
// `track.monitor`).
//
// Timing model for a take. The capture worklet stamps every batch with the
// context frame it was captured at. A sound the performer heard at context
// time t (via the transport's segment list) reaches us at t + roundTrip, so a
// sample captured at T belongs on the timeline at pos(T - roundTrip). Takes are
// assembled at the end, by position, from the segments the transport walked
// while recording — so a mid-take edit that restarts the transport still lines
// up.

import { clamp } from "../util.js";
import { bus, state } from "../state.js";
import { engine } from "./engine.js";

export const DEFAULT_INPUT = "1";
const PREFS_KEY = "daw.audio";
const BATCH = 2048; // frames per message from the capture worklet
// Calibration clicks, unevenly spaced so a steady hum or a periodic beep in
// the room can't line up with every one of them and pass for the loopback.
const CLICK_OFFSETS = [0, 0.47, 0.91, 1.43, 1.89, 2.41];
const CLICK_GAP_MIN = 0.44;

/* ── machine preferences ──────────────────────────────────────────────── */

const DEFAULT_PREFS = { inputId: "", outputId: "", latencyMs: null, deviceLatency: {} };

export function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the choice lasts for this page only */
  }
  bus.emit("audioinput");
  return next;
}

/* ── channel specs ────────────────────────────────────────────────────── */

/** "1" | "2" | "1+2" … (1-based, as printed on the interface) → 0-based indices. */
export function parseInput(spec, available = 2) {
  const parts = String(spec || DEFAULT_INPUT)
    .split("+")
    .map((s) => parseInt(s, 10) - 1)
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (!parts.length || parts.some((n) => n >= available)) return [0];
  return parts.slice(0, 2);
}

/** Choices for a track's input selector: every mono input, then stereo pairs. */
export function inputChoices(channels = 2) {
  const n = Math.max(1, channels);
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ value: String(i), label: `In ${i}` });
  for (let i = 1; i + 1 <= n; i += 2) out.push({ value: `${i}+${i + 1}`, label: `In ${i}+${i + 1} (stereo)` });
  return out;
}

export const inputLabel = (spec) => {
  const s = String(spec || DEFAULT_INPUT);
  return s.includes("+") ? `In ${s} (stereo)` : `In ${s}`;
};

/* ── the live inputs ──────────────────────────────────────────────────── */

/** A sample this close to full scale means the converter ran out of headroom. */
export const CLIP_LEVEL = 0.999;

/**
 * One open capture device. The main device (key "") is whichever input is
 * chosen in Audio setup; any other key is a browser deviceId a track points at
 * directly (a USB mic next to the interface, say).
 */
class DeviceInput {
  constructor(mgr, key) {
    this.mgr = mgr;
    this.key = key;
    this.stream = null;
    this.src = null;
    this.split = null;
    this.analysers = [];
    this.bufs = [];
    this.channels = 0; // 0 until opened
    this.label = "";
    this.deviceId = "";
    this.inputLatency = 0;
    this.fellBack = false;
    this.users = new Set();
    this.opening = null;
    this.clip = []; // per channel: hit full scale since last reset
  }

  get open() {
    return !!this.stream;
  }

  /** The id asked for: the saved choice for the main device, else the key. */
  get requestedId() {
    return this.key || loadPrefs().inputId;
  }

  async acquire(user) {
    this.users.add(user);
    try {
      if (!this.stream) await this.openDevice();
    } catch (err) {
      this.users.delete(user);
      throw err;
    }
    return this;
  }

  release(user) {
    this.users.delete(user);
    if (!this.users.size) this.close();
  }

  openDevice() {
    if (this.opening) return this.opening;
    this.opening = this._open().finally(() => (this.opening = null));
    return this.opening;
  }

  async _open() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("this browser cannot capture audio (it needs https or localhost)");
    }
    const ctx = engine.ensure();
    const id = this.requestedId;
    let stream;
    this.fellBack = false;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints(id) });
    } catch (err) {
      const missing = /Overconstrained|NotFound|NotReadable/.test(err.name);
      // The main input falls back to the default rather than refuse; a device a
      // track names explicitly must not silently become a different one.
      if (this.key || !id || !missing) {
        if (this.key && missing) throw new Error(`${this.mgr.nameOf(this.key)} isn't connected`);
        throw err;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints("") });
      this.fellBack = true;
    }
    if (!this.users.size) {
      // Everyone let go while the permission prompt was up.
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings?.() ?? {};
    const n = clamp(settings.channelCount || 2, 1, 32);
    const src = ctx.createMediaStreamSource(stream);
    // Discrete, so a 2-in interface stays as two inputs rather than a stereo
    // image the browser might fold.
    const split = ctx.createChannelSplitter(n);
    src.connect(split);
    this.analysers = [];
    this.bufs = [];
    for (let c = 0; c < n; c++) {
      const a = ctx.createAnalyser();
      a.fftSize = 1024; // > one 60 fps frame at 48 kHz, so no sample goes unseen
      split.connect(a, c);
      this.analysers.push(a);
      this.bufs.push(new Float32Array(a.fftSize));
    }

    this.stream = stream;
    this.src = src;
    this.split = split;
    this.channels = n;
    this.clip = new Array(n).fill(false);
    this.deviceId = settings.deviceId ?? "";
    this.label = track?.label || "Default input";
    this.mgr.remember(this.deviceId, this.label);
    this.inputLatency = Number(settings.latency) || 0;
    track?.addEventListener("ended", () => this.lost());
    this.mgr.syncMonitoring();
    bus.emit("audioinput");
  }

  close() {
    this.mgr.dropMonitors(this.key);
    try {
      this.src?.disconnect();
      this.split?.disconnect();
      for (const a of this.analysers) a.disconnect();
    } catch {
      /* already gone */
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = this.src = this.split = null;
    this.analysers = [];
    this.bufs = [];
    bus.emit("audioinput");
  }

  /** The device went away (unplugged, permission revoked). */
  lost() {
    if (!this.stream) return;
    if (this.mgr.capture?.parts.some((p) => p.dev === this)) this.mgr.onLost?.(this);
    // Everyone lets go; the next arm or meter reopens it (the main input falls
    // back to the default device if this one stays away).
    this.users.clear();
    this.close();
    bus.emit("audioinput", { lost: true, key: this.key });
  }

  /** Per-channel peak, 0..1, for meters. Latches `clip` on a full-scale sample. */
  levels() {
    const out = [];
    for (let c = 0; c < this.analysers.length; c++) {
      this.analysers[c].getFloatTimeDomainData(this.bufs[c]);
      let p = 0;
      for (const v of this.bufs[c]) {
        const a = v < 0 ? -v : v;
        if (a > p) p = a;
      }
      if (p >= CLIP_LEVEL) this.clip[c] = true;
      out.push(p);
    }
    return out;
  }

  /** A node carrying one input (mono) or a pair (stereo) from the splitter. */
  tap(spec) {
    const ctx = engine.ctx;
    const chans = parseInput(spec, this.channels);
    if (chans.length === 1) {
      const g = ctx.createGain();
      this.split.connect(g, chans[0]);
      return g;
    }
    const m = ctx.createChannelMerger(2);
    this.split.connect(m, chans[0], 0);
    this.split.connect(m, chans[1], 1);
    return m;
  }

  /** Capture node over every channel of this device. Resolves to {stop(): Promise<chunks>}. */
  async recorder() {
    const ctx = engine.ctx;
    const n = this.channels;
    const src = this.src;
    const chunks = []; // { t: context seconds of first frame, data: Float32Array[] }
    const sink = ctx.createGain();
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    let node;
    let finish;
    const finished = new Promise((r) => (finish = r));

    try {
      await ensureWorklet(ctx);
      node = new AudioWorkletNode(ctx, "daw-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: n,
        channelCountMode: "explicit",
        channelInterpretation: "discrete",
      });
      node.port.onmessage = (e) => {
        if (e.data === "done") return finish();
        chunks.push({ t: e.data.frame / ctx.sampleRate, data: e.data.data });
      };
    } catch {
      // Blocked blob workers or an old engine: ScriptProcessor still captures,
      // with a coarser timestamp that calibration absorbs.
      node = ctx.createScriptProcessor(4096, n, 1);
      node.onaudioprocess = (e) => {
        const ib = e.inputBuffer;
        const data = [];
        for (let c = 0; c < n; c++) data.push(new Float32Array(ib.getChannelData(Math.min(c, ib.numberOfChannels - 1))));
        chunks.push({ t: ctx.currentTime - ib.duration, data });
      };
    }
    src.connect(node);
    node.connect(sink);

    return {
      chunks,
      stop: async () => {
        if (node.port) {
          node.port.postMessage("stop");
          await Promise.race([finished, new Promise((r) => setTimeout(r, 600))]);
        }
        try {
          src.disconnect(node);
        } catch {
          /* source already closed */
        }
        node.disconnect();
        sink.disconnect();
        return chunks;
      },
    };
  }
}

/**
 * Every input in use. The main device keeps the single-device API the rest of
 * the app was written against (`input.channels`, `input.levels()` …); anything
 * that cares about a particular track asks by key (`input.keyOf(track)`).
 *
 * Each device runs on its own clock and settles at its own delay, so latency
 * is measured and applied per device, and a take records each device with its
 * own capture node. The browser resamples every stream to the engine's rate.
 */
class Input {
  constructor() {
    this.devices = new Map(); // key -> DeviceInput
    this.names = new Map(); // deviceId -> label, from enumerateDevices and opens
    this.monitors = []; // { node, key }
    this.monTargets = null;
    this.capture = null; // active take
    this.onLost = null; // transport hooks this to finish a take cleanly
    navigator.mediaDevices?.addEventListener?.("devicechange", () => this.refreshDevices());
  }

  device(key = "") {
    let d = this.devices.get(key);
    if (!d) {
      d = new DeviceInput(this, key);
      this.devices.set(key, d);
    }
    return d;
  }

  get main() {
    return this.device("");
  }

  /** "" for the main input (including a track naming the main input's own id). */
  keyFor(id) {
    if (!id) return "";
    const main = this.devices.get("");
    if (id === loadPrefs().inputId || (main?.open && id === main.deviceId)) return "";
    return id;
  }

  keyOf(track) {
    return this.keyFor(track?.inputDevice);
  }

  /** The open device a track records from, or null. */
  deviceOf(track) {
    const d = this.devices.get(this.keyOf(track));
    return d?.open ? d : null;
  }

  remember(id, label) {
    if (id && label) this.names.set(id, label);
  }

  nameOf(key) {
    if (!key) return this.main.label || "Main input";
    return this.devices.get(key)?.label || this.names.get(key) || "Saved device";
  }

  /** Re-read the device list (names appear once the page has mic permission). */
  async refreshDevices() {
    const { inputs } = await listDevices().catch(() => ({ inputs: [] }));
    for (const d of inputs) if (!ALIAS_IDS.has(d.deviceId)) this.remember(d.deviceId, d.label);
    this.connected = new Set(inputs.map((d) => d.deviceId));
    bus.emit("audioinput");
    return inputs;
  }

  /**
   * What a track can record from, for menus: the main input, every other
   * connected device, and the track's own saved device if it is unplugged.
   * Channel counts are known once a device has been opened; until then a
   * device is offered as stereo, and a choice past its last input falls back
   * to input 1 when it opens.
   */
  sources(track = null) {
    const out = [{ key: "", label: this.nameOf(""), channels: this.main.channels || 2, main: true }];
    const seen = new Set([""]);
    for (const [id, label] of this.names) {
      const key = this.keyFor(id);
      if (seen.has(key) || (this.connected && !this.connected.has(id))) continue;
      seen.add(key);
      out.push({ key, label, channels: this.devices.get(key)?.channels || 2 });
    }
    const own = this.keyOf(track);
    if (track && !seen.has(own)) {
      const name = this.names.get(own) || track.inputDeviceName || "Saved device";
      out.push({ key: own, label: `${name} (not connected)`, channels: 2, missing: true });
    }
    return out;
  }

  // ── the main device, for code written before there could be several ──
  get open() {
    return this.main.open;
  }
  get channels() {
    return this.main.channels;
  }
  get deviceLabel() {
    return this.main.label;
  }
  get deviceId() {
    return this.main.deviceId;
  }
  get fellBack() {
    return this.main.fellBack;
  }

  async acquire(user, key = "") {
    await this.device(key).acquire(user);
    this.refreshDevices();
    return this;
  }

  release(user, key = "") {
    this.devices.get(key)?.release(user);
  }

  levels(key = "") {
    const d = this.devices.get(key);
    return d?.open ? d.levels() : [];
  }

  /** Did any of these channels (0-based) on device `key` hit full scale? */
  clipped(key, chans) {
    const d = this.devices.get(key);
    return !!d && chans.some((c) => d.clip[c]);
  }

  resetClips(key = null) {
    for (const [k, d] of this.devices) if (key == null || k === key) d.clip.fill(false);
  }

  /** Switch the main device: keep whoever was holding it, reopen on the new one. */
  async setInputDevice(id) {
    if (this.capture) throw new Error("finish recording before changing the input");
    savePrefs({ inputId: id });
    // Which device a track's key resolves to may have changed: start over and
    // let arming and the dialog take back what they need.
    const users = [...this.main.users];
    for (const d of this.devices.values()) {
      d.users.clear();
      if (d.open) d.close();
    }
    this.devices.clear();
    this.monTargets = null;
    for (const u of users.filter((u) => u !== "armed")) await this.device("").acquire(u);
    this.syncMonitoring();
  }

  /* ── latency ─────────────────────────────────────────────────────────── */

  /** What the browser reports for the round trip through device `key`, in seconds. */
  estimatedLatency(key = "") {
    const ctx = engine.ctx;
    const out = (ctx?.baseLatency || 0) + (ctx?.outputLatency || 0);
    const inp = this.devices.get(key)?.inputLatency || 0;
    return { output: out, input: inp, total: out + inp };
  }

  /** Saved shift for device `key` in ms, or null to use the estimate. */
  savedLatency(key = "") {
    const p = loadPrefs();
    const v = key ? p.deviceLatency?.[key] : p.latencyMs;
    return v != null && isFinite(v) ? v : null;
  }

  setSavedLatency(key, ms) {
    if (!key) return savePrefs({ latencyMs: ms });
    const map = { ...(loadPrefs().deviceLatency ?? {}) };
    if (ms == null) delete map[key];
    else map[key] = ms;
    return savePrefs({ deviceLatency: map });
  }

  /** The offset applied to takes from device `key`. */
  compensation(key = "") {
    const v = this.savedLatency(key);
    if (v != null) return { seconds: v / 1000, source: "calibrated" };
    return { seconds: this.estimatedLatency(key).total, source: "estimated" };
  }

  /* ── arming & monitoring ─────────────────────────────────────────────── */

  /**
   * Keep each device open while a track armed on it, and route every armed,
   * monitoring track's input into that track so you hear yourself through its
   * inserts, fader and pan.
   *
   * Holding a device open while armed is about timing as much as speed: a
   * browser's capture path can settle at a slightly different delay each time
   * it is opened, so the measured latency only holds for the open it was
   * measured on. Arm, calibrate, record — all on one open — and takes land
   * where they were played. It also means record starts without a permission
   * round trip.
   */
  syncMonitoring() {
    if (!engine.ctx) return;
    const armed = state.project.tracks.filter((t) => t.armed);
    const need = new Set(armed.map((t) => this.keyOf(t)));
    for (const key of need) {
      const d = this.device(key);
      if (!d.users.has("armed")) {
        d.acquire("armed").catch((err) => bus.emit("audioinput", { error: err, key }));
      }
    }
    for (const [key, d] of this.devices) if (!need.has(key) && d.users.has("armed")) d.release("armed");

    const want = armed.filter((t) => t.monitor && engine.tracks.has(t.id) && this.deviceOf(t));
    // Mix events fire on every fader release; only rewire when routing changed.
    // (Compared by node bundle, so a track rebuilt by undo gets rewired.)
    const targets = want.map((t) => [engine.tracks.get(t.id), String(t.input), this.deviceOf(t).split]);
    const same =
      this.monTargets?.length === targets.length &&
      targets.every((x, i) => x.every((v, j) => v === this.monTargets[i][j]));
    if (same && this.monitors.length === want.length) return;
    this.unrouteMonitors();
    this.monTargets = targets;
    for (const track of want) {
      const dev = this.deviceOf(track);
      const node = dev.tap(track.input);
      node.connect(engine.trackInput(track.id));
      this.monitors.push({ node, key: dev.key });
    }
  }

  unrouteMonitors() {
    for (const { node } of this.monitors) {
      try {
        node.disconnect();
      } catch {
        /* torn down */
      }
    }
    this.monitors = [];
    this.monTargets = null;
  }

  /** A device closed: its monitors go with it; the rest stay put. */
  dropMonitors(key) {
    const keep = [];
    for (const m of this.monitors) {
      if (m.key !== key) keep.push(m);
      else
        try {
          m.node.disconnect();
        } catch {
          /* torn down */
        }
    }
    if (keep.length !== this.monitors.length) this.monTargets = null;
    this.monitors = keep;
  }

  /* ── recording ───────────────────────────────────────────────────────── */

  /**
   * Start capturing for the given armed tracks — one capture node per device
   * they use. The transport must start (or restart) playback *after* this so
   * its segments are logged for the take.
   */
  async startCapture(tracks) {
    const byKey = new Map();
    for (const t of tracks) {
      const k = this.keyOf(t);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(t);
    }
    const parts = [];
    try {
      for (const [key, list] of byKey) {
        const dev = this.device(key);
        await dev.acquire("record");
        const part = { key, dev, tap: null };
        parts.push(part);
        part.tap = await dev.recorder();
        part.roundTrip = this.compensation(key).seconds;
        // Snapshot which inputs feed which tracks: changing a track's input
        // mid-take should not rewrite the take.
        part.targets = list.map((t) => ({ trackId: t.id, chans: parseInput(t.input, dev.channels) }));
      }
    } catch (err) {
      for (const p of parts) {
        await p.tap?.stop().catch(() => {});
        p.dev.release("record");
      }
      throw err;
    }
    // A clip light from before this take shouldn't be read as this take's.
    for (const p of parts) p.dev.clip.fill(false);
    this.capture = { parts, sampleRate: engine.ctx.sampleRate };
    engine.recLog = [];
    engine.recording = true;
    return this.capture;
  }

  /** Device names in the take being recorded, for messages. */
  captureLabel() {
    return (this.capture?.parts ?? []).map((p) => p.dev.label).join(" + ");
  }

  /**
   * Stop capturing and assemble one take per target track. The synchronous
   * part (before the first await) ends the take *now*, so callers can stop the
   * transport straight after without clipping or extending it.
   */
  async stopCapture() {
    const cap = this.capture;
    const now = engine.ctx.currentTime;
    // Close the take on *copies*: the last logged segment is still the
    // transport's live one when playback carries on past the take (stopping
    // with the record button). Clamping it in place left it ending "now" on the
    // clock but at Infinity on the timeline, and the playhead jumped there.
    const log = (engine.recLog ?? []).map((seg) => ({ ...seg, ctxEnd: Math.min(seg.ctxEnd, now) }));
    this.capture = null;
    engine.recording = false;
    engine.recLog = null;
    if (!cap) return [];
    const sets = await Promise.all(cap.parts.map((p) => p.tap.stop().catch(() => [])));
    const takes = [];
    cap.parts.forEach((p, i) => {
      p.dev.release("record");
      const made = assembleTakes(sets[i], log, { roundTrip: p.roundTrip, targets: p.targets, sampleRate: cap.sampleRate });
      for (const t of made) takes.push({ ...t, device: p.dev.label });
    });
    return takes;
  }

  /* ── calibration ─────────────────────────────────────────────────────── */

  /**
   * Measure the real round trip through device `key`: play a few clicks and
   * find them in its input. Needs the output to reach the input — a cable from
   * an output to an input, or speakers near a mic. Resolves to
   * { ms, spread, hits, channel } or throws.
   */
  async calibrate(key = "") {
    if (this.capture) throw new Error("finish recording first");
    const dev = this.device(key);
    await dev.acquire("calibrate");
    let rec;
    try {
      const ctx = engine.ctx;
      rec = await dev.recorder();
      const pre = 0.5;
      const t0 = ctx.currentTime + pre;
      const burst = clickBuffer(ctx);
      const times = [];
      for (const off of CLICK_OFFSETS) {
        const when = t0 + off;
        const s = ctx.createBufferSource();
        s.buffer = burst;
        // Straight to the output: the master chain must not colour the test.
        s.connect(ctx.destination);
        s.start(when);
        times.push(when);
      }
      await new Promise((r) => setTimeout(r, (pre + CLICK_OFFSETS.at(-1) + 0.8) * 1000));
      const chunks = await rec.stop();
      rec = null;
      return findClicks(chunks, times, ctx.sampleRate, CLICK_GAP_MIN);
    } finally {
      if (rec) await rec.stop().catch(() => {});
      dev.release("calibrate");
    }
  }
}

// Windows lists these as extra entries that alias real devices.
const ALIAS_IDS = new Set(["default", "communications", ""]);

export const input = new Input();

/** A track's input in words: "In 1" for the main device, "USB Mic · In 1" for another. */
export function trackInputLabel(track) {
  const key = input.keyOf(track);
  const spec = inputLabel(track?.input);
  if (!key) return spec;
  return `${input.names.get(key) || track.inputDeviceName || "Saved device"} · ${spec}`;
}

/** Point a track at device `key` ("" = the main input) and input `spec`. */
export function setTrackInput(track, key, spec) {
  track.inputDevice = key;
  track.inputDeviceName = key ? input.nameOf(key) : "";
  track.input = spec;
}

/* ── device lists & output ────────────────────────────────────────────── */

export const canChooseOutput = () => typeof globalThis.AudioContext?.prototype?.setSinkId === "function";

/** Lists inputs and outputs. Names are blank until the page has mic permission. */
export async function listDevices() {
  const all = (await navigator.mediaDevices?.enumerateDevices?.()) ?? [];
  const inputs = all.filter((d) => d.kind === "audioinput");
  const outputs = all.filter((d) => d.kind === "audiooutput");
  return { inputs, outputs, labelled: inputs.some((d) => d.label) };
}

/** Ask for mic permission without keeping the device open. */
export async function requestPermission() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true });
  s.getTracks().forEach((t) => t.stop());
}

/** Send the whole mix to a chosen output device, where the browser allows it. */
export async function setOutputDevice(id, save = true) {
  if (save) savePrefs({ outputId: id });
  const ctx = engine.ctx;
  if (!ctx || !canChooseOutput()) return false;
  try {
    await ctx.setSinkId(id || "");
    return true;
  } catch (err) {
    if (id) await ctx.setSinkId("").catch(() => {});
    throw err;
  }
}

/** Re-apply the saved output once the audio context exists. */
export async function applySavedOutput() {
  const { outputId } = loadPrefs();
  if (!outputId) return;
  try {
    await setOutputDevice(outputId, false);
  } catch {
    /* device gone: the system default is already in use */
  }
}

/* ── internals ────────────────────────────────────────────────────────── */

function constraints(deviceId) {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    // Call-quality processing ruins instruments: always off.
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    // Ask for every input the device has; browsers settle on what they can.
    channelCount: { ideal: 8 },
    latency: { ideal: 0 },
  };
}

const worklets = new WeakMap();
function ensureWorklet(ctx) {
  if (!worklets.has(ctx)) {
    const p = ctx.audioWorklet.addModule(captureWorkletUrl());
    p.catch(() => worklets.delete(ctx));
    worklets.set(ctx, p);
  }
  return worklets.get(ctx);
}

let workletUrl = null;
function captureWorkletUrl() {
  if (workletUrl) return workletUrl;
  const code = `
    const BATCH = ${BATCH};
    class DawCapture extends AudioWorkletProcessor {
      constructor() {
        super();
        this.buf = null;
        this.fill = 0;
        this.start = 0;
        this.on = true;
        this.port.onmessage = (e) => {
          if (e.data !== "stop") return;
          this.flush();
          this.on = false;
          this.port.postMessage("done");
        };
      }
      process(inputs) {
        if (!this.on) return false;
        const inp = inputs[0];
        const n = inp ? inp.length : 0;
        if (!n) return true;
        if (!this.buf || this.buf.length !== n) {
          this.flush();
          this.buf = Array.from({ length: n }, () => new Float32Array(BATCH));
        }
        if (this.fill === 0) this.start = currentFrame;
        const len = inp[0].length;
        for (let c = 0; c < n; c++) this.buf[c].set(inp[c], this.fill);
        this.fill += len;
        if (this.fill + len > BATCH) this.flush();
        return true;
      }
      flush() {
        if (!this.buf || !this.fill) return;
        const data = this.buf.map((b) => b.slice(0, this.fill));
        this.port.postMessage({ frame: this.start, data }, data.map((d) => d.buffer));
        this.fill = 0;
      }
    }
    registerProcessor("daw-capture", DawCapture);
  `;
  workletUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  return workletUrl;
}

/**
 * Lay captured chunks onto the timeline. Each chunk is shifted back by the
 * round trip, then split across the transport segments it overlaps; anything
 * outside a segment (before playback began, during a restart gap) is dropped.
 */
export function assembleTakes(chunks, log, { roundTrip, targets, sampleRate: sr }) {
  const pieces = [];
  for (const { t, data } of chunks) {
    const len = data[0]?.length ?? 0;
    if (!len) continue;
    const a0 = t - roundTrip;
    const a1 = a0 + len / sr;
    for (const seg of log) {
      const a = Math.max(a0, seg.ctxStart);
      const b = Math.min(a1, seg.ctxEnd);
      if (b <= a) continue;
      const i0 = Math.round((a - a0) * sr);
      const i1 = Math.min(len, Math.round((b - a0) * sr));
      if (i1 <= i0) continue;
      pieces.push({ pos: seg.posStart + (a - seg.ctxStart), data, i0, i1 });
    }
  }
  if (!pieces.length) return [];

  const start = Math.max(0, Math.min(...pieces.map((p) => p.pos)));
  const end = Math.max(...pieces.map((p) => p.pos + (p.i1 - p.i0) / sr));
  const frames = Math.ceil((end - start) * sr);
  if (frames <= 0 || frames > sr * 60 * 60 * 3) return [];

  return targets.map(({ trackId, chans }) => {
    const out = chans.map(() => new Float32Array(frames));
    for (const p of pieces) {
      let at = Math.round((p.pos - start) * sr);
      let i0 = p.i0;
      if (at < 0) {
        i0 -= at;
        at = 0;
      }
      const count = Math.min(p.i1 - i0, frames - at);
      if (count <= 0) continue;
      chans.forEach((c, k) => {
        const src = p.data[Math.min(c, p.data.length - 1)];
        out[k].set(src.subarray(i0, i0 + count), at);
      });
    }
    return { trackId, startPos: start, channels: out, sampleRate: sr };
  });
}

/** 3 ms of deterministic noise: broadband, sharp onset, easy to find. */
function clickBuffer(ctx) {
  const n = Math.round(ctx.sampleRate * 0.003);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    d[i] = ((x / 0x7fffffff) * 2 - 1) * 0.7 * (1 - i / n);
  }
  return buf;
}

/** Find each scheduled click in the captured audio; median of the delays. */
export function findClicks(chunks, times, sr, gap) {
  if (!chunks.length) throw new Error("no audio came in from the input");
  const n = chunks[0].data.length;
  const t0 = chunks[0].t;
  const total = chunks.reduce((s, c) => s + c.data[0].length, 0);
  const lanes = Array.from({ length: n }, () => new Float32Array(total));
  let off = 0;
  for (const c of chunks) {
    for (let k = 0; k < n; k++) lanes[k].set(c.data[Math.min(k, c.data.length - 1)], off);
    off += c.data[0].length;
  }
  const idx = (t) => clamp(Math.round((t - t0) * sr), 0, total);
  const peakIn = (lane, a, b) => {
    let p = 0;
    for (let i = a; i < b; i++) {
      const v = Math.abs(lane[i]);
      if (v > p) p = v;
    }
    return p;
  };

  // Use whichever input heard the clicks best.
  let best = null;
  for (let ch = 0; ch < n; ch++) {
    const lane = lanes[ch];
    const noise = peakIn(lane, idx(times[0] - 0.4), idx(times[0] - 0.02));
    const delays = [];
    for (const t of times) {
      const a = idx(t);
      const b = idx(t + Math.min(0.45, gap * 0.9));
      const peak = peakIn(lane, a, b);
      if (peak < Math.max(noise * 4, 0.004)) continue;
      const thresh = Math.max(noise * 3, peak * 0.35);
      let i = a;
      while (i < b && Math.abs(lane[i]) < thresh) i++;
      if (i < b) delays.push((i - a) / sr);
    }
    if (!best || delays.length > best.delays.length) best = { ch, delays };
  }

  const d = best?.delays ?? [];
  if (d.length < Math.ceil(times.length / 2)) {
    throw new Error("couldn't hear the test clicks — turn the output up, or loop an output into an input");
  }
  // A loopback answers the same way every time; stray noise does not.
  d.sort((x, y) => x - y);
  const median = d[Math.floor(d.length / 2)];
  const agree = d.filter((x) => Math.abs(x - median) <= 0.002);
  if (agree.length < Math.ceil(times.length / 2)) {
    throw new Error("the clicks came back at inconsistent times — use a cable loop, or quieten the room");
  }
  const mean = agree.reduce((s, x) => s + x, 0) / agree.length;
  return {
    ms: Math.round(mean * 10000) / 10,
    spread: Math.round((agree.at(-1) - agree[0]) * 10000) / 10,
    hits: agree.length,
    of: times.length,
    channel: best.ch + 1,
  };
}

