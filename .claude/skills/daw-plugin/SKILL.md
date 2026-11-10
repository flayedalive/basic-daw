---
name: daw-plugin
description: Design, write and validate an insert-effect plugin for this DAW — a JSON manifest describing a Web Audio graph, or a JS plugin when JSON cannot express it. Use when asked to add an effect, build a plugin, port an effect to this app, or extend the insert chain.
argument-hint: "The effect to build, e.g. 'a phaser' or 'port the tape delay from X'"
---

# Writing a plugin for this DAW

An insert effect. Audio in, audio out, parameters that drive it. Your job is to
produce a **manifest that validates, builds, and sounds like the thing that was
asked for** — not a sketch of one.

## Read these first

They are the spec, and they are short:

- `docs/plugins.md` — the manifest format, node vocabulary, expressions, curve
  and IR recipes, and the offline-parity rule.
- `docs/ui-components.md` — how each `params` field becomes a control, and how
  to pick ranges that feel right.

Then read the bundled manifest closest to what you are building. They are in
`src/plugins/bundled/` and each one is a worked example of a different feature:

| File | Shows |
|---|---|
| `tremolo.json` | The minimum: an LFO into a gain. Property binding (`wave`). |
| `tilt.json` | `map` expressions, including negation and `db2gain`. |
| `autowah.json` | Modulating a filter's AudioParam; a choice bound to `filter`. |
| `bitcrusher.json` | A curve recipe driven by a parameter. |
| `tube.json` | A `kind: "expr"` curve — arbitrary transfer functions. |
| `wavefolder.json` | `constant` node offsetting a signal; the `fold` curve. |
| `plate.json` | A generated impulse response via `kind: "expr"`. |
| `haas.json` | `splitter`/`merger` with channel indices; a bool inside a map. |
| `pingpong.json` | `when` clauses that rewire the graph. |

## Decide the tier before you write anything

**JSON unless you genuinely cannot.** It is safe to install, validated before it
reaches the audio graph, and persisted between sessions.

Write **JS** only if the effect needs to *read the signal and react to it* — an
envelope follower, a gate, a ducker, a limiter. That means an AudioWorklet
processor (docs/plugins.md, "Worklet plugins"; `src/plugins/dynamics.js` and
`src/plugins/worklets/gate.js` are the worked example) — not `tick(dt)`, which
only runs live and so leaves a bounce unprocessed. If you are reaching for JS
for any other reason, re-read the node vocabulary; the answer is usually a
`constant` node, a second gain, or a `map` expression.

State the tier and the reason in one line before writing.

## The rule you cannot break

The same graph is built inside an `OfflineAudioContext` during bounce. A bounce
must equal what was heard. JSON plugins get this for free; a JS plugin must not
put anything essential to the sound in `tick`, because an offline render never
calls it, and a worklet processor must take its settings as AudioParams, never
as port messages (the five parity rules are in docs/plugins.md).

## Method

1. **Name the signal path in prose first.** "Input splits to dry and wet; wet
   goes through a lowpass whose cutoff is modulated by a sine LFO; both sum at
   out." If you cannot write that sentence, you do not yet know the graph.
2. **Choose parameters like a hardware designer.** Every parameter is a control
   someone will reach for mid-take. Pick the four to six that matter. Ranges are
   the feel of the plugin — read the "Choosing a range" section of
   `docs/ui-components.md` and follow it: `log` for anything in hertz, `prec`
   for anything in seconds, symmetric ranges for dB, bare 0–1 for mix.
3. **Write the graph.** Reserved names `in` and `out` already exist as gains.
4. **Wire the wet/dry pair.** Almost every effect wants
   `{"param": "mix", "to": "wet.gain"}` plus
   `{"param": "mix", "to": "dry.gain", "map": "1 - x"}`. Omit it only for
   effects that are always fully wet (an EQ, a trim).
5. **Validate.** Non-negotiable — see below.
6. **Say how to audition it**, and what to listen for.

## Validate before you claim it works

```sh
node .claude/skills/daw-plugin/validate.mjs path/to/plugin.json
```

This runs the app's own `src/plugins/schema.js`, so it is the same check the
installer applies. It reports every problem at once, with the offending name and
what was in scope.

`--build` additionally instantiates the graph against a mock AudioContext and
sweeps every parameter across its range, which catches the errors validation
cannot see — a curve that never gets generated, a `when` clause that leaves a
stale edge, a bad channel index:

```sh
node .claude/skills/daw-plugin/validate.mjs path/to/plugin.json --build
```

**Run `--build` on every plugin you write.** A manifest that validates can still
fail to build.

JS plugins validate the same way, by module path — and for a worklet plugin
`--build` loads the real processor and runs it over noise at every parameter
extreme:

```sh
node .claude/skills/daw-plugin/validate.mjs src/plugins/dynamics.js --build
```

## Installing it

Either paste it into **Project ▾ → Plugins… → Install pasted JSON**, or, to ship
it with the app, drop the file in `src/plugins/bundled/` and add its name to the
`FILES` array in `src/plugins/bundled/index.js`.

From the console: `daw.plugins.installManifest(jsonText, { replace: true })`.

## Pitfalls

- **`id` is permanent.** A saved project stores the effect by id, and a rename
  turns every existing insert into a "missing plugin" placeholder. Same for a
  parameter `key` — renaming one silently resets that control to its default on
  load. Get both right the first time.
- **A node's kind occupies `type`.** BiquadFilter's own `type` is spelled
  `filter`; Oscillator's is spelled `wave`.
- **Oscillators and constant sources need starting**, which happens by default,
  and stopping, which the runtime handles for JSON. In a JS plugin you must
  `stop()` them in `dispose()` or they leak.
- **`oversample: "4x"`** on any shaper with gain in front of it, unless the
  aliasing is the point.
- **Reaching `out`.** A graph where nothing connects to `out` is silent; the
  validator catches it, but it usually means a mis-typed node name.
- **Prefer a map over a rewire.** `"amount * enabled"` with a bool parameter is
  click-free; a `when` clause is not. Use `when` only when the topology really
  must change.
- **Booleans read as `1` and `0`** inside expressions. That is what makes
  `"amount / 1000 * swap"` work.

## Reporting back

Give the user: the tier and why, the signal path in one sentence, the parameter
list with ranges, the validator output, and how to audition it. If you made a
judgement call on a range or a default, say so — those are the decisions they
will want to change.
