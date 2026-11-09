// Reusable widgets: canvas knob, vertical fader, and the drag-a-number field.
// All three share the same interaction: drag vertically, Shift for fine,
// Alt-click to reset to the default, and double-click (or click the readout)
// to type an exact value.

import { el, drag, clamp, dbToPos, posToDb, fmtDb, MIN_DB, MAX_DB } from "../util.js";

const DPR = () => Math.min(2, devicePixelRatio || 1);

function fitCanvas(canvas, w, h) {
  const dpr = DPR();
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const c = canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  return c;
}

/* ── typing a value ─────────────────────────────────────────────────── */

let openEditor = null;

/**
 * Float a small text box over `anchor` to type an exact value.
 * Enter or clicking away commits, Escape cancels. `parse` returns a number, or
 * null for input it can't read (which leaves the value alone).
 */
export function editValue(anchor, { value, format = String, parse = parseNumber, onCommit }) {
  openEditor?.(false);
  const r = anchor.getBoundingClientRect();
  const input = el("input.val-edit", { type: "text", spellcheck: false, autocomplete: "off" });
  input.value = format(value);
  Object.assign(input.style, {
    left: `${Math.max(4, Math.min(innerWidth - 80, r.left + r.width / 2 - 36))}px`,
    top: `${Math.max(4, r.top + r.height / 2 - 11)}px`,
  });
  document.body.append(input);
  input.focus();
  input.select();
  const finish = (commit) => {
    if (openEditor !== finish) return;
    openEditor = null;
    const v = commit ? parse(input.value.trim()) : null;
    input.remove();
    if (v != null && !Number.isNaN(v)) onCommit(v);
  };
  openEditor = finish;
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

const MINUS = /[\u2212\u2013]/g; // typographic minus / en dash, as pasted from a readout

export function parseNumber(text) {
  const m = /[-+]?\d*\.?\d+(e[-+]?\d+)?/i.exec(text.replace(MINUS, "-"));
  return m ? Number(m[0]) : null;
}

/** "-6", "−6 dB", "+2.5", "-inf" / "off" → dB, clamped to the fader's range. */
export function parseDb(text) {
  const t = text.replace(MINUS, "-").toLowerCase();
  if (/^-?(inf|∞|-∞)|^off$|^mute$/.test(t) || t === "-∞") return MIN_DB; // silent
  const v = parseNumber(t);
  if (v == null) return null;
  return clamp(v, MIN_DB, MAX_DB);
}

/** "C", "L30", "30L", "R15", "-30" (percent, left negative) → -1 … 1. */
export function parsePan(text) {
  const t = text.trim().toUpperCase();
  if (t === "C" || t === "0" || t === "CENTER" || t === "CENTRE") return 0;
  const n = parseNumber(t);
  if (n == null) return null;
  const sign = /L/.test(t) ? -1 : /R/.test(t) ? 1 : Math.sign(n);
  return clamp((sign * Math.abs(n)) / 100, -1, 1);
}

/**
 * knob({label, value, min, max, def, unit, log, format, onInput})
 * Returns {root, set(value)}.
 */
export function knob(opts) {
  const size = opts.size ?? 30;
  const canvas = el("canvas.knob", { title: opts.title ?? opts.label ?? "" });
  const valEl = el("div.kval");
  const root = el(
    "div.knob-wrap",
    null,
    opts.label ? el("label", null, opts.label) : null,
    canvas,
    opts.showValue === false ? null : valEl,
  );

  const toNorm = (v) =>
    opts.log
      ? Math.log(clamp(v, opts.min, opts.max) / opts.min) / Math.log(opts.max / opts.min)
      : (clamp(v, opts.min, opts.max) - opts.min) / (opts.max - opts.min);
  const fromNorm = (n) =>
    opts.log ? opts.min * Math.pow(opts.max / opts.min, clamp(n, 0, 1)) : opts.min + clamp(n, 0, 1) * (opts.max - opts.min);

  let value = opts.value ?? opts.def ?? opts.min;

  function paint() {
    const c = fitCanvas(canvas, size, size);
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - 3.5;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    const n = toNorm(value);
    const a = a0 + (a1 - a0) * n;
    c.lineCap = "round";
    c.lineWidth = 3;
    c.strokeStyle = "#2c3142";
    c.beginPath();
    c.arc(cx, cy, r, a0, a1);
    c.stroke();
    // Bipolar controls fill from the centre so "flat" reads at a glance.
    const bipolar = opts.min < 0 && opts.max > 0;
    c.strokeStyle = opts.color ?? "#5cc8ff";
    c.beginPath();
    if (bipolar) {
      const mid = a0 + (a1 - a0) * toNorm(0);
      c.arc(cx, cy, r, Math.min(mid, a), Math.max(mid, a));
    } else {
      c.arc(cx, cy, r, a0, a);
    }
    c.stroke();
    c.strokeStyle = "#d8dce8";
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * (r - 7), cy + Math.sin(a) * (r - 7));
    c.lineTo(cx + Math.cos(a) * (r - 1), cy + Math.sin(a) * (r - 1));
    c.stroke();
    valEl.textContent = opts.format ? opts.format(value) : `${round(value)}${opts.unit ?? ""}`;
  }

  const round = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

  canvas.addEventListener("pointerdown", (e) => {
    if (e.altKey) {
      value = opts.def ?? opts.min;
      paint();
      opts.onInput?.(value);
      return;
    }
    const start = toNorm(value);
    drag(
      e,
      (dx, dy, ev) => {
        const speed = ev.shiftKey ? 0.0015 : 0.006;
        value = fromNorm(start - dy * speed);
        paint();
        opts.onInput?.(value);
      },
      () => opts.onChange?.(value),
    );
  });
  const commit = (v) => {
    value = clamp(v, opts.min, opts.max);
    paint();
    opts.onInput?.(value);
    opts.onChange?.(value);
  };
  const edit = () =>
    editValue(canvas, {
      value,
      format: opts.format ?? ((v) => `${round(v)}`),
      parse: opts.parse ?? parseNumber,
      onCommit: commit,
    });
  canvas.addEventListener("dblclick", edit);
  valEl.addEventListener("click", edit);
  valEl.title = "Click to type a value";
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const step = (e.shiftKey ? 0.002 : 0.02) * (e.deltaY > 0 ? -1 : 1);
    value = fromNorm(toNorm(value) + step);
    paint();
    opts.onInput?.(value);
  });

  paint();
  return {
    root,
    edit,
    set(v) {
      value = v;
      paint();
    },
    get value() {
      return value;
    },
  };
}

