// A mock AudioContext, enough of one to build a plugin graph and prove it wires
// up. Node has no Web Audio, and the point of `--build` is to catch the errors
// that static validation cannot see, so the mock is strict where it counts:
// `disconnect` throws if asked to remove a connection that was never made,
// which is how a stale edge left behind by a `when` clause gets caught.

import { pathToFileURL } from "node:url";

class Param {
  constructor(v = 0) {
    this.value = v;
  }
  setValueAtTime(v) {
    if (!Number.isFinite(v)) throw new Error(`non-finite value written to an AudioParam: ${v}`);
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v) {
    return this.setValueAtTime(v);
  }
  setTargetAtTime(v) {
    return this.setValueAtTime(v);
  }
  cancelScheduledValues() {
    return this;
  }
}

class Node {
  constructor(kind) {
    this.kind = kind;
    this.edges = [];
  }
  connect(dst, o = 0, i = 0) {
    this.edges.push({ dst, o, i });
    return dst;
  }
  disconnect(dst, o, i) {
    if (dst === undefined) {
      this.edges.length = 0;
      return;
    }
    const before = this.edges.length;
    this.edges = this.edges.filter((e) => !(e.dst === dst && (o === undefined || e.o === o) && (i === undefined || e.i === i)));
    if (before === this.edges.length) throw new Error(`disconnect() on a connection that was never made (${this.kind})`);
  }
}

/* ── AudioWorklet ─────────────────────────────────────────────────────── */

// Node has no AudioWorkletGlobalScope, so this file is one: processor modules
// are imported with `registerProcessor`, `AudioWorkletProcessor` and
// `sampleRate` defined as globals, and the classes they register are kept
// here. That is enough to build a worklet plugin against the mock context AND
// to run its real DSP over real blocks of samples — which is how `--build`
// (and the Node tests) catch a processor that throws or emits NaN at an
// extreme parameter value.

const processors = new Map(); // name -> class

function installWorkletGlobals(sampleRate) {
  globalThis.sampleRate = sampleRate;
  globalThis.currentFrame = 0;
  globalThis.currentTime = 0;
  globalThis.AudioWorkletProcessor ??= class AudioWorkletProcessor {
    constructor() {
      this.port = { postMessage: (m) => this.port.onposted?.(m), onmessage: null };
    }
  };
  globalThis.registerProcessor ??= (name, cls) => processors.set(name, cls);
}

/** Import a processor module (a file path or file: URL), registering what it defines. */
export async function loadWorkletModule(url, sampleRate = 48000) {
  installWorkletGlobals(sampleRate);
  await import(String(url).startsWith("file:") ? url : pathToFileURL(String(url)).href);
}

export const processorClass = (name) => processors.get(name);

/**
 * Run a registered processor over `input` ([L, R] Float32Arrays) in 128-frame
 * blocks, as the audio thread would, and return its output channels.
 * `params` are plain numbers, or functions of the block's start frame for
 * automation. opts: { sampleRate, options (the node's processorOptions) }.
 */
export function runProcessor(name, input, params = {}, { sampleRate = 48000, options = {}, onMessage } = {}) {
  const Cls = processors.get(name);
  if (!Cls) throw new Error(`no processor "${name}" has been registered`);
  installWorkletGlobals(sampleRate);
  const proc = new Cls({ processorOptions: options, numberOfInputs: 1, numberOfOutputs: 1 });
  if (onMessage) proc.port.onposted = onMessage;
  const descriptors = Cls.parameterDescriptors ?? [];
  const n = input[0].length;
  const out = [new Float32Array(n), new Float32Array(n)];
  for (let at = 0; at < n; at += 128) {
    const len = Math.min(128, n - at);
    globalThis.currentFrame = at;
    globalThis.currentTime = at / sampleRate;
    const values = {};
    for (const d of descriptors) {
      const v = params[d.name];
      values[d.name] = Float32Array.of(typeof v === "function" ? v(at) : (v ?? d.defaultValue));
    }
    const blockIn = [input[0].subarray(at, at + len), (input[1] ?? input[0]).subarray(at, at + len)];
    const blockOut = [out[0].subarray(at, at + len), out[1].subarray(at, at + len)];
    proc.process([blockIn], [blockOut], values);
  }
  return out;
}

