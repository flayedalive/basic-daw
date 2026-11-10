// The correction model: from notes and settings to a corrected pitch curve.
//
// Each note's pitch is taken apart into a slow part — where the note sits and
// how it drifts — and a fast part, its vibrato. The two are corrected
// separately, which is the whole trick: pull the slow part to the target and
// leave the fast part alone, and a note lands in tune still sounding sung.
//
// Per note (any of them falling back to the clip-wide setting):
//
//   target      the pitch to correct to — the nearest note of the key and
//               scale by default, or wherever the note was dragged
//   amount      0 … 1, how much of the error to remove
//   variance    cents either side of the target that count as in tune; only
//               what lies beyond is corrected, so a note inside is untouched
//   speed       ms for the correction to take hold from the note's onset;
//               0 is immediate (and robotic), slower keeps the natural scoop
//   vibrato     0 … 1, how much of the vibrato to keep
//   transition  ms over which the correction changes from one note's to the next
//
// No DOM, no Web Audio.

export const SCALES = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
};
export const KEYS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** Clip-wide defaults: what "Edit pitch…" starts from. */
export const DEFAULT_EDIT = { key: 0, scale: "chromatic", amount: 1, variance: 0, speed: 30, vibrato: 1, transition: 60 };
const FIELDS = ["amount", "variance", "speed", "vibrato", "transition"];

/** The note of `key`/`scale` nearest to a fractional MIDI pitch. */
export function snapToScale(midi, key = 0, scale = "chromatic") {
  const steps = SCALES[scale] ?? SCALES.chromatic;
  let best = Math.round(midi);
  let bestD = Infinity;
  for (let m = Math.floor(midi) - 6; m <= Math.ceil(midi) + 6; m++) {
    if (!steps.includes((((m - key) % 12) + 12) % 12)) continue;
    const d = Math.abs(m - midi);
    if (d < bestD - 1e-9) (bestD = d), (best = m);
  }
  return best;
}

/** A note's effective settings: its own where set, the clip's otherwise. */
export function noteSettings(note, edit = {}) {
  const own = edit.notes?.[note.id] ?? {};
  const out = {};
  for (const k of FIELDS) out[k] = own[k] ?? edit[k] ?? DEFAULT_EDIT[k];
  out.target = own.target ?? snapToScale(note.center, edit.key ?? 0, edit.scale ?? "chromatic");
  out.manual = own.target != null;
  return out;
}

/**
 * The corrected curve.
 * Returns { midi: Float32Array (corrected pitch per frame, NaN where unvoiced),
 *           ratios: Float32Array (pitch ratio per frame, 1 where unvoiced) }.
 */
export function correctedCurve(track, notes, edit = {}) {
  const { hop, frames } = track;
  const raw = track.midi;
  const slow = new Float32Array(frames); // correction to the slow part, semitones
  const fast = new Float32Array(frames); // correction to the vibrato, semitones
  const half = Math.round(0.09 / hop); // the slow part: a moving average over ~180 ms

  notes.forEach((note) => {
    const s = noteSettings(note, edit);
    const dead = s.variance / 100;
    // Running mean of the raw pitch within the note.
    let acc = 0;
    let lo = note.start;
    let hi = note.start;
    for (let f = note.start; f < note.end; f++) {
      const from = Math.max(note.start, f - half);
      const to = Math.min(note.end, f + half + 1);
      while (hi < to) acc += raw[hi++];
      while (lo < from) acc -= raw[lo++];
      const smooth = acc / (hi - lo);
      const error = smooth - s.target;
      const beyond = error - Math.max(-dead, Math.min(dead, error));
      const sinceOnset = (f - note.start) * hop * 1000;
      const taken = s.speed > 0 ? 1 - Math.exp((-3 * sinceOnset) / s.speed) : 1;
      slow[f] = -s.amount * taken * beyond;
      fast[f] = (s.vibrato - 1) * (raw[f] - smooth);
    }
  });

  // Between two notes that touch, the slow correction jumps. Spread the jump
  // over the transition time, half each side of the boundary.
  for (let i = 1; i < notes.length; i++) {
    const a = notes[i - 1];
    const b = notes[i];
    if (a.end !== b.start) continue;
    const t = noteSettings(b, edit).transition;
    const h = Math.min(Math.round(t / 2000 / hop), Math.floor((a.end - a.start) / 2), Math.floor((b.end - b.start) / 2));
    if (h < 1) continue;
    const jump = slow[b.start] - slow[a.end - 1];
    for (let k = 0; k < h; k++) {
      const w = (k + 0.5) / (2 * h); // 0 → 0.5 across the first half
      slow[a.end - h + k] += jump * w;
      slow[b.start + k] -= jump * (0.5 - w);
    }
  }

  const midi = new Float32Array(frames).fill(NaN);
  const ratios = new Float32Array(frames).fill(1);
  for (const note of notes) {
    for (let f = note.start; f < note.end; f++) {
      const c = Math.max(-12, Math.min(12, slow[f] + fast[f]));
      midi[f] = raw[f] + c;
      ratios[f] = Math.abs(c) < 1e-6 ? 1 : Math.pow(2, c / 12);
    }
  }
  return { midi, ratios };
}

/** A fresh edit: the clip-wide defaults and no per-note overrides. */
export const newEdit = (over = {}) => ({ ...DEFAULT_EDIT, notes: {}, cuts: [], joins: [], ...over });
