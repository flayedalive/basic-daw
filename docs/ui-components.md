# UI components

Every control in a plugin's editor is generated from its `params` block. There
is no per-plugin markup anywhere in the app — declare a parameter and you get a
widget, a live value readout, undo, and a reset gesture.

This page is the mapping from what you declare to what the user sees.

---

## How a widget is chosen

The inspector looks at four fields, in this order:

| If the parameter has… | You get | Example |
|---|---|---|
| `choices` | A dropdown | `{ "key": "mode", "label": "Mode", "choices": ["lowpass", "highpass"], "def": "lowpass" }` |
| `bool: true` | A checkbox | `{ "key": "cross", "label": "Ping-pong", "bool": true, "def": false }` |
| `asset: true` | A pool-file picker with a "Load…" button | `{ "key": "ir", "label": "Cab IR", "asset": true, "def": "" }` |
| none of them | A slider with a numeric readout | `{ "key": "freq", "label": "Cutoff", "min": 20, "max": 20000, "def": 1200, "unit": "Hz", "log": true }` |

Order matters: `choices` wins over `bool`. Parameters render top to bottom in
the order you declare them, so put the control someone reaches for first at the
top.

---

## Parameter fields

| Field | Applies to | Notes |
|---|---|---|
| `key` | all | The identifier used in `bind`, in `map` expressions, and as the key in the saved project. **Never change it after release** — a saved session stores parameters by key, and a rename silently resets that control to its default on load. Cannot be `x`. |
| `label` | all | What the user reads. Keep it short; the label column is narrow. Abbreviate like a hardware panel would — "Thresh", "Pre-dly", "HiMid F". |
| `def` | all | The default, and the value a double-click returns to. Required. |
| `min` / `max` | sliders | Required, and `min` must be below `max`. `def` must lie between them. |
| `unit` | sliders | Appended to the readout with a leading space: `"Hz"` shows as `1.2 kHz`-style `1200 Hz`. Omit for ratios and normalised 0–1 controls. |
| `log` | sliders | Logarithmic travel. Use it for anything measured in hertz, and for times spanning more than a decade. Requires `min > 0`. |
| `prec` | sliders | Decimal places in the readout. Without it, precision is chosen from magnitude (see below). |
| `choices` | dropdowns | A non-empty array of strings. `def` must be one of them. |
| `bool` | checkboxes | `def` must be `true` or `false`. |
| `asset` | file pickers | The value is the id of a file in the sample pool, or `""` for none; `def` must be `""`. The id is saved with the project and the audio with the pool, so it survives reload. JS tier only for now: `src/plugins/amp.js` reads the audio with `irBuffer(ctx, id)`, which resamples it to the context's rate (a bounce at another sample rate still matches). The pool lists such a file as in use. |
| `hint` | all | One line of prose rendered under the control. The only explanation a plugin author gets per-parameter — use it for the non-obvious ones, not for all of them. |

Anything else is reported as a warning at install time, so a misspelled field
does not silently do nothing.

---

## Slider behaviour

The slider is the workhorse. It is a range input with a value readout, and it
carries a few conventions worth knowing when you pick ranges:

- **Drag** to change. **Double-click** returns to `def`.
- The readout updates continuously while dragging, but only the *release*
  commits an undo entry — so dragging a filter sweep leaves one undo step, not
  four hundred.
- Travel is quantised to 1000 steps across the range. If you declare
  `min: 0, max: 20000` you get ~20 Hz per step at the top, which is fine; if you
  declare `min: 0, max: 1` you get 0.001 per step, also fine. Ranges wider than
  about six decades will feel coarse at the bottom — that is what `log` is for.

### Readout precision

With `prec`, the readout is `toFixed(prec)`. Without it, precision follows
magnitude:

| Value | Shown as |
|---|---|
| ≥ 100 | `1200` |
| ≥ 10 | `42.5` |
| < 10 | `0.35` |