/**
 * dB fader with tick marks. `orient: "h"` lays it out horizontally, which is
 * what fits a track header; the mixer uses the vertical form.
 */
export function fader(opts) {
  const canvas = el("canvas.fader", { title: opts.title ?? "Level" });
  const horiz = opts.orient === "h";
  let db = opts.value ?? 0;
  let w = opts.width ?? (horiz ? 80 : 26);
  let h = opts.height ?? (horiz ? 14 : 90);
  const PAD = 7;

  const usable = () => (horiz ? w : h) - PAD * 2;

  function paint() {
    const c = fitCanvas(canvas, w, h);
    const cross = (horiz ? h : w) / 2;
    c.strokeStyle = "#2c3142";
    c.lineWidth = 3;
    c.beginPath();
    if (horiz) {
      c.moveTo(PAD, cross);
      c.lineTo(w - PAD, cross);
    } else {
      c.moveTo(cross, PAD);
      c.lineTo(cross, h - PAD);
    }
    c.stroke();
    // Ticks at unity and the usual working levels.
    c.strokeStyle = "#242836";
    c.lineWidth = 1;
    for (const mark of [MAX_DB, 0, -6, -12, -24, -48]) {
      const at = PAD + usable() * (horiz ? dbToPos(mark) : 1 - dbToPos(mark));
      c.beginPath();
      if (horiz) {
        c.moveTo(at, 2);
        c.lineTo(at, h - 2);
      } else {
        c.moveTo(2, at);
        c.lineTo(w - 2, at);
      }
      c.stroke();
    }
    const at = PAD + usable() * (horiz ? dbToPos(db) : 1 - dbToPos(db));
    c.fillStyle = "#5cc8ff";
    c.strokeStyle = "#0d0f14";
    c.lineWidth = 1;
    c.beginPath();
    if (horiz) c.roundRect(at - 4, cross - Math.min(6, h / 2 - 1), 8, Math.min(12, h - 2), 2);
    else c.roundRect(cross - 9, at - 5, 18, 10, 2);
    c.fill();
    c.stroke();
  }

  canvas.addEventListener("pointerdown", (e) => {
    const rect = canvas.getBoundingClientRect();
    const posAt = (ev) =>
      horiz ? clamp((ev.clientX - rect.left - PAD) / usable(), 0, 1) : clamp(1 - (ev.clientY - rect.top - PAD) / usable(), 0, 1);
    if (e.altKey) {
      db = 0;
      paint();
      opts.onInput?.(db);
      return;
    }
    // Clicking off the thumb jumps to that level first, then drags from there.
    if (Math.abs(posAt(e) - dbToPos(db)) > 0.06) {
      db = posToDb(posAt(e));
      paint();
      opts.onInput?.(db);
    }
    const startPos = dbToPos(db);
    drag(
      e,
      (dx, dy, ev) => {
        const scale = ev.shiftKey ? 0.25 : 1;
        const delta = (horiz ? dx : -dy) / usable();
        db = posToDb(clamp(startPos + delta * scale, 0, 1));
        paint();
        opts.onInput?.(db);
      },
      () => opts.onChange?.(db),
    );
  });
  const edit = () =>
    editValue(canvas, {
      value: db,
      format: (v) => (v != null && isFinite(v) && v > MIN_DB ? v.toFixed(1) : "-inf"),
      parse: parseDb,
      onCommit: (v) => {
        db = v;
        paint();
        opts.onInput?.(db);
        opts.onChange?.(db);
      },
    });
  canvas.addEventListener("dblclick", edit);
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    db = clamp(db + (e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 0.2 : 1), MIN_DB, MAX_DB);
    paint();
    opts.onInput?.(db);
  });

  paint();
  return {
    root: canvas,
    edit,
    set(v) {
      db = v;
      paint();
    },
    resize(nw, nh) {
      w = nw;
      h = nh;
      paint();
    },
    get value() {
      return db;
    },
  };
}

