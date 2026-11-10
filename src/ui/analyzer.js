// Master spectrum analyzer and stereo correlation meter, beside the master
// strip. Display only: it reads the AnalyserNodes hanging off the live master
// bus (the ones the meters use) and is never part of a bounce.
//
// The spectrum is on a log frequency axis, with an optional 4.5 dB/octave tilt
// pivoting at 1 kHz. Music's energy falls with frequency at about that rate,
// so the tilt makes a balanced mix draw as a level line — which is easier to
// read than a slope. The correlation meter runs from -1 (the channels cancel
// in mono) through 0 (unrelated) to +1 (identical).

import { el, clamp } from "../util.js";
import { engine } from "../audio/engine.js";

const F_LO = 20;
const F_HI = 20000;
const DB_LO = -96;
const DB_HI = 0;
const TILT = 4.5; // dB per octave
const KEY = "daw.analyzer";

/**
 * Reduce an AnalyserNode's dB spectrum to `width` columns on a log axis.
 * Each column takes the loudest bin it covers, or interpolates between two
 * bins where the columns are narrower than a bin (the low end).
 */
export function spectrumColumns(freqDb, sampleRate, width, { tilt = false, out = new Float32Array(width) } = {}) {
  const bins = freqDb.length;
  const hzPerBin = sampleRate / 2 / bins;
  const ratio = Math.pow(F_HI / F_LO, 1 / width);
  for (let x = 0; x < width; x++) {
    const f0 = F_LO * Math.pow(ratio, x);
    const f1 = f0 * ratio;
    const b0 = f0 / hzPerBin;
    const b1 = f1 / hzPerBin;
    let v;
    if (b1 - b0 < 1) {
      const i = Math.min(bins - 2, Math.floor(b0));
      const a = b0 - i;
      v = freqDb[i] + (freqDb[i + 1] - freqDb[i]) * a;
    } else {
      v = -Infinity;
      for (let i = Math.floor(b0); i < Math.min(bins, Math.ceil(b1)); i++) if (freqDb[i] > v) v = freqDb[i];
    }
    if (tilt) v += TILT * Math.log2(Math.sqrt(f0 * f1) / 1000);
    out[x] = v;
  }
  return out;
}

/** Pearson correlation of two blocks: +1 identical, -1 inverted, 0 unrelated. Null when either is silent. */
export function correlation(l, r) {
  let lr = 0;
  let ll = 0;
  let rr = 0;
  for (let i = 0; i < l.length; i++) {
    lr += l[i] * r[i];
    ll += l[i] * l[i];
    rr += r[i] * r[i];
  }
  if (ll < 1e-10 || rr < 1e-10) return null;
  return clamp(lr / Math.sqrt(ll * rr), -1, 1);
}

const xOfHz = (hz, w) => (Math.log(hz / F_LO) / Math.log(F_HI / F_LO)) * w;

let panel = null;

/** Build the panel (once per mixer render). */
export function analyzerPanel() {
  let prefs = { open: true, tilt: true };
  try {
    prefs = { ...prefs, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    /* a bad stored value just means the defaults */
  }
  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* private mode: the preference just doesn't stick */
    }
  };

  const canvas = el("canvas.an-canvas");
  const corrFill = el("i");
  const corrBar = el("div.an-corr", { title: "Stereo correlation: +1 mono-compatible, 0 wide, below 0 parts of the mix cancel in mono" }, corrFill);
  const corrVal = el("span.val", null, "–");
  const tiltBtn = el("button.mini", {
    title: "Tilt the display by 4.5 dB/octave around 1 kHz, so a balanced mix reads as a level line",
    onclick: () => {
      prefs.tilt = !prefs.tilt;
      tiltBtn.classList.toggle("on", prefs.tilt);
      save();
    },
    textContent: "tilt",
  });
  tiltBtn.classList.toggle("on", prefs.tilt);
  // Loudness since play was last pressed (ITU-R BS.1770). Click to start it again.
  const lu = {};
  const cell = (key, label, title) => el("span.an-lu", { title }, el("span.an-lab", null, label), (lu[key] = el("b", null, "–")));
  const loud = el(
    "div.an-row.an-loud",
    { title: "Click to reset", onclick: () => engine.resetLoudness() },
    cell("momentary", "M", "Momentary loudness (400 ms), LUFS"),
    cell("shortTerm", "S", "Short-term loudness (3 s), LUFS"),
    cell("integrated", "I", "Integrated loudness since play was pressed, LUFS"),
    cell("truePeak", "TP", "True peak since play was pressed, dBTP"),
  );
  const body = el("div.an-body", null, canvas, el("div.an-row", null, el("span.an-lab", null, "-1"), corrBar, el("span.an-lab", null, "+1"), corrVal), loud);
  const toggle = el("button.mini", {
    title: "Show / hide the analyzer",
    onclick: () => {
      prefs.open = !prefs.open;
      apply();
      save();
    },
  });
  const root = el("div.strip.analyzer", null, el("div.an-head", null, el("span.s-name", null, "ANALYZER"), tiltBtn, toggle), body);
  const apply = () => {
    root.classList.toggle("closed", !prefs.open);
    toggle.textContent = prefs.open ? "◂" : "▸";
    tiltBtn.style.display = prefs.open ? "" : "none";
  };
  apply();

  panel = { root, canvas, corrFill, corrVal, lu, prefs, cols: null, shown: null, corr: 0, freq: null };
  return root;
}

