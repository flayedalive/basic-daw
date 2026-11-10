// The audio engine: one AudioContext, one mixer graph, and a look-ahead
// scheduler that starts an AudioBufferSourceNode per clip a fraction of a
// second before it is due.
//
// Timing model. While playing, the transport walks a list of *segments* that
// map context time to timeline time:
//
//   segment = { ctxStart, ctxEnd, posStart, posEnd }
//
// Without a loop there is exactly one open-ended segment. With a loop, a new
// segment is appended every time the playhead wraps. Both the scheduler and
// the position readout consult the same list, so the playhead can never drift
// away from what you hear.

import { clamp, dbToGain } from "../util.js";
import { assets, state, trackAudible, beatSeconds } from "../state.js";
import { buildChain, disposeChain } from "./effects.js";
import { playbackOf } from "./clipaudio.js";
import { signatureOf, chainLatency } from "../plugins/registry.js";
import { prepareContext, contextReady, registerWorklets } from "../plugins/worklets.js";

const LOOKAHEAD = 0.35; // seconds of audio scheduled ahead of the clock
const TICK_MS = 40;
const CHUNK = 0.5; // max timeline seconds scheduled per pass
const MAX_COMPENSATION = 2; // seconds of plugin latency a track can be held back by

// The master's live loudness meter (LUFS, true peak). Not a plugin — it only
// listens — but its processor is loaded the same way theirs are.
const [LOUDNESS_METER] = registerWorklets([{ name: "daw-loudness", url: new URL("../plugins/worklets/loudness-meter.js", import.meta.url).href }]);

class Engine {
  constructor() {
    this.ctx = null;
    this.latency = { tracks: 0, master: 0, total: 0 };
    this.loudness = null; // latest report from the master's loudness meter
    this.playing = false;
    this.recording = false;
    this.tracks = new Map(); // trackId -> node bundle
    this.master = null;
    this.segments = [];
    this.sched = null; // { pos, ctxTime, segIndex, straddle }
    this.sources = new Set();
    this.timer = null;
    this.levels = new Map(); // trackId | "master" -> {peak, peakR, hold}
    this.clips = new Set(); // ids ("master" too) whose level reached 0 dBFS since last reset
    this.metronome = false;
    this.fxSignature = "";
    this.onTick = null; // main.js hooks the UI refresh here
    this.recLog = null; // segments walked while recording (audio/input.js reads them)
    this.onRecordStop = null; // transport finishes the take before a stop
    this.preview = null;
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /** Must be called from a user gesture the first time. */
  ensure() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx = new AC({ latencyHint: "interactive" });
      this.buildMaster();
      this.syncGraph();
      this.loadWorklets();
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  /**
   * Load the AudioWorklet modules plugins have declared, then rebuild any chain
   * that was built as a passthrough while waiting for them.
   */
  loadWorklets() {
    const ctx = this.ctx;
    if (!ctx) return;
    if (contextReady(ctx)) return this.attachLoudnessMeter();
    prepareContext(ctx).then(
      () => {
        const pending = (live) => live.some((fx) => fx.pending);
        if (pending(this.master.fxLive) || [...this.tracks.values()].some((b) => pending(b.fxLive))) this.rebuildAllChains();
        this.attachLoudnessMeter();
      },
      (err) => console.warn(err.message),
    );
  }

  /**
   * Hang the loudness meter off the master output. It posts momentary,
   * short-term and integrated LUFS and true peak ten times a second; the
   * latest is kept in `this.loudness` for the analyzer panel. Display only.
   */
  attachLoudnessMeter() {
    const m = this.master;
    if (!m || m.loudnessNode || !contextReady(this.ctx, [LOUDNESS_METER])) return;
    const node = new AudioWorkletNode(this.ctx, LOUDNESS_METER.name, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, channelCountMode: "explicit" });
    const mute = this.ctx.createGain();
    mute.gain.value = 0; // a node has to lead somewhere to be run at all
    m.gain.connect(node).connect(mute).connect(this.ctx.destination);
    node.port.onmessage = (e) => (this.loudness = e.data);
    m.loudnessNode = node;
  }

