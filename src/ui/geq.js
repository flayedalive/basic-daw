// The graphic EQ's face: a bank of vertical sliders with the true combined
// response drawn over them. Mounted by the inspector for the graphic EQ
// plugins, the way the 4-band EQ mounts its curve.
//
// Third-octave bands overlap, so neighbouring sliders add up to more than
// either says on its own. Drawing the real response rather than a line through
// the slider tops is what keeps the picture honest.

import { el, clamp } from "../util.js";
import { engine } from "../audio/engine.js";

const RANGE = 12; // dB either side
const H = 150;
const PAD_TOP = 8;
const PAD_BOTTOM = 16;

/**
 * bands: [{ key, hz, label }], q: filter Q, params: the insert's parameter
 * object (read live), interactive: draw sliders and accept the pointer.
 * onInput(key, db) while dragging, onChange(key, db) on release,
 * onBegin() once before a gesture's first change (for a single undo step).
 */
export function geqView({ bands, q, params, interactive = true, onBegin, onInput, onChange }) {
  const canvas = el("canvas.geq-canvas", { style: { width: "100%", height: `${H}px`, touchAction: "none", cursor: interactive ? "crosshair" : "default" } });
  const readout = el("span.val", null, "");
  const root = el("div.geq", null, canvas);
  if (interactive) {
    root.append(
      el(
        "div.btnrow",
        null,
        el("button.btn", {
          onclick: () => {
            onBegin?.();
            for (const b of bands) onChange(b.key, 0);
            paint();
          },
          textContent: "Flat",
        }),
        readout,
      ),
    );
  }

  const yOf = (db, h) => PAD_TOP + ((RANGE - db) / (2 * RANGE)) * (h - PAD_TOP - PAD_BOTTOM);
  const dbOf = (y, h) => clamp(RANGE - ((y - PAD_TOP) / (h - PAD_TOP - PAD_BOTTOM)) * 2 * RANGE, -RANGE, RANGE);
  // Bands are evenly spaced: ISO centres are evenly spaced in log frequency.
  const xOf = (i, w) => ((i + 0.5) / bands.length) * w;
  const bandAt = (x, w) => clamp(Math.floor((x / w) * bands.length), 0, bands.length - 1);

  function paint() {
    if (!canvas.isConnected) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = canvas.clientWidth || 220;
    canvas.width = w * dpr;
    canvas.height = H * dpr;
    const c = canvas.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = "#0d0f14";
    c.fillRect(0, 0, w, H);
    for (const db of [-12, -6, 0, 6, 12]) {
      c.strokeStyle = db === 0 ? "#39405a" : "#1e2230";
      c.beginPath();
      c.moveTo(0, yOf(db, H) + 0.5);
      c.lineTo(w, yOf(db, H) + 0.5);
      c.stroke();
    }
    const zero = yOf(0, H);
    const bw = w / bands.length;
    if (interactive) {
      bands.forEach((b, i) => {
        const y = yOf(params[b.key] ?? 0, H);
        c.fillStyle = "#2c3a55";
        c.fillRect(xOf(i, w) - Math.max(1, bw * 0.3), Math.min(y, zero), Math.max(2, bw * 0.6), Math.abs(y - zero) || 1);
        c.fillStyle = "#9fb4d8";
        c.fillRect(xOf(i, w) - Math.max(1.5, bw * 0.4), y - 1.5, Math.max(3, bw * 0.8), 3);
      });
    }
    // The real response, from real filters at the engine's sample rate.
    const N = Math.max(64, Math.floor(w));
    const lo = bands[0].hz / Math.pow(bands[1].hz / bands[0].hz, 0.5);
    const hi = bands.at(-1).hz * Math.pow(bands[1].hz / bands[0].hz, 0.5);
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = lo * Math.pow(hi / lo, i / (N - 1));
    const total = responseDb(bands, q, params, freqs);
    c.strokeStyle = "#5cc8ff";
    c.lineWidth = 1.5;
    c.beginPath();
    for (let i = 0; i < N; i++) {
      const y = clamp(yOf(total[i], H), 0, H);
      i ? c.lineTo((i / (N - 1)) * w, y) : c.moveTo(0, y);
    }
    c.stroke();
    c.fillStyle = "#8a90a4";
    c.font = "9px ui-monospace, monospace";
    bands.forEach((b, i) => {
      if (bands.length > 12 && ![20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].includes(b.hz)) return;
      // The outermost labels hug the edges rather than being cut off by them.
      c.textAlign = i === 0 ? "left" : i === bands.length - 1 ? "right" : "center";
      c.fillText(b.label, i === 0 ? 1 : i === bands.length - 1 ? w - 1 : xOf(i, w), H - 4);
    });
  }

  if (interactive) {
    let dragging = false;
    const apply = (e, commit) => {
      const r = canvas.getBoundingClientRect();
      const i = bandAt(e.clientX - r.left, r.width);
      const db = Math.round(dbOf(e.clientY - r.top, r.height) * 2) / 2; // half-dB steps
      readout.textContent = `${bands[i].label} Hz  ${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
      (commit ? onChange : onInput)(bands[i].key, db);
      paint();
    };
    canvas.addEventListener("pointerdown", (e) => {
      dragging = true;
      canvas.setPointerCapture(e.pointerId);
      onBegin?.();
      apply(e, false);
    });
    canvas.addEventListener("pointermove", (e) => dragging && apply(e, false));
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      apply(e, true);
    };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("dblclick", (e) => {
      const r = canvas.getBoundingClientRect();
      const i = bandAt(e.clientX - r.left, r.width);
      onBegin?.();
      onChange(bands[i].key, 0);
      paint();
    });
  }

  requestAnimationFrame(paint);
  return root;
}

/** Combined response in dB of peaking bands at `freqs`, measured on real BiquadFilterNodes. */
export function responseDb(bands, q, params, freqs) {
  const ctx = engine.ensure();
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  const total = new Float32Array(freqs.length);
  for (const b of bands) {
    const g = params[b.key] ?? 0;
    if (!g) continue;
    const node = ctx.createBiquadFilter();
    node.type = "peaking";
    node.frequency.value = Math.min(b.hz, ctx.sampleRate / 2 - 100);
    node.Q.value = q;
    node.gain.value = g;
    node.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < total.length; i++) total[i] += 20 * Math.log10(Math.max(1e-6, mag[i]));
  }
  return total;
}