/** Called every animation frame by the mixer, after the engine has read its levels. */
export function updateAnalyzer() {
  const p = panel;
  if (!p || !p.prefs.open || !p.root.isConnected || !engine.ctx) return;
  const m = engine.master;
  const an = m.analyserL;

  const w = p.canvas.clientWidth;
  const h = p.canvas.clientHeight;
  if (w < 8 || h < 8) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (p.canvas.width !== Math.round(w * dpr) || p.canvas.height !== Math.round(h * dpr)) {
    p.canvas.width = Math.round(w * dpr);
    p.canvas.height = Math.round(h * dpr);
    p.cols = new Float32Array(w);
    p.shown = new Float32Array(w).fill(DB_LO);
  }
  p.freq ??= new Float32Array(an.frequencyBinCount);
  p.freqR ??= new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(p.freq);
  m.analyserR.getFloatFrequencyData(p.freqR);
  // Mean power of the two channels: unlike a mono sum, content that is out of
  // phase between them still shows.
  for (let i = 0; i < p.freq.length; i++) {
    p.freq[i] = 10 * Math.log10((Math.pow(10, p.freq[i] / 10) + Math.pow(10, p.freqR[i] / 10)) / 2 + 1e-13);
  }
  spectrumColumns(p.freq, engine.sampleRate, w, { tilt: p.prefs.tilt, out: p.cols });

  const c = p.canvas.getContext("2d");
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = "#0d0f14";
  c.fillRect(0, 0, w, h);
  const yOf = (db) => ((DB_HI - clamp(db, DB_LO, DB_HI)) / (DB_HI - DB_LO)) * h;
  c.font = "9px ui-monospace, monospace";
  c.textBaseline = "top";
  for (const hz of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = Math.round(xOfHz(hz, w)) + 0.5;
    const major = hz === 100 || hz === 1000 || hz === 10000;
    c.strokeStyle = major ? "#2a3044" : "#1a1e2a";
    c.beginPath();
    c.moveTo(x, 0);
    c.lineTo(x, h);
    c.stroke();
    if (major) {
      c.fillStyle = "#6b7288";
      c.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 2, 1);
    }
  }
  for (const db of [-72, -48, -24]) {
    c.strokeStyle = "#1a1e2a";
    c.beginPath();
    c.moveTo(0, Math.round(yOf(db)) + 0.5);
    c.lineTo(w, Math.round(yOf(db)) + 0.5);
    c.stroke();
  }
  // Fast up, slow down: a peak is readable instead of flickering.
  c.beginPath();
  c.moveTo(0, h);
  for (let x = 0; x < w; x++) {
    const v = Number.isFinite(p.cols[x]) ? p.cols[x] : DB_LO;
    p.shown[x] = v > p.shown[x] ? v : Math.max(v, p.shown[x] - 1.2);
    c.lineTo(x, yOf(p.shown[x]));
  }
  c.lineTo(w, h);
  c.closePath();
  c.fillStyle = "rgba(92, 200, 255, 0.22)";
  c.fill();
  c.strokeStyle = "#5cc8ff";
  c.lineWidth = 1;
  c.stroke();

  const report = engine.loudness;
  if (report) {
    for (const key of ["momentary", "shortTerm", "integrated", "truePeak"]) {
      const v = report[key];
      p.lu[key].textContent = Number.isFinite(v) ? v.toFixed(1) : "–";
    }
    p.lu.truePeak.style.color = report.truePeak > 0 ? "#e5484d" : "";
  }

  // Correlation, from the time-domain blocks the engine has just read for the meters.
  const k = correlation(m.bufL, m.bufR);
  if (k === null) {
    p.corrFill.style.width = "0";
    p.corrVal.textContent = "–";
  } else {
    p.corr += (k - p.corr) * 0.2;
    const half = Math.abs(p.corr) * 50;
    p.corrFill.style.left = p.corr >= 0 ? "50%" : `${50 - half}%`;
    p.corrFill.style.width = `${half}%`;
    p.corrFill.style.background = p.corr >= 0 ? "#4ec98f" : "#e5484d";
    p.corrVal.textContent = `${p.corr >= 0 ? "+" : ""}${p.corr.toFixed(2)}`;
  }
}

/** What the panel is showing right now, for tests and the console. */
export const analyzerState = () =>
  panel ? { open: panel.prefs.open, tilt: panel.prefs.tilt, corr: panel.corr, columns: panel.shown, loudness: Object.fromEntries(Object.entries(panel.lu).map(([k, e]) => [k, e.textContent])) } : null;
