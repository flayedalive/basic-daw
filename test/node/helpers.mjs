// Shared by the Node tests: signal generators and measurements, no DOM.

export const sine = (n, sr, hz, amp = 1, phase = 0) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr + phase));

export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const noise = (n, amp = 1, seed = 1) => {
  const r = rng(seed);
  return Float32Array.from({ length: n }, () => amp * (r() * 2 - 1));
};

export const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

export const peak = (x, from = 0, to = x.length) => {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]));
  return p;
};

export const db = (v) => 20 * Math.log10(Math.max(v, 1e-12));

/** Amplitude of one frequency (Goertzel). */
export function tone(x, sr, hz, from = 0, to = x.length) {
  const c = 2 * Math.cos((2 * Math.PI * hz) / sr);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s0 = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return (2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2))) / (to - from);
}

/** Peak of a - b in dB over [from, to). */
export function diffDb(a, b, from = 0, to = Math.min(a.length, b.length)) {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(a[i] - b[i]));
  return db(p);
}
