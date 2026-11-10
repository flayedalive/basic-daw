// The pitch editor: a clip's notes on a piano-roll grid, to be dragged into tune.
//
// Opened from a clip ("Edit pitch…"). The clip's original audio is analysed
// into a pitch track and notes; each note is drawn as a blob at the pitch it
// will be corrected to, with the pitch as sung (grey) and as corrected (blue)
// drawn through it. Nothing is rendered until Apply — the curves are the
// correction model's own prediction, which is what the render then follows.
//
//   click            select a note (Shift or Ctrl adds)
//   drag             move the selected notes to another pitch (Alt: by cents)
//   double-click     send a note back to the key and scale
//   S                split the note under the pointer there
//   J                join the selected note to the one before it
//   Ctrl+Z           undo within the editor
//   Space            audition the corrected clip
//
// Apply is one undo step in the project, like any other edit.

import { el, clamp, dialog, toast } from "../util.js";
import { pushUndo, changed, clipSourceRate } from "../state.js";
import { engine } from "../audio/engine.js";
import { analyzeAsset, applyPitchEdit, revertPitchEdit, renderCorrected, sourceAssetOf, editOf, notesOf } from "../audio/pitchedit.js";
import { correctedCurve, noteSettings, KEYS, SCALES, DEFAULT_EDIT } from "../audio/pitchcorrect.js";

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const noteName = (m) => `${NAMES[((Math.round(m) % 12) + 12) % 12]}${Math.floor(Math.round(m) / 12) - 1}`;
const GUTTER = 38; // px, note names down the left