So a time in seconds almost always wants `"prec": 3` (`0.006 s`, not `0.01 s`),
and a depth in seconds wants `"prec": 4`.

### Choosing a range

Ranges are a design decision, not a technical one — they are the whole feel of
the control. Some conventions from the built-ins:

- **Frequencies**: `log: true`, and clamp to the useful band rather than the
  audible one. A "Damp" control that only matters between 500 Hz and 18 kHz
  should say so; giving it 20–20000 wastes most of the travel.
- **dB gains**: linear, symmetric around 0 (`-18` to `18`), so "flat" sits at
  the centre. The slider draws bipolar controls filling from the middle.
- **Mix**: `0` to `1`, no unit.
- **Times**: `log: true` if the range spans more than a decade, with `prec`.

---

## What a plugin cannot add

A few things in the effect editor are not driven by `params`:

- **The EQ/filter response curve.** The inspector draws a live magnitude plot,
  but only for `core.eq` and `core.filter` — it is keyed on those ids. A plugin
  cannot supply its own visualiser today.
- **The graphic EQ slider bank** (`src/ui/geq.js`), mounted for `core.geq31` in
  place of its 31 slider rows, and as a read-only response curve above the
  rows of `json.geq10`. A custom view that edits parameters lists their keys as
  hidden in `renderFx` so they are not drawn twice.
- **The readout.** A `create` function can return `readout()` and the app uses
  it internally (gain reduction on the compressor and limiter), but there is no
  parameter field that surfaces an arbitrary readout in the editor.

They are all the same missing feature: a plugin-supplied custom panel. If you need
one now, it means writing a JS plugin *and* patching `renderFx` in
`src/ui/inspector.js`.

---

## The rest of the widget kit

`src/ui/controls.js` holds four widgets. Only the third is reachable from a
plugin manifest; the others are app chrome, listed here so you know they exist
if you are patching the UI itself.

| Widget | Used by | |
|---|---|---|
| `knob(opts)` | Mixer strips (pan) | Canvas knob. Drag vertically, Shift for fine, Alt-click or double-click to reset, wheel to nudge. Draws bipolar ranges filling from the centre. |
| `fader(opts)` | Mixer strips, track headers | dB fader with ticks at 0, -6, -12, -24, -48. `orient: "h"` for the horizontal form. Clicking off the thumb jumps there first. |
| `sliderRow(opts)` | **Plugin parameters**, clip inspector | Label + range + readout. This is what your `params` become. |
| `meterBar()` | Track headers | Peak meter with a decay. |

They share an interaction grammar worth following in anything new: drag to
change, Shift for fine, double-click to reset. The knob and fader additionally
take Alt-click as a reset and the wheel as a nudge; `sliderRow` does not.

---

## Worked example

A parameter set that uses most of the fields, from `plate.json`:

```json
"params": [
  { "key": "size",     "label": "Size",    "min": 0.3,  "max": 6,     "def": 1.8,   "unit": "s",  "prec": 2 },
  { "key": "decay",    "label": "Decay",   "min": 0.5,  "max": 8,     "def": 3,     "prec": 2 },
  { "key": "build",    "label": "Build",   "min": 20,   "max": 800,   "def": 220,
    "hint": "How fast the tail reaches full density. Low is soft and plate-like." },
  { "key": "predelay", "label": "Pre-dly", "min": 0,    "max": 0.2,   "def": 0.025, "unit": "s",  "prec": 3 },
  { "key": "damp",     "label": "Damp",    "min": 1000, "max": 18000, "def": 7000,  "unit": "Hz", "log": true },
  { "key": "mix",      "label": "Mix",     "min": 0,    "max": 1,     "def": 0.25 }
]
```

Six sliders. `size` and `predelay` are seconds so they carry `prec`; `damp` is a
frequency so it is `log`; `build` is the one parameter whose name does not
explain itself, so it is the only one with a `hint`; `mix` is a bare 0–1 with no
unit.

---

See [plugins.md](plugins.md) for the DSP side — how those parameters reach the
audio graph.