class MockWorkletNode extends Node {
  constructor(ctx, name, options = {}) {
    super(`worklet:${name}`);
    const Cls = processors.get(name);
    if (!Cls) throw new Error(`AudioWorkletNode: processor "${name}" is not registered in this context — is its module in the plugin's "worklets" list?`);
    this.name = name;
    this.options = options;
    this.parameters = new Map((Cls.parameterDescriptors ?? []).map((d) => [d.name, new Param(d.defaultValue ?? 0)]));
    this.port = { postMessage() {}, onmessage: null };
    ctx.workletNodes.push(this);
  }
  /** Push noise through the real processor at this node's current parameter values. */
  exercise(sampleRate) {
    const n = 1024;
    let seed = 1;
    const noise = () => Float32Array.from({ length: n }, () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 1.5);
    const params = Object.fromEntries([...this.parameters].map(([k, p]) => [k, p.value]));
    const out = runProcessor(this.name, [noise(), noise()], params, { sampleRate, options: this.options.processorOptions });
    for (const ch of out) for (const v of ch) if (!Number.isFinite(v)) throw new Error(`processor "${this.name}" produced a non-finite sample with ${JSON.stringify(params)}`);
  }
}

export class MockAudioContext {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.destination = new Node("destination");
    this.workletNodes = [];
    this.audioWorklet = { addModule: (url) => loadWorkletModule(url, sampleRate) };
  }
  #n(kind, extra = {}) {
    return Object.assign(new Node(kind), extra);
  }
  createGain() {
    return this.#n("gain", { gain: new Param(1) });
  }
  createDelay(max) {
    return this.#n("delay", { delayTime: new Param(0), maxDelayTime: max });
  }
  createBiquadFilter() {
    return this.#n("biquad", {
      type: "lowpass",
      frequency: new Param(350),
      Q: new Param(1),
      gain: new Param(0),
      detune: new Param(0),
    });
  }
  createOscillator() {
    const n = this.#n("osc", { type: "sine", frequency: new Param(440), detune: new Param(0) });
    n.start = () => (n.started = true);
    n.stop = () => (n.stopped = true);
    return n;
  }
  createConstantSource() {
    const n = this.#n("constant", { offset: new Param(1) });
    n.start = () => (n.started = true);
    n.stop = () => (n.stopped = true);
    return n;
  }
  createWaveShaper() {
    return this.#n("shaper", { curve: null, oversample: "none" });
  }
  createConvolver() {
    return this.#n("convolver", { buffer: null, normalize: true });
  }
  createDynamicsCompressor() {
    return this.#n("compressor", {
      threshold: new Param(-24),
      knee: new Param(30),
      ratio: new Param(12),
      attack: new Param(0.003),
      release: new Param(0.25),
      reduction: 0,
    });
  }
  createStereoPanner() {
    return this.#n("panner", { pan: new Param(0) });
  }
  createChannelSplitter(channels = 2) {
    return this.#n("splitter", { channels });
  }
  createChannelMerger(channels = 2) {
    return this.#n("merger", { channels });
  }
  createAnalyser() {
    return this.#n("analyser", { fftSize: 2048, getFloatTimeDomainData() {} });
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      getChannelData: (i) => data[i],
    };
  }
}

/** The app's util.js registers DOM listeners at import time; satisfy them. */
export function installDomStubs() {
  globalThis.AudioWorkletNode ??= MockWorkletNode;
  globalThis.addEventListener ??= () => {};
  globalThis.removeEventListener ??= () => {};
  globalThis.document ??= {
    querySelector: () => null,
    createElement: () => ({
      style: {},
      dataset: {},
      classList: { add() {}, toggle() {} },
      append() {},
      addEventListener() {},
      setAttribute() {},
    }),
    createTextNode: () => ({ nodeType: 3 }),
  };
}
