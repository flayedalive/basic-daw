# Writing plugins

A plugin is an insert effect. It sits in a track's chain (or the master's),
takes audio in, and gives audio out. The mixer, the inspector, the live engine
and the offline bounce all speak to it through the same six-method contract.

There are two ways to write one.

| | **JSON** | **JS** |
|---|---|---|
| What it is | A manifest describing a graph of Web Audio nodes | A module with a `create(ctx, offline)` function |
| Runs code | No — the manifest is interpreted, never evaluated | Yes, with full access to the page |
| Install from | A file, a URL, or pasted text | A URL, after an explicit confirmation |
| Remembered between sessions | Yes | No |
| Can do | Anything a fixed graph of native nodes can do | Anything |

**Write JSON unless you can't.** It is safe to share, it is validated before it
ever reaches the audio graph, and the app can persist it. Reach for JS only when
you need per-frame logic (see [Limits](#limits)).

---

## The one rule

> The same `create` runs inside an `OfflineAudioContext` during bounce.

That is what makes an export match what you heard, and it is the only thing a
plugin may not break. In practice it means:

- **No module loading at build time.** `create` is synchronous. (A plugin that
  needs an AudioWorklet module declares it and the host loads it beforehand —
  see [Worklet plugins](#worklet-plugins).)
- **No state that only exists live.** The offline render builds a fresh
  instance from the same parameters and expects the same sound.
- **No `currentTime` assumptions.** Offline, `currentTime` is pinned at 0. The
  runtime already handles this for you: parameter writes are ramped live and
  instant offline.

JSON plugins get all of this for free.

---

## Quick start

The smallest useful plugin — a tremolo, three parameters, five nodes:

```json
{
  "id": "me.tremolo",
  "name": "Tremolo",
  "category": "Modulation",
  "description": "Amplitude modulation by an LFO.",
  "params": [
    { "key": "rate", "label": "Rate", "min": 0.1, "max": 20, "def": 4.5, "unit": "Hz", "log": true },
    { "key": "depth", "label": "Depth", "min": 0, "max": 1, "def": 0.6 },
    { "key": "shape", "label": "Shape", "choices": ["sine", "triangle", "square"], "def": "sine" }
  ],
  "graph": {
    "nodes": {
      "vca": { "type": "gain" },
      "lfo": { "type": "osc", "wave": "sine" },
      "amt": { "type": "gain" }
    },
    "connect": [
      ["in", "vca", "out"],
      ["lfo", "amt", "vca.gain"]
    ],
    "bind": [
      { "param": "rate", "to": "lfo.frequency" },
      { "param": "shape", "to": "lfo.wave" },
      { "param": "depth", "to": "amt.gain", "map": "x / 2" },
      { "param": "depth", "to": "vca.gain", "map": "1 - x / 2" }
    ]
  }
}
```

Paste it into **Project ▾ → Plugins… → Install pasted JSON** and it appears in
the "+ insert" menu under Modulation, with a full editor.

To install: a `.json` file, a URL, or pasted text. A file may hold one manifest
or an array of them (a "pack"); a pack installs atomically, so one bad manifest
installs nothing.

---

## Manifest reference

### Top level

| Field | Required | Notes |
|---|---|---|
| `id` | yes | Namespaced, like `me.tremolo`. Must contain a `.` or `-`. This is what a saved project stores, so **never change it** once you have used the plugin in a session. |
| `name` | yes | Display name, shown in menus and the inspector title. |
| `category` | no | Groups it in the "+ insert" menu. Known: `Dynamics`, `EQ / Filter`, `Modulation`, `Delay / Reverb`, `Distortion`, `Stereo`, `Utility`. Anything else sorts to the end. |
| `description` | no | One or two sentences, shown at the top of the editor. |
| `params` | yes | The controls. See [UI components](ui-components.md) for how each field becomes a widget. |
| `graph` | yes (JSON tier) | `nodes`, `connect`, and optionally `bind`. |

### `graph.nodes`

An object mapping a name to a node. Names are identifiers; **`in` and `out` are
reserved** and created for you as gain nodes — `in` is what the previous insert
feeds, `out` is what the next one receives.

```json
"nodes": {
  "lp":  { "type": "biquad", "filter": "lowpass" },
  "dly": { "type": "delay", "maxDelay": 2.5 }
}
```

| `type` | AudioParams (bindable, connectable) | Properties | Options | |
|---|---|---|---|---|
| `gain` | `gain` | — | — | Volume. The universal glue node. |
| `delay` | `delayTime` | — | `maxDelay` | Delay line. `maxDelay` (seconds, default 1) caps `delayTime` and cannot be changed later. |
| `biquad` | `frequency`, `Q`, `gain`, `detune` | `filter` | — | Filter. `filter` is one of `lowpass`, `highpass`, `bandpass`, `lowshelf`, `highshelf`, `peaking`, `notch`, `allpass`. |
| `osc` | `frequency`, `detune` | `wave` | `start` | Oscillator. `wave` is `sine`, `square`, `sawtooth` or `triangle`. Starts at time 0 unless `start: false`. |
| `constant` | `offset` | — | `start` | Constant signal, for offsetting a modulated AudioParam. |
| `shaper` | — | `oversample` | `curve` | Waveshaper. Output is clamped to [-1, 1]. `oversample` is `none`, `2x` or `4x`. |
| `convolver` | — | — | `ir`, `normalize` | Convolution. |
| `compressor` | `threshold`, `knee`, `ratio`, `attack`, `release` | — | — | Dynamics compressor. Its gain reduction becomes the plugin's readout automatically. |
| `panner` | `pan` | — | — | Stereo panner, -1 to 1. |
| `splitter` | — | — | `channels` | Channel splitter. Address outputs as `name[0]`, `name[1]`. |
| `merger` | — | — | `channels` | Channel merger. Address inputs as `name[0]`, `name[1]`. |
| `analyser` | — | — | `fftSize` | Tap that does not alter the signal. |

> **Why `filter` and not `type`?** A node's kind already occupies `type`, so
> `BiquadFilterNode.type` is spelled `filter` and `OscillatorNode.type` is
> spelled `wave`.

Every node also accepts `channelCount` (number), `channelCountMode`
(`max` | `clamped-max` | `explicit`) and `channelInterpretation`
(`speakers` | `discrete`). Forcing `channelCount: 2, channelCountMode: "explicit"`
on a node is how you make a mono source up-mix before a mid/side split, instead
of leaving one side silent.

### `graph.connect`

An array. Each entry is either a **chain** — an array of two or more endpoints,
wired left to right — or a **conditional edge**, an object with `from`, `to` and
`when`.

```json
"connect": [
  ["in", "dry", "out"],
  ["in", "lp", "wet", "out"],
  ["lfo", "amt", "lp.frequency"],
  { "from": "fbL", "to": "dR", "when": "cross" }
]
```

Endpoint syntax:

| Form | Means |
|---|---|
| `"gain1"` | The node's default input or output |
| `"split[1]"` | Output 1 as a source; input 1 as a destination |
| `"lp.frequency"` | An **AudioParam**. Only legal as a destination — this is how you modulate one node with another. |

Two things the validator will stop you on: an endpoint naming a node that does
not exist, and a graph where nothing reaches `out` (which would be silent).

### `graph.bind`

How a parameter reaches a node.

```json
"bind": [
  { "param": "freq", "to": "lp.frequency" },
  { "param": "mix",  "to": "wet.gain" },
  { "param": "mix",  "to": "dry.gain", "map": "1 - x" },
  { "param": "out",  "to": "out.gain", "map": "db2gain(x)" },
  { "to": "trim.gain", "map": "db2gain(out) * mix" }
]
```

| Field | Notes |
|---|---|
| `param` | The parameter key to read. Optional if you supply `map`. |
| `to` | `node.audioParam` or `node.property`. |
| `map` | An expression. `x` is the value of `param`; **every parameter is also in scope by name**. |
| `smooth` | `false` writes the value instantly instead of ramping over 20 ms. Default `true`. |

Binding to a *property* (`filter`, `wave`, `oversample`) takes the value as-is —
`map` is ignored, and the parameter should be a `choices` list whose options are
all legal for that property. The validator checks this.

You can bind the same parameter more than once. The wet/dry pair above is the
idiomatic use.

---

## Expressions

`map`, `when`, and every numeric field of a curve or IR recipe accept an
arithmetic expression instead of a number. Expressions are **parsed, never
evaluated** — there is no `eval` anywhere in the JSON tier, which is what makes
a manifest from a URL safe to install.

Operators: `+ - * / %` and `^` (right-associative), with parentheses.

Available names: every parameter key, plus `x` in a `map`, plus `t` and `noise`
in an IR expression. `pi`, `e`, `true` and `false` are constants; a boolean
parameter reads as `1` or `0`, which is what makes `"amount * swap"` work.

Functions:

```
min  max  abs  pow  exp  log  log2  log10  sqrt  sign  floor  ceil  round
sin  cos  tan  tanh  atan  clamp(v, lo, hi)  lerp(a, b, t)  step(edge, v)
db2gain  gain2db
```

An unknown name is a **load-time error**, not a silent `NaN` — a typo in a
manifest is reported with the offending name and the list of what was in scope.

> There is no unary minus problem, but `0 - x` reads more clearly than `-x` when
> the expression starts with it, and both work.

---

## Curve recipes

A `shaper` node needs a `curve`:

```json
"sh": { "type": "shaper", "oversample": "4x", "curve": { "kind": "tanh", "amount": "drive" } }
```

| `kind` | Fields | |
|---|---|---|
| `tanh` | `amount` | Symmetric soft saturation. `amount` ≥ 1; higher is dirtier. |
| `softclip` | `knee` | Linear below `knee` (0–1), tanh bend above. Bounded, so it is a true ceiling. |
| `hardclip` | `threshold` | Flat clip at ±`threshold`. |
| `bitcrush` | `bits` | Quantise to `bits` steps. Aliases hard — that is usually the point. |
| `fold` | `amount` | Wavefolder: reflects rather than clips. Very bright. |
| `table` | `points` | Linear interpolation through `[[x, y], …]`, x ascending in [-1, 1]. |
| `expr` | `expr` | Arbitrary shape. `x` runs -1 → 1; parameters are in scope. |

All take an optional `size` (default 2048). A curve is rebuilt only when its
inputs change, so a knob that does not feed it costs nothing — except for
`kind: "expr"`, which conservatively rebuilds on any parameter change.

**A curve must map 0 to 0.** An asymmetric shape such as `tanh(drive * x + bias)`
outputs a constant when the input is silent. Live, that offset settles through
whatever DC-blocking filter follows long before you press play; a bounce starts
from cold, so it opens with a click playback never had. Subtract the curve's own
value at zero, as `tube.json` and `fuzz.json` do, and follow an asymmetric
shaper with a high-pass around 20–60 Hz to remove the DC that appears while a
note sounds. `validate.mjs --build` warns when a curve breaks this.

Set `oversample` to `4x` for anything with gain before it. Leave it at `none`
when the aliasing *is* the effect, as in `bitcrusher.json`.

---

## Impulse-response recipes

A `convolver` node needs an `ir`:

```json
"conv": {
  "type": "convolver",
  "ir": { "kind": "expr", "seconds": "size", "expr": "noise * exp(0 - t * decay * 5) * (1 - exp(0 - t * build))" }
}
```

| `kind` | Fields | |
|---|---|---|
| `noise-decay` | `seconds`, `decay`, `damp` | Exponentially decaying filtered noise — a plain room. |
| `impulse` | — | A single unit sample. A no-op; useful as a wet/dry reference. |
| `expr` | `seconds`, `expr` | `t` runs 0 → 1 across the tail, `noise` is fresh white noise per sample. |

IRs are generated at the context's sample rate, so a 96 kHz bounce gets a 96 kHz
impulse rather than a resampled one.

---

## Rewiring: the `when` clause

Most parameters change a *value*. A few change the *shape* of the graph — a
ping-pong switch that crosses the feedback paths, say. Those need `when`:

```json
{ "from": "fbL", "to": "dL", "when": "1 - cross" },
{ "from": "fbR", "to": "dR", "when": "1 - cross" },
{ "from": "fbL", "to": "dR", "when": "cross" },
{ "from": "fbR", "to": "dL", "when": "cross" }
```

When `cross` changes, exactly the edges the plugin created are disconnected and
the active set is rewired — nothing the host connected to `in` or `out` is
touched. The engine also learns from the manifest that `cross` is a
shape-changing parameter, so its chain signature accounts for it.

Use `when` sparingly. A rewire is not click-free, and most switches are better
expressed as a map that multiplies a path to zero — see `haas.json`, where a
boolean chooses which channel is delayed with `"amount / 1000 * swap"` and no
rewiring at all.

---

## Limits

The JSON tier describes a **fixed graph of native nodes**. It cannot:

- **Run per-sample or per-frame logic.** An envelope follower needs to read a
  signal and act on it sample by sample. That takes an AudioWorklet, which is
  why the Noise Gate is a JS plugin with a processor module.
- **Read the signal at all.** Nothing in a manifest can branch on audio.
- **Allocate per-note or per-voice structures.** There is no note model.

If you need any of those, write a JS plugin.

---

## The JS tier

A module whose default export is a plugin spec — the same fields, with `create`
in place of `graph`:

```js
export default {
  id: "me.stutter",
  name: "Stutter",
  category: "Utility",
  params: [{ key: "amount", label: "Amount", min: 0, max: 1, def: 0.5 }],

  create(ctx, offline) {
    const input = ctx.createGain();
    const out = ctx.createGain();
    input.connect(out);
    return {
      input,
      output: out,
      update(p) { out.gain.setTargetAtTime(p.amount, ctx.currentTime, 0.01); },
      dispose() { /* stop anything you started */ },
    };
  },
};
```

`create(ctx, offline)` must return:

| Key | Required | |
|---|---|---|
| `input` | yes | The node the previous insert connects into. |
| `output` | yes | The node feeding the next insert. May be the same node. |
| `update(params)` | yes | Called on every parameter change. Must be cheap and click-free. |
| `dispose()` | no | Stop oscillators and constant sources here, or they leak. |
| `tick(dt)` | no | Called once per UI frame with seconds elapsed. Live playback only — an offline render never calls it, so anything essential to the sound must not live here. Measurement is the safe use: the Tuner detects pitch here because nothing it learns changes the audio. |
| `readout()` | no | Gain reduction in dB (0 or negative). Plugins in the Dynamics category get a reduction meter in their editor that reads this every frame. |

Declare `rebuildOn: ["someKey"]` if a parameter changes the graph's shape.

Two more fields on the spec itself are optional:

| Key | |
|---|---|
| `worklets` | `[{ name, url }]` — AudioWorklet modules the plugin's processors live in. See below. |
| `latency` | Seconds of delay the plugin adds: a number, or `(params, sampleRate) => seconds`. See [Latency](#latency). |

Load one with a `.js` URL in the plugin manager. It asks first, because unlike a
manifest this executes code. JS plugins are **not** persisted between sessions.

The built-ins in `src/plugins/builtin.js` are all JS plugins and are the best
reference; `src/plugins/amp.js` (amp sim, cabinet) is the one to read for a
larger graph and for a parameter that points at pool audio.

---

## Worklet plugins

Native nodes cannot read the signal. A plugin whose sound depends on doing so —
a gate, a look-ahead limiter, a pitch corrector — runs its DSP in an
`AudioWorkletProcessor`. Doing that work in `tick()` instead is the mistake to
avoid: `tick` runs on the UI clock and only live, so the bounce comes out
unprocessed. (The Noise Gate did exactly that until it was rewritten.)

A processor lives in a module that must be loaded into an audio context before
a node can be made from it. Loading is asynchronous and `create` is not allowed
to be, so **the host does the loading**:

```js
import { workletNode } from "./worklets.js";

export const myPlugin = {
  id: "me.follower",
  name: "Follower",
  params: [{ key: "amount", label: "Amount", min: 0, max: 1, def: 0.5 }],
  // The processor module, next to this file. `code: "…source…"` works in place of `url`.
  worklets: [{ name: "me-follower", url: new URL("./worklets/follower.js", import.meta.url).href }],

  create(ctx, offline) {
    const node = workletNode(ctx, "me-follower"); // stereo in, stereo out, channel count pinned
    return {
      input: node,
      output: node,
      update(p) { setAudioParam(ctx, node.parameters.get("amount"), p.amount, offline); },
    };
  },
};
```

- The engine loads every registered module when the audio context is created,
  and again when a plugin is installed. A chain built before its modules have
  arrived holds a **passthrough** in the plugin's place; the engine rebuilds
  the chain as soon as they are in.
- The bounce awaits the same modules for its `OfflineAudioContext` before it
  builds anything, so a bounce never renders a passthrough.
- No bundler: a module is a plain file under `src/`, addressed with
  `new URL(…, import.meta.url)`, or source text handed over as `code`.

### Parity rules for a processor

A worklet plugin keeps "bounce matches playback" only if its processor is a
pure function of its input and its parameters:

1. **Settings travel as AudioParams** (`static get parameterDescriptors()`), or
   as `processorOptions` for things fixed at construction. Never as port
   messages: a message arrives when the main thread gets round to sending it,
   not at a point on the render clock, so live and offline would apply it at
   different samples — and offline, quite possibly after the render is over.
2. **`port` is for metering only** — the processor telling the UI something
   (gain reduction, a level). Nothing the processor hears back may change the
   audio.
3. **No unseeded randomness and no wall-clock time.** `Math.random()` and
   `Date.now()` differ between two renders. Seed a generator from
   `processorOptions` if you need noise.
4. **State starts from zero** in the constructor and depends only on the
   samples processed since. Do not carry anything in from module scope.
5. **Return `true` from `process`.** A processor that returns `false` once its
   input goes quiet is torn down live but not offline.

`src/plugins/worklets/gate.js` is the reference: every setting a k-rate
AudioParam, look-ahead as a delay line, the port used once per ~40 ms to report
how open the gate is.

A processor that keeps a clock of its own — a detector that runs every 5 ms, a
grain laid every period — has one more thing to get right: that clock must
start from the signal, not from when the node was made. Live, a chain is built
whenever the user touches it and the audio arrives at some later sample; in a
bounce it arrives at another. `worklets/autotune.js` goes idle after a ring's
worth of silence and starts its clocks on the first sample that is not, and
counts in samples rather than 128-frame blocks — so the same audio gives the
same output wherever it falls. (The host's priming signal, 400 dB down, has to
count as silence for this.)

### Latency

A plugin that looks ahead delays the signal. Say by how much and the host
compensates:

```js
latency: (p, sampleRate) => p.lookahead / 1000,   // or a plain number: latency: 0.006
```

- Each track is delayed by the difference between the slowest track's insert
  latency and its own, so all tracks reach the master together. (Routing is
  tracks → master only, which is what keeps this to one delay per track.)
- What remains — the slowest track plus the master chain — delays everything
  alike. The engine takes it off the playhead, adds it to the metronome and to
  the shift applied to recorded takes; the bounce renders that much extra and
  cuts it from the head, so a bounced file starts where the timeline does.
- A bypassed insert reports nothing. Input monitoring does hear the delay —
  there is no way to compensate something that has not been played yet.

Auto-Tune's delay is fixed: 32 ms, the room its shifter needs to cut a grain
around a point it has not played yet.

The native `DynamicsCompressorNode` has 6 ms of look-ahead built in; the
Compressor, Limiter and Multiband Compressor report it.

---

## Validating

The validator runs at install and lists every problem at once. To check a
manifest before installing it:

```sh
node .claude/skills/daw-plugin/validate.mjs my-plugin.json
```

It uses exactly the rules the app applies — `src/plugins/schema.js` is shared,
and touches neither the DOM nor Web Audio for this reason.

Add `--build` to instantiate the plugin against a mock audio context and sweep
every parameter to its extremes. JS plugins can be checked the same way, by
module path:

```sh
node .claude/skills/daw-plugin/validate.mjs src/plugins/dynamics.js --build
```

For a worklet plugin this loads the real processor module and runs it over
noise at each setting, so a processor that throws or produces `NaN` at the edge
of a range fails here rather than in someone's session.

## Where things live

```
src/plugins/
  registry.js      register / look up / categories / legacy id aliases
  schema.js        the node vocabulary, and the validator built from it
  graph.js         manifest → live audio graph
  expr.js          the expression compiler (no eval)
  dsp.js           curves and impulse responses, shared by both tiers
  builtin.js       the JS effects that ship with the app (the tuner's code is in tuner.js / pitch.js)
  amp.js           amp sim and speaker cabinet, with user impulse responses
  worklets.js      loads plugins' AudioWorklet modules into each context
  dynamics.js      the worklet plugins' faces (gate, …)
  worklets/        their processors, one self-contained module each
  loader.js        install from file / URL / text, persist to IndexedDB
  bundled/         the JSON plugins that ship with the app
```
