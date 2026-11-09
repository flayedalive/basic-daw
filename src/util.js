// Small shared helpers: DOM building, unit conversion, formatting, and the
// three bits of chrome (toast / menu / dialog) that every panel reaches for.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** el("div.foo#bar", {attrs}, ...children) — terse enough to build panels inline. */
export function el(spec, attrs = null, ...children) {
  const m = /^([a-z0-9]+)?(#[\w-]+)?((?:\.[\w-]+)*)$/i.exec(spec);
  if (!m) throw new Error(`bad element spec: ${spec}`);
  const node = document.createElement(m[1] || "div");
  if (m[2]) node.id = m[2].slice(1);
  if (m[3]) node.className = m[3].slice(1).split(".").join(" ");
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k in node && k !== "list" && k !== "type") node[k] = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
  }
  for (const c of children.flat(4)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-3)}`;

/** dB <-> linear. -Infinity dB is silence; the UI floors faders at MIN_DB. */
export const MIN_DB = -60;
// Silence is stored as MIN_DB, never -Infinity: projects and undo snapshots go
// through JSON, which turns -Infinity into null. A null (from an older save)
// still reads as silence here, not as 10^(null/20) = unity gain.
export const isSilentDb = (db) => db == null || !(db > MIN_DB);
export const dbToGain = (db) => (isSilentDb(db) ? 0 : Math.pow(10, db / 20));
export const gainToDb = (g) => (g <= 0.0001 ? -Infinity : 20 * Math.log10(g));

/** Fader taper: 0..1 slider position <-> dB, with more resolution near 0 dB. */
export const MAX_DB = 6;
export function posToDb(pos) {
  const p = clamp(pos, 0, 1);
  if (p <= 0) return MIN_DB; // silent; see isSilentDb
  // Exponential-ish taper: unity sits at ~0.78 of the throw, like a real fader.
  return MIN_DB + (MAX_DB - MIN_DB) * Math.pow(p, 1 / 2.2);
}
export function dbToPos(db) {
  if (isSilentDb(db) || !isFinite(db)) return 0;
  const d = clamp(db, MIN_DB, MAX_DB);
  return Math.pow((d - MIN_DB) / (MAX_DB - MIN_DB), 2.2);
}

export function fmtDb(db) {
  if (isSilentDb(db) || !isFinite(db)) return "-∞";
  return `${db > 0 ? "+" : ""}${db.toFixed(1)}`;
}

export function fmtTime(sec, ms = true) {
  const neg = sec < 0;
  const s = Math.abs(sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const body = ms
    ? `${m}:${r.toFixed(3).padStart(6, "0")}`
    : `${m}:${Math.floor(r).toString().padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

export function fmtDur(sec) {
  if (!isFinite(sec)) return "--";
  return sec >= 60 ? fmtTime(sec, false) : `${sec.toFixed(2)}s`;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Bars.beats.ticks display (1-based bars/beats, 960 ticks per beat). */
export function fmtBBT(sec, bpm, sigNum, sigDen) {
  const beatSec = 60 / bpm / (sigDen / 4);
  const beats = sec / beatSec;
  const bar = Math.floor(beats / sigNum);
  const beat = Math.floor(beats - bar * sigNum);
  const tick = Math.round((beats - Math.floor(beats)) * 960);
  return `${String(bar + 1).padStart(3, "0")}.${beat + 1}.${String(tick).padStart(3, "0")}`;
}

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ── toast ──────────────────────────────────────────────────────────────── */
export function toast(msg, kind = "", ms = 2600) {
  const layer = $("#toast-layer");
  const t = el(`div.toast${kind ? "." + kind : ""}`, null, msg);
  layer.append(t);
  setTimeout(() => {
    t.style.transition = "opacity .2s";
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 220);
  }, ms);
  return t;
}

/* ── popup menu ─────────────────────────────────────────────────────────── */
/** items: {label, sc?, onClick?, disabled?, checked?} | "-" | {title} */
export function popupMenu(x, y, items) {
  closeMenus();
  const menu = el("div.menu", { style: { left: `${x}px`, top: `${y}px` } });
  for (const it of items) {
    if (it === "-") {
      menu.append(el("div.msep"));
      continue;
    }
    if (it.title) {
      menu.append(el("div.mtitle", null, it.title));
      continue;
    }
    const row = el(
      `div.mi${it.disabled ? ".disabled" : ""}`,
      {
        onclick: (e) => {
          e.stopPropagation();
          closeMenus();
          it.onClick?.();
        },
      },
      it.checked ? "✓ " : "",
      it.label,
      it.sc ? el("span.sc", null, it.sc) : null,
    );
    menu.append(row);
  }
  $("#menu-layer").append(menu);
  // Keep it on screen.
  const r = menu.getBoundingClientRect();
  if (r.right > innerWidth - 4) menu.style.left = `${Math.max(4, innerWidth - r.width - 4)}px`;
  if (r.bottom > innerHeight - 4) menu.style.top = `${Math.max(4, innerHeight - r.height - 4)}px`;
  return menu;
}

export function closeMenus() {
  $("#menu-layer").replaceChildren();
}

addEventListener("pointerdown", (e) => {
  if (!e.target.closest?.(".menu")) closeMenus();
});

/* ── modal dialog ───────────────────────────────────────────────────────── */
/** Returns {close}. `build(body, close)` fills the body; foot buttons come from `buttons`. */
export function dialog(title, build, buttons = [{ label: "Close" }]) {
  const overlay = $("#overlay");
  const close = () => {
    overlay.hidden = true;
    overlay.replaceChildren();
    removeEventListener("keydown", onKey, true);
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const body = el("div.d-body");
  const foot = el("div.d-foot");
  for (const b of buttons) {
    foot.append(
      el(`button.btn${b.primary ? ".primary" : ""}${b.warn ? ".warn" : ""}`, {
        onclick: () => {
          if (b.onClick?.(body) !== false) close();
        },
        textContent: b.label,
      }),
    );
  }
  const d = el("div.dialog", null, el("h3", null, title), body, foot);
  overlay.replaceChildren(d);
  overlay.hidden = false;
  overlay.onpointerdown = (e) => {
    if (e.target === overlay) close();
  };
  addEventListener("keydown", onKey, true);
  build(body, close);
  return { close, body };
}

/* ── pointer drag helper ────────────────────────────────────────────────── */
/** Captures the pointer and streams deltas until release. onMove(dx, dy, e). */
export function drag(e, onMove, onEnd) {
  e.preventDefault();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const target = e.currentTarget ?? e.target;
  const move = (ev) => onMove(ev.clientX - x0, ev.clientY - y0, ev);
  const up = (ev) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
    onEnd?.(ev.clientX - x0, ev.clientY - y0, ev);
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
  addEventListener("pointercancel", up);
  try {
    target.setPointerCapture?.(e.pointerId);
  } catch {
    /* not all targets are capturable */
  }
}

/** Tiny event bus — panels subscribe to state changes without importing each other. */
export function emitter() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt).delete(fn);
    },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => fn(payload));
      map.get("*")?.forEach((fn) => fn(evt, payload));
    },
  };
}

/**
 * Wrap a render function so many calls in one frame do one render. Panels
 * subscribe to events that fire on every pointermove during a drag; without
 * this, dragging a clip rebuilds the inspector sixty times a second.
 */
export function coalesce(fn) {
  let queued = false;
  return (...args) => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...args);
    });
  };
}

/** Yield to the event loop so long imports/renders don't freeze the UI. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(r));

export const TRACK_COLORS = [
  "#5cc8ff",
  "#ffb454",
  "#7ee081",
  "#ff6b9d",
  "#b48cff",
  "#ffe066",
  "#4fd6c8",
  "#ff8f5c",
  "#8ab4ff",
  "#d68cff",
];