const SLIDERS = [
  { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, hint: "How much of each note's error is removed" },
  { key: "speed", label: "Speed", min: 0, max: 400, step: 5, fmt: (v) => `${v} ms`, hint: "Time for the correction to take hold from a note's start. 0 is instant, and robotic." },
  { key: "variance", label: "Variance", min: 0, max: 50, step: 1, fmt: (v) => `±${v} ct`, hint: "Cents either side of the target that count as in tune and are left alone" },
  { key: "vibrato", label: "Vibrato", min: 0, max: 1, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%`, hint: "How much of the note's vibrato to keep" },
  { key: "transition", label: "Transition", min: 0, max: 300, step: 5, fmt: (v) => `${v} ms`, hint: "Time over which the correction changes between two notes that touch" },
];

/** Open the editor on `clip`. Resolves when it closes. */
export async function openPitchEditor(clip) {
  const source = sourceAssetOf(clip);
  if (!source?.buffer) return toast("This clip's original audio is not in the pool", "err");

  let edit = editOf(clip);
  let notes = [];
  let curve = null;
  const history = [];
  const selected = new Set();
  let hoverTime = 0;
  let audition = null;
  let closed = false;
  let applying = false;

  // The part of the source this clip plays, in source seconds.
  const span = clip.duration * clipSourceRate(clip);
  const region = clip.reverse ? [source.duration - clip.offset - span, source.duration - clip.offset] : [clip.offset, clip.offset + span];
  const view = { t0: Math.max(0, region[0] - 0.1), t1: Math.min(source.duration, region[1] + 0.1), m0: 48, m1: 72 };

  const canvas = el("canvas.pe-canvas", { tabIndex: 0 });
  const status = el("div.pe-status", null, "Analysing…");
  const info = el("div.pe-info");
  const globals = el("div.pe-controls");
  const selection = el("div.pe-controls.pe-sel");

  const recompute = () => {
    notes = notesOf(source, edit);
    for (const id of [...selected]) if (!notes.some((n) => n.id === id)) selected.delete(id);
    curve = correctedCurve(source.pitchTrack, notes, edit);
    paint();
    describe();
  };
  const remember = () => {
    history.push(JSON.stringify(edit));
    if (history.length > 100) history.shift();
  };
  const undo = () => {
    if (!history.length) return;
    edit = JSON.parse(history.pop());
    buildControls();
    recompute();
  };
  const own = (id) => ((edit.notes[id] ??= {}), edit.notes[id]);

  /* ── controls ───────────────────────────────────────────────────────── */

  function slider(spec, value, mixed, onInput) {
    const val = el("span.val", null, mixed ? "mixed" : spec.fmt(value));
    const input = el("input", {
      type: "range",
      min: spec.min,
      max: spec.max,
      step: spec.step,
      value,
      title: spec.hint,
      onpointerdown: remember,
      oninput: (e) => {
        const v = Number(e.target.value);
        val.textContent = spec.fmt(v);
        onInput(v);
        recompute();
      },
    });
    return el("label.pe-slider", { title: spec.hint }, el("span", null, spec.label), input, val);
  }

  function buildControls() {
    const pick = (options, value, onChange) => {
      const s = el("select.select", {
        onchange: (e) => {
          remember();
          onChange(e.target.value);
          recompute();
        },
      });
      options.forEach(([v, l]) => s.append(el("option", { value: v, selected: String(v) === String(value) }, l)));
      return s;
    };
    globals.replaceChildren(
      el("label.pe-slider", null, el("span", null, "Key"), pick(KEYS.map((k, i) => [i, k]), edit.key, (v) => (edit.key = Number(v))), pick(Object.keys(SCALES).map((s) => [s, s]), edit.scale, (v) => (edit.scale = v))),
      ...SLIDERS.map((spec) => slider(spec, edit[spec.key] ?? DEFAULT_EDIT[spec.key], false, (v) => (edit[spec.key] = v))),
    );
    buildSelection();
  }

  function buildSelection() {
    const sel = notes.filter((n) => selected.has(n.id));
    if (!sel.length) {
      selection.replaceChildren(el("span.pe-hint", null, "Select notes to set them apart from the rest. Drag a note to retune it; double-click to send it back to the scale."));
      return;
    }
    selection.replaceChildren(
      el("span.pe-hint", null, sel.length === 1 ? "This note:" : `${sel.length} notes:`),
      ...SLIDERS.map((spec) => {
        const values = sel.map((n) => noteSettings(n, edit)[spec.key]);
        const mixed = values.some((v) => v !== values[0]);
        return slider(spec, values[0], mixed, (v) => sel.forEach((n) => (own(n.id)[spec.key] = v)));
      }),
      el("button.btn", {
        textContent: "Reset",
        title: "Drop these notes' own settings and targets",
        onclick: () => {
          remember();
          sel.forEach((n) => delete edit.notes[n.id]);
          buildSelection();
          recompute();
        },
      }),
    );
  }

  function describe() {
    const sel = notes.filter((n) => selected.has(n.id));
    if (sel.length !== 1) {
      info.textContent = `${notes.length} notes · ${KEYS[edit.key]} ${edit.scale}`;
      return;
    }
    const n = sel[0];
    const s = noteSettings(n, edit);
    const off = Math.round((n.center - s.target) * 100);
    info.textContent = `${noteName(s.target)} · sung ${off >= 0 ? "+" : ""}${off} ct · drift ${Math.round(n.drift)} ct${n.vibrato.rate ? ` · vibrato ±${Math.round(n.vibrato.depth)} ct at ${n.vibrato.rate.toFixed(1)} Hz` : ""}`;
  }

  /* ── drawing ────────────────────────────────────────────────────────── */

  const size = () => ({ w: canvas.clientWidth || 800, h: canvas.clientHeight || 360 });
  const xOf = (t, w) => GUTTER + ((t - view.t0) / (view.t1 - view.t0)) * (w - GUTTER);
  const tOf = (x, w) => view.t0 + ((x - GUTTER) / (w - GUTTER)) * (view.t1 - view.t0);
  const yOf = (m, h) => h - ((m - view.m0) / (view.m1 - view.m0)) * h;
  const mOf = (y, h) => view.m0 + ((h - y) / h) * (view.m1 - view.m0);

  function paint() {
    if (!canvas.isConnected) return;
    const { w, h } = size();
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#0d0f14";
    c.fillRect(0, 0, w, h);
    const row = h / (view.m1 - view.m0);
    const steps = SCALES[edit.scale] ?? SCALES.chromatic;

    // Rows: notes of the scale lighter, the rest dark; names in the gutter.
    c.font = "10px ui-monospace, monospace";
    c.textBaseline = "middle";
    for (let m = Math.floor(view.m0); m <= Math.ceil(view.m1); m++) {
      const inScale = steps.includes((((m - edit.key) % 12) + 12) % 12);
      const y = yOf(m + 0.5, h);
      c.fillStyle = inScale ? "#151923" : "#0f1218";
      c.fillRect(GUTTER, y, w - GUTTER, row - 1);
      if (row >= 9 || m % 12 === 0) {
        c.fillStyle = inScale ? "#8a90a4" : "#4a5064";
        c.fillText(noteName(m), 4, yOf(m, h));
      }
    }
    // The clip's own extent: the rest of the source is dimmed.
    c.fillStyle = "rgba(0,0,0,0.45)";
    c.fillRect(GUTTER, 0, Math.max(0, xOf(region[0], w) - GUTTER), h);
    c.fillRect(xOf(region[1], w), 0, w, h);

    if (!curve) return;
    const track = source.pitchTrack;
    const f0 = Math.max(0, Math.floor(view.t0 / track.hop));
    const f1 = Math.min(track.frames - 1, Math.ceil(view.t1 / track.hop));

    // Notes.
    for (const n of notes) {
      if (n.endSec < view.t0 || n.startSec > view.t1) continue;
      const s = noteSettings(n, edit);
      const x0 = xOf(n.startSec, w);
      const x1 = xOf(n.endSec, w);
      const on = selected.has(n.id);
      // Where it was sung, as a ghost, when it has been moved off it.
      if (Math.abs(s.target - n.center) > 0.02) {
        c.strokeStyle = "#3a4158";
        c.strokeRect(x0 + 0.5, yOf(n.center + 0.4, h), Math.max(2, x1 - x0 - 1), row * 0.8);
      }
      c.fillStyle = on ? "rgba(92,200,255,0.42)" : s.manual ? "rgba(224,161,60,0.3)" : "rgba(92,200,255,0.2)";
      c.strokeStyle = on ? "#5cc8ff" : s.manual ? "#e0a13c" : "#3d6f8f";
      c.beginPath();
      c.roundRect(x0 + 0.5, yOf(s.target + 0.4, h), Math.max(2, x1 - x0 - 1), row * 0.8, Math.min(6, row * 0.4));
      c.fill();
      c.stroke();
    }

    // Curves: as sung, then as corrected.
    const line = (data, colour, width) => {
      c.strokeStyle = colour;
      c.lineWidth = width;
      c.beginPath();
      let pen = false;
      for (let f = f0; f <= f1; f++) {
        const m = data[f];
        if (Number.isNaN(m)) {
          pen = false;
          continue;
        }
        const x = xOf(f * track.hop, w);
        const y = yOf(m, h);
        pen ? c.lineTo(x, y) : c.moveTo(x, y);
        pen = true;
      }
      c.stroke();
    };
    c.save();
    c.beginPath();
    c.rect(GUTTER, 0, w - GUTTER, h);
    c.clip();
    line(track.midi, "#6b7288", 1);
    line(curve.midi, "#5cc8ff", 1.5);
    c.restore();
  }

  function fitView() {
    const track = source.pitchTrack;
    let lo = Infinity;
    let hi = -Infinity;
    for (let f = Math.floor(region[0] / track.hop); f <= Math.min(track.frames - 1, Math.ceil(region[1] / track.hop)); f++) {
      const m = track.midi[f];
      if (!Number.isNaN(m)) (lo = Math.min(lo, m)), (hi = Math.max(hi, m));
    }
    if (lo === Infinity) (lo = 55), (hi = 67);
    view.m0 = Math.floor(lo) - 3.5;
    view.m1 = Math.max(view.m0 + 12, Math.ceil(hi) + 3.5);
  }

  /* ── pointer and keys ───────────────────────────────────────────────── */

  const noteAt = (x, y) => {
    const { w, h } = size();
    const t = tOf(x, w);
    const m = mOf(y, h);
    return notes.find((n) => t >= n.startSec && t <= n.endSec && Math.abs(noteSettings(n, edit).target - m) <= 0.55);
  };
  const local = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.focus();
    const { x, y } = local(e);
    const hit = noteAt(x, y);
    if (!hit) {
      if (!e.shiftKey) selected.clear();
    } else if (e.shiftKey || e.ctrlKey || e.metaKey) {
      selected.has(hit.id) ? selected.delete(hit.id) : selected.add(hit.id);
    } else if (!selected.has(hit.id)) {
      selected.clear();
      selected.add(hit.id);
    }
    if (hit && selected.has(hit.id)) {
      canvas.setPointerCapture(e.pointerId);
      drag = { y, moved: false, start: new Map(notes.filter((n) => selected.has(n.id)).map((n) => [n.id, noteSettings(n, edit).target])) };
    }
    buildSelection();
    paint();
    describe();
  });
  canvas.addEventListener("pointermove", (e) => {
    const { x, y } = local(e);
    hoverTime = tOf(x, size().w);
    if (!drag) return;
    const { h } = size();
    const delta = ((drag.y - y) / h) * (view.m1 - view.m0);
    if (!drag.moved && Math.abs(drag.y - y) < 3) return;
    if (!drag.moved) remember();
    drag.moved = true;
    for (const [id, from] of drag.start) own(id).target = e.altKey ? Math.round((from + delta) * 100) / 100 : Math.round(from + delta);
    recompute();
  });
  const endDrag = () => {
    if (drag?.moved) buildSelection();
    drag = null;
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("dblclick", (e) => {
    const { x, y } = local(e);
    const hit = noteAt(x, y);
    if (!hit || edit.notes[hit.id]?.target == null) return;
    remember();
    delete edit.notes[hit.id].target;
    recompute();
    buildSelection();
  });
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { w } = size();
      if (e.ctrlKey || e.metaKey) {
        // Zoom time around the pointer.
        const t = tOf(local(e).x, w);
        const k = Math.exp(e.deltaY * 0.002);
        view.t0 = Math.max(0, t - (t - view.t0) * k);
        view.t1 = Math.min(source.duration, t + (view.t1 - t) * k);
        if (view.t1 - view.t0 < 0.2) view.t1 = view.t0 + 0.2;
      } else if (e.shiftKey) {
        const d = ((e.deltaY || e.deltaX) / w) * (view.t1 - view.t0);
        const shift = clamp(d, -view.t0, source.duration - view.t1);
        view.t0 += shift;
        view.t1 += shift;
      } else {
        const d = -e.deltaY * 0.02;
        view.m0 += d;
        view.m1 += d;
      }
      paint();
    },
    { passive: false },
  );

  function splitAt(t) {
    const track = source.pitchTrack;
    const f = Math.round(t / track.hop);
    const n = notes.find((x) => f > x.start + 2 && f < x.end - 2);
    if (!n) return;
    remember();
    edit.joins = edit.joins.filter((j) => j !== f);
    edit.cuts.push(f);
    recompute();
  }
  function joinSelected() {
    const sel = notes.filter((n) => selected.has(n.id));
    if (!sel.length) return;
    remember();
    for (const n of sel) {
      const i = notes.indexOf(n);
      if (i > 0 && notes[i - 1].end === n.start) {
        if (edit.cuts.includes(n.start)) edit.cuts = edit.cuts.filter((c) => c !== n.start);
        else edit.joins.push(n.start);
        selected.delete(n.id);
        selected.add(notes[i - 1].id);
      }
    }
    recompute();
    buildSelection();
  }
  const onKey = (e) => {
    if (closed || e.target.matches?.("input, select")) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === "z") undo();
    else if (k === "s") splitAt(hoverTime);
    else if (k === "j") joinSelected();
    else if (k === " ") toggleAudition();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  addEventListener("keydown", onKey, true);

  /* ── audition, apply, revert ────────────────────────────────────────── */

  function stopAudition() {
    try {
      audition?.stop();
    } catch {
      /* already stopped */
    }
    audition = null;
  }
  async function toggleAudition() {
    if (audition) return stopAudition();
    status.textContent = "Rendering a preview…";
    const buffer = await renderCorrected(source, edit, { onProgress: (p) => (status.textContent = `Rendering a preview… ${Math.round(p * 100)}%`) });
    if (closed || !buffer) return;
    status.textContent = "Playing the corrected clip, dry. Space stops it.";
    const ctx = engine.ensure();
    await ctx.resume();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.onended = () => {
      if (audition === src) (audition = null), (status.textContent = LIMITS);
    };
    src.start(0, region[0], region[1] - region[0]);
    audition = src;
  }

  const LIMITS = "For one voice or instrument at a time. Best for corrections within about two semitones; chords, and large shifts that should keep their character, are beyond it.";
  const finish = () => {
    closed = true;
    stopAudition();
    removeEventListener("keydown", onKey, true);
  };

  let closeDialog = () => {};
  const result = new Promise((resolve) => {
    dialog(
      `Edit pitch — ${clip.name}`,
      (body, close) => {
        closeDialog = () => {
          finish();
          close?.();
          resolve();
        };
        body.parentElement.classList.add("pitch-dialog");
        body.append(globals, canvas, selection, el("div.pe-foot", null, info, status));
      },
      [
        ...(clip.pitchEdit
          ? [
              {
                label: "Revert to original",
                warn: true,
                onClick: () => {
                  pushUndo("revert pitch");
                  revertPitchEdit(clip).then(() => {
                    changed("clips");
                    engine.invalidate();
                  });
                  finish();
                  resolve();
                },
              },
            ]
          : []),
        { label: "Audition", onClick: () => (toggleAudition(), false) },
        { label: "Cancel", onClick: () => (finish(), resolve()) },
        {
          label: "Apply",
          primary: true,
          onClick: () => {
            status.textContent = "Rendering…";
            if (applying) return false;
            applying = true;
            applyPitchEdit(clip, edit, { commit: () => pushUndo("edit pitch"), onProgress: (p) => (status.textContent = `Rendering… ${Math.round(p * 100)}%`) }).then(
              () => {
                changed("clips");
                engine.invalidate();
                toast("Pitch edit applied", "ok");
                closeDialog();
              },
              (err) => {
                applying = false;
                status.textContent = err.message;
              },
            );
            return false;
          },
        },
      ],
    );
  });
  // Closing by Escape or a click outside must tidy up too.
  const watch = new MutationObserver(() => {
    if (!canvas.isConnected && !closed) finish();
  });
  watch.observe(document.querySelector("#overlay"), { childList: true });

  const track = await analyzeAsset(source, { onProgress: (p) => (status.textContent = `Analysing… ${Math.round(p * 100)}%`) });
  if (closed || !track) return result;
  status.textContent = LIMITS;
  fitView();
  buildControls();
  recompute();
  new ResizeObserver(paint).observe(canvas);
  // For tests and the console.
  canvas.__editor = { get notes() { return notes; }, get edit() { return edit; }, get curve() { return curve; }, view, selected, splitAt, joinSelected, undo, xOf, yOf, size, region };
  return result;
}

/** Can this clip's pitch be edited? (It needs its audio, and one voice's worth of it.) */
export const canEditPitch = (clip) => !!sourceAssetOf(clip)?.buffer;