/** Label + range slider + numeric readout, the inspector's workhorse row. */
export function sliderRow(opts) {
  const val = el("span.val");
  const input = el("input", {
    type: "range",
    min: 0,
    max: 1000,
    step: 1,
    value: String(toSlider(opts.value)),
  });
  function toSlider(v) {
    const n = opts.log
      ? Math.log(clamp(v, opts.min, opts.max) / opts.min) / Math.log(opts.max / opts.min)
      : (clamp(v, opts.min, opts.max) - opts.min) / (opts.max - opts.min);
    return Math.round(n * 1000);
  }
  function fromSlider(s) {
    const n = s / 1000;
    return opts.log ? opts.min * Math.pow(opts.max / opts.min, n) : opts.min + n * (opts.max - opts.min);
  }
  const show = (v) => (val.textContent = opts.format ? opts.format(v) : `${fmtNum(v, opts.prec)}${opts.unit ?? ""}`);
  show(opts.value);
  input.addEventListener("input", () => {
    const v = fromSlider(+input.value);
    show(v);
    opts.onInput?.(v);
  });
  input.addEventListener("change", () => opts.onChange?.(fromSlider(+input.value)));
  input.addEventListener("dblclick", () => {
    input.value = String(toSlider(opts.def ?? opts.min));
    input.dispatchEvent(new Event("input"));
    opts.onChange?.(fromSlider(+input.value));
  });
  // The slider's resolution is 1/1000 of its range; typing gets exact values.
  val.title = "Click to type a value";
  val.classList.add("editable");
  val.addEventListener("click", () =>
    editValue(val, {
      value: fromSlider(+input.value),
      format: (v) => fmtNum(v, opts.prec),
      parse: opts.parse ?? parseNumber,
      onCommit: (v) => {
        const c = clamp(v, opts.min, opts.max);
        input.value = String(toSlider(c));
        show(c);
        opts.onInput?.(c);
        opts.onChange?.(c);
      },
    }),
  );
  const root = el("div.prow", null, el("label", null, opts.label), input, val);
  return { root, set: (v) => ((input.value = String(toSlider(v))), show(v)) };
}

export function fmtNum(v, prec) {
  if (prec != null) return v.toFixed(prec);
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function dbRow(label, value, onInput) {
  return sliderRow({
    label,
    value,
    min: MIN_DB,
    max: MAX_DB,
    format: (v) => `${fmtDb(v)} dB`,
    parse: parseDb,
    def: 0,
    onInput,
  });
}

/** Small horizontal meter used in track headers. */
export function meterBar() {
  const fill = el("i");
  const root = el("div.tmeter", null, fill);
  let shown = 0;
  return {
    root,
    update(peak) {
      const db = peak > 0 ? 20 * Math.log10(peak) : -60;
      const t = clamp(1 + db / 60, 0, 1);
      shown = t > shown ? t : shown * 0.86;
      fill.style.height = `${(shown * 100).toFixed(1)}%`;
    },
  };
}