  /** Start the integrated loudness and the true-peak hold again. */
  resetLoudness() {
    this.master?.loudnessNode?.port.postMessage("reset");
  }

  buildMaster() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    const analyserR = ctx.createAnalyser();
    // Large enough for the spectrum display's low end (5.9 Hz bins at 48 kHz).
    // The analyzer reads the two channels separately rather than a mono sum,
    // which would hide exactly the out-of-phase content it exists to show.
    analyserL.fftSize = analyserR.fftSize = 8192;
    analyserL.smoothingTimeConstant = analyserR.smoothingTimeConstant = 0.7;
    analyserL.minDecibels = analyserR.minDecibels = -120;
    gain.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);
    gain.connect(ctx.destination);
    this.master = {
      input,
      gain,
      analyserL,
      analyserR,
      bufL: new Float32Array(analyserL.fftSize),
      bufR: new Float32Array(analyserR.fftSize),
      fxLive: [],
    };
    this.rebuildMasterChain();
  }

  rebuildMasterChain() {
    const { input, gain, fxLive } = this.master;
    disposeChain(fxLive);
    input.disconnect();
    this.master.fxLive = buildChain(this.ctx, state.project.master.fx, input, gain);
  }

  /* ── graph ─────────────────────────────────────────────────────────── */

  /** Create/remove per-track node bundles so the graph matches the document. */
  syncGraph() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const want = new Set(state.project.tracks.map((t) => t.id));

    for (const [id, bundle] of this.tracks) {
      if (!want.has(id)) {
        disposeChain(bundle.fxLive);
        bundle.input.disconnect();
        bundle.gain.disconnect();
        bundle.pan.disconnect();
        bundle.comp.disconnect();
        this.tracks.delete(id);
        this.levels.delete(id);
      }
    }

    for (const t of state.project.tracks) {
      if (this.tracks.has(t.id)) continue;
      const input = ctx.createGain();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Plugin delay compensation: every track is held back by however much
      // less latency its inserts add than the slowest track's (see updateLatency).
      const comp = ctx.createDelay(MAX_COMPENSATION);
      gain.connect(pan).connect(analyser);
      pan.connect(comp).connect(this.master.input);
      const bundle = {
        input,
        gain,
        pan,
        comp,
        analyser,
        buf: new Float32Array(analyser.fftSize),
        fxLive: [],
        fxSig: "",
      };
      this.tracks.set(t.id, bundle);
      this.rebuildTrackChain(t, bundle);
    }

    // Rebuild any chain whose effect list changed shape (type/bypass/order).
    for (const t of state.project.tracks) {
      const bundle = this.tracks.get(t.id);
      const sig = signatureOf(t.fx);
      if (sig !== bundle.fxSig) this.rebuildTrackChain(t, bundle);
    }
    const msig = signatureOf(state.project.master.fx);
    if (msig !== this.fxSignature) {
      this.fxSignature = msig;
      this.rebuildMasterChain();
    }

    this.updateMix();
  }

  /**
   * Force every insert chain to be rebuilt.
   *
   * Installing or removing a plugin does not change any chain's signature — the
   * effect definitions are untouched, only what they resolve to — so the normal
   * `syncGraph` comparison would see no work to do and a newly installed plugin
   * would stay a passthrough until something else disturbed the graph.
   */
  rebuildAllChains() {
    if (!this.ctx) return;
    for (const track of state.project.tracks) this.rebuildTrackChain(track);
    this.rebuildMasterChain();
    this.fxSignature = signatureOf(state.project.master.fx);
    this.updateMix();
    this.loadWorklets(); // a plugin installed since the context was made may have brought modules
  }

  rebuildTrackChain(track, bundle = this.tracks.get(track.id)) {
    if (!bundle) return;
    disposeChain(bundle.fxLive);
    bundle.input.disconnect();
    bundle.fxLive = buildChain(this.ctx, track.fx, bundle.input, bundle.gain);
    bundle.fxSig = signatureOf(track.fx);
  }

  /** Push live parameter values (fader, pan, mute/solo, fx params) into nodes. */
  updateMix() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    for (const track of state.project.tracks) {
      const b = this.tracks.get(track.id);
      if (!b) continue;
      const g = trackAudible(track) ? dbToGain(track.volumeDb) : 0;
      b.gain.gain.setTargetAtTime(g, t0, 0.01);
      b.pan.pan.setTargetAtTime(clamp(track.pan, -1, 1), t0, 0.01);
      syncChainParams(track.fx, b.fxLive);
    }
    this.master.gain.gain.setTargetAtTime(dbToGain(state.project.master.volumeDb), t0, 0.01);
    syncChainParams(state.project.master.fx, this.master.fxLive);
    this.updateLatency();
  }

  /**
   * Plugin delay compensation.
   *
   * A plugin that looks ahead delays its track. Each track is delayed by the
   * difference between the slowest track's insert latency and its own, so they
   * all reach the master together. Routing is tracks → master only, which is
   * what keeps this to one delay per track. What is left — the slowest track
   * plus the master chain — delays everything alike: `latency.total` is taken
   * off the playhead, added to the metronome and to the shift applied to
   * recorded takes, and trimmed from the head of a bounce.
   */
  updateLatency() {
    const own = new Map();
    let slowest = 0;
    for (const track of state.project.tracks) {
      const l = this.livePending(track.id) ? 0 : chainLatency(track.fx, this.sampleRate);
      own.set(track.id, l);
      if (l > slowest) slowest = l;
    }
    for (const [id, b] of this.tracks) {
      const d = Math.min(MAX_COMPENSATION, slowest - (own.get(id) ?? 0));
      if (Math.abs(b.comp.delayTime.value - d) > 1e-7) b.comp.delayTime.setValueAtTime(d, this.ctx.currentTime);
    }
    const master = this.livePending("master") ? 0 : chainLatency(state.project.master.fx, this.sampleRate);
    this.latency = { tracks: slowest, master, total: slowest + master };
  }

  /** True while a chain holds a worklet plugin that is standing in as a passthrough. */
  livePending(ownerId) {
    const live = ownerId === "master" ? this.master?.fxLive : this.tracks.get(ownerId)?.fxLive;
    return !!live?.some((fx) => fx.pending);
  }

  /** The live instance of an insert, for UI that reads from it (the tuner). Null when bypassed or not built. */
  liveEffect(ownerId, fxId) {
    const live = ownerId === "master" ? this.master?.fxLive : this.tracks.get(ownerId)?.fxLive;
    return live?.find((f) => f.id === fxId) ?? null;
  }

  trackInput(trackId) {
    return this.tracks.get(trackId)?.input ?? this.master.input;
  }

  /* ── transport ─────────────────────────────────────────────────────── */

  get position() {
    if (!this.playing || !this.ctx) return state.playhead;
    // What is being *heard* now left the clips `latency.total` ago.
    const now = this.ctx.currentTime - this.latency.total;
    const segs = this.segments;
    if (!segs.length) return state.playhead;
    // Inside the short pad before the first segment starts sounding.
    if (now < segs[0].ctxStart) return segs[0].posStart;
    for (const s of segs) {
      if (now >= s.ctxStart && now < s.ctxEnd) return s.posStart + (now - s.ctxStart);
    }
    // Past every segment's end (a loop wrap scheduled but not yet heard): hold
    // the end — but never report an open-ended segment's Infinity as a place.
    const last = segs.at(-1);
    return Number.isFinite(last.posEnd) ? last.posEnd : last.posStart + (now - last.ctxStart);
  }

  play(from = state.playhead) {
    this.ensure();
    if (this.playing) return;
    const loop = state.project.loop;
    // A take is laid down linearly; the loop region comes back when it ends.
    const looping = loop.enabled && !this.recording;
    let pos = from;
    if (looping && (pos < loop.start || pos >= loop.end)) pos = loop.start;
    const start = this.ctx.currentTime + 0.06; // small pad so the first clips land cleanly
    this.segments = [makeSegment(start, pos, looping ? loop.end : Infinity)];
    this.recLog?.push(this.segments[0]);
    this.playStart = pos;
    this.resetLoudness(); // "integrated" means: since you last pressed play
    this.sched = { pos, ctxTime: start, segIndex: 0, straddle: true, lastBeat: -1 };
    this.playing = true;
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  pause() {
    if (!this.playing) return;
    state.playhead = Math.max(0, this.position);
    this.halt();
  }

  /** Stop parks the playhead where playback began; stopping twice returns to zero. */
  stop() {
    const wasPlaying = this.playing;
    if (this.recording) this.onRecordStop?.();
    this.halt();
    state.playhead = wasPlaying ? (this.playStart ?? 0) : 0;
  }

  halt() {
    // A restart mid-take (an edit, a loop toggle) leaves a gap; close the
    // segment here so the take is not stretched across it.
    const open = this.segments.at(-1);
    if (this.recLog && open && this.ctx) open.ctxEnd = Math.min(open.ctxEnd, this.ctx.currentTime);
    clearInterval(this.timer);
    this.timer = null;
    this.playing = false;
    this.killSources();
    this.segments = [];
    this.sched = null;
  }

  seek(pos) {
    if (this.recording) return; // a take stays where it started
    const p = Math.max(0, pos);
    if (this.playing) {
      this.halt();
      state.playhead = p;
      this.play(p);
    } else {
      state.playhead = p;
    }
  }

  /** Re-derive scheduled audio after an edit (clip moved, track muted, …). */
  invalidate() {
    if (!this.playing) return;
    const pos = this.position;
    this.halt();
    this.play(pos);
  }

  killSources() {
    for (const s of this.sources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* already finished */
      }
    }
    this.sources.clear();
  }

  /* ── scheduler ─────────────────────────────────────────────────────── */

  tick() {
    if (!this.playing) return;
    const ctx = this.ctx;
    const horizon = ctx.currentTime + LOOKAHEAD;
    let guard = 0;

    while (this.sched.ctxTime < horizon && guard++ < 64) {
      const seg = this.segments[this.sched.segIndex];
      const to = Math.min(seg.posEnd, this.sched.pos + CHUNK);
      this.scheduleRange(this.sched.pos, to, this.sched.ctxTime, this.sched.straddle, seg);
      const advanced = to - this.sched.pos;
      this.sched.pos = to;
      this.sched.ctxTime += advanced;
      this.sched.straddle = false;

      if (this.sched.pos >= seg.posEnd - 1e-9) {
        // Loop wrap: close this segment and open the next one at the loop start.
        seg.ctxEnd = this.sched.ctxTime;
        const loop = state.project.loop;
        const next = makeSegment(this.sched.ctxTime, loop.start, loop.end);
        this.segments.push(next);
        this.sched.segIndex = this.segments.length - 1;
        this.sched.pos = loop.start;
        this.sched.straddle = true;
      }
    }

    // Drop segments that are fully in the past.
    while (this.segments.length > 1 && this.segments[0].ctxEnd < ctx.currentTime - 1) this.segments.shift();
    this.sched.segIndex = this.segments.length - 1;

    // When not looping, stop once everything scheduled has played out —
    // unless recording, where running past the last clip is the point.
    if (!state.project.loop.enabled && !this.recording) {
      const end = projectEnd();
      if (this.position > end + 0.25 && this.sources.size === 0) {
        state.playhead = end;
        this.halt();
        this.onTick?.("ended");
        return;
      }
    }
    this.onTick?.("tick");
  }

  /**
   * Start every clip that begins inside [p0, p1) — plus, on the first pass of a
   * segment, any clip already in progress at p0. `p1` bounds only *what starts
   * here*: a clip that starts in this window plays on to its own end (or to the
   * loop boundary), never to the end of the scheduling chunk.
   */
  scheduleRange(p0, p1, ctxAt, straddle, seg) {
    const project = state.project;

    for (const clip of project.clips) {
      if (clip.mute) continue;
      const track = project.tracks.find((t) => t.id === clip.trackId);
      if (!track || !trackAudible(track)) continue;
      const asset = assets.get(clip.assetId);
      if (!asset?.buffer) continue;

      const clipEnd = clip.start + clip.duration;
      const startsHere = clip.start >= p0 - 1e-9 && clip.start < p1;
      const ongoing = straddle && clip.start < p0 && clipEnd > p0;
      if (!startsHere && !ongoing) continue;

      const from = Math.max(clip.start, p0);
      const until = Math.min(clipEnd, seg.posEnd);
      if (until <= from + 1e-6) continue;

      this.spawnClip(clip, asset, track, from, until, ctxAt + (from - p0));
    }

    if (this.metronome) this.scheduleClicks(p0, Math.min(p1, seg.posEnd), ctxAt);
  }

  spawnClip(clip, asset, track, fromPos, untilPos, when) {
    const ctx = this.ctx;
    // The asset itself, or the stretched copy a pitch-locked clip plays.
    const pb = playbackOf(clip, asset);
    const buffer = pb.buffer;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = pb.playbackRate;
    if (pb.detune) src.detune.value = pb.detune;

    const intoClip = fromPos - clip.start; // timeline seconds already elapsed
    const srcOffset = pb.offset + intoClip * pb.consume;
    const playSecs = untilPos - fromPos;

    const gainNode = ctx.createGain();
    scheduleClipEnvelope(gainNode.gain, clip, fromPos, untilPos, when);

    src.connect(gainNode).connect(this.trackInput(track.id));
    const maxSrc = Math.max(0, buffer.duration - srcOffset);
    src.start(when, clamp(srcOffset, 0, buffer.duration), Math.min(playSecs * pb.consume, maxSrc));
    src.stop(when + playSecs + 0.02);

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      try {
        src.disconnect();
        gainNode.disconnect();
      } catch {
        /* torn down */
      }
    };
  }

  scheduleClicks(p0, p1, ctxAt) {
    const beat = beatSeconds();
    const bar = beat * state.project.sigNum;
    let k = Math.ceil(p0 / beat - 1e-9);
    for (let t = k * beat; t < p1; t += beat, k++) {
      const isDown = Math.abs(t / bar - Math.round(t / bar)) < 1e-6;
      // The click skips every insert, so it waits for the mix it is counting.
      const when = ctxAt + (t - p0) + this.latency.total;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.value = isDown ? 1600 : 1000;
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(isDown ? 0.5 : 0.28, when + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.055);
      osc.connect(g).connect(this.master.gain);
      osc.start(when);
      osc.stop(when + 0.07);
    }
  }

  /* ── metering ──────────────────────────────────────────────────────── */

  readLevels() {
    if (!this.ctx) return this.levels;
    for (const [id, b] of this.tracks) {
      b.analyser.getFloatTimeDomainData(b.buf);
      const peak = peakOf(b.buf);
      // Inside the mix, floats above 1.0 aren't clipped yet — but a track over
      // 0 dBFS will clip as a fixed-point stem, and the master will clip on the
      // way out to the interface or into a 16/24-bit bounce.
      if (peak >= 1) this.clips.add(id);
      this.levels.set(id, { peak, peakR: 0 });
    }
    const m = this.master;
    m.analyserL.getFloatTimeDomainData(m.bufL);
    m.analyserR.getFloatTimeDomainData(m.bufR);
    const pl = peakOf(m.bufL);
    const pr = peakOf(m.bufR);
    if (pl >= 1 || pr >= 1) this.clips.add("master");
    this.levels.set("master", { peak: pl, peakR: pr });
    // Effects that model their own envelope (the gate) run off the UI clock.
    for (const b of this.tracks.values()) for (const fx of b.fxLive) fx.tick?.(1 / 60);
    for (const fx of m.fxLive) fx.tick?.(1 / 60);
    return this.levels;
  }

  /** Clear the clip latch for one id ("master" included), or all of them. */
  resetClips(id = null) {
    if (id == null) this.clips.clear();
    else this.clips.delete(id);
  }

  /* ── preview (pool auditioning) ────────────────────────────────────── */

  previewAsset(assetId, fromSec = 0) {
    this.ensure();
    this.stopPreview();
    const asset = assets.get(assetId);
    if (!asset?.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = asset.buffer;
    const g = this.ctx.createGain();
    g.gain.value = 0.9;
    src.connect(g).connect(this.master.input);
    src.start(0, clamp(fromSec, 0, asset.duration));
    this.preview = src;
    src.onended = () => {
      if (this.preview === src) this.preview = null;
    };
  }

  stopPreview() {
    if (!this.preview) return;
    try {
      this.preview.stop();
    } catch {
      /* already finished */
    }
    this.preview = null;
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function makeSegment(ctxStart, posStart, posEnd = Infinity) {
  return { ctxStart, ctxEnd: posEnd === Infinity ? Infinity : ctxStart + (posEnd - posStart), posStart, posEnd };
}

function projectEnd() {
  let end = 0;
  for (const c of state.project.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

function syncChainParams(defs, live) {
  if (!live?.length) return;
  const byId = new Map(live.map((f) => [f.id, f]));
  for (const def of defs ?? []) byId.get(def.id)?.update(def.params);
}

function peakOf(buf) {
  let peak = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

const FADE_STEPS = 33;

function fadeCurve(shape, from, to) {
  const curve = new Float32Array(FADE_STEPS);
  const down = to < from;
  for (let i = 0; i < FADE_STEPS; i++) {
    const t = i / (FADE_STEPS - 1);
    let w;
    if (shape === "linear") w = t;
    else if (shape === "exp") w = down ? 1 - (1 - t) * (1 - t) : t * t;
    // Equal power: sin on the way up, its cos complement on the way down, so a
    // butt-joined fade-out/fade-in pair holds a constant perceived level.
    else w = down ? 1 - Math.cos((t * Math.PI) / 2) : Math.sin((t * Math.PI) / 2);
    curve[i] = from + (to - from) * w;
  }
  return curve;
}

/**
 * Write the clip's gain envelope (clip gain + fades) into `param`, covering
 * only the part of the clip actually being played from `fromPos`.
 */
export function scheduleClipEnvelope(param, clip, fromPos, untilPos, when) {
  const base = dbToGain(clip.gainDb);
  const clipEnd = clip.start + clip.duration;
  const fadeInEnd = clip.start + Math.min(clip.fadeIn, clip.duration);
  const fadeOutStart = clipEnd - Math.min(clip.fadeOut, clip.duration);

  param.cancelScheduledValues(when);
  // Level at the moment playback starts, honouring a fade already in progress.
  let startLevel = base;
  if (fromPos < fadeInEnd && clip.fadeIn > 0) startLevel = base * ((fromPos - clip.start) / clip.fadeIn);
  else if (fromPos > fadeOutStart && clip.fadeOut > 0) startLevel = base * ((clipEnd - fromPos) / clip.fadeOut);
  param.setValueAtTime(Math.max(0, startLevel), when);

  if (clip.fadeIn > 0 && fromPos < fadeInEnd) {
    const dur = Math.min(fadeInEnd, untilPos) - fromPos;
    if (dur > 0.001) param.setValueCurveAtTime(fadeCurve(clip.fadeShape, startLevel, base), when, dur);
  }
  if (clip.fadeOut > 0 && untilPos > fadeOutStart) {
    const at = when + Math.max(0, fadeOutStart - fromPos);
    const dur = Math.min(untilPos, clipEnd) - Math.max(fadeOutStart, fromPos);
    if (dur > 0.001) {
      param.setValueAtTime(base, at);
      param.setValueCurveAtTime(fadeCurve(clip.fadeShape, base, 0), at, dur);
    }
  }
}

export const engine = new Engine();
