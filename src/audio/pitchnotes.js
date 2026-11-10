// From a pitch track to notes.
//
// The pitch editor shows a performance as notes, because that is how a singer
// and an editor both think of it. A note here is a stretch of voiced sound
// around one pitch. The track is split
//
//   - at unvoiced gaps (silence, breaths, consonants);
//   - where the pitch moves by more than about 50 cents and stays there — the
//     boundary is put where it *starts* to move, so a glide into a note belongs
//     to the note it arrives at;
//   - where the level dips and comes back at the same pitch: a repeated note.
//
// Vibrato must not split a note, so the "has it moved?" test runs on a median
// of the pitch over about one vibrato cycle rather than on the raw curve.
//
// Segmentation is a guess, and sometimes a wrong one; `cuts` and `joins` are
// the user's corrections to it (frames to split at, boundaries to remove).
//
// No DOM, no Web Audio.

const STEP = 0.5; // semitones: a move this big, sustained, is a new note
const LEAVE = 0.3; // semitones: where the pitch is taken to have left the old note

/**
 * opts: { cuts = [], joins = [], minLength = 0.05 s }
 * Returns notes in order, each {
 *   id        the frame it starts at — stable as long as the analysis is
 *   start, end            frames, end exclusive
 *   startSec, endSec
 *   center    median pitch of its body, fractional MIDI
 *   drift     cents the pitch slides from start to end (a line fitted to it)
 *   vibrato   { depth (cents, peak), rate (Hz) }
 *   level     mean dBFS
 * }
 */
export function segmentNotes(track, opts = {}) {
  const { midi, level, frames, hop } = track;
  const minLen = Math.max(2, Math.round((opts.minLength ?? 0.05) / hop));
  const half = Math.round(0.078 / hop); // median window either side: ~155 ms in all
  const hold = Math.max(2, Math.round(0.03 / hop)); // how long a move must last

  const bounds = new Set(); // frames at which a note starts
  const ends = new Map(); // start frame of a voiced run -> its end (exclusive)
  for (let f = 0; f < frames; ) {
    if (Number.isNaN(midi[f])) {
      f++;
      continue;
    }
    let e = f;
    while (e < frames && !Number.isNaN(midi[e])) e++;
    bounds.add(f);
    ends.set(f, e);
    splitRun(f, e);
    f = e;
  }

  function splitRun(a, b) {
    // Median-smoothed pitch across the run.
    const smooth = new Float32Array(b - a);
    const win = [];
    for (let f = a; f < b; f++) {
      win.length = 0;
      for (let k = Math.max(a, f - half); k < Math.min(b, f + half + 1); k++) win.push(midi[k]);
      win.sort((x, y) => x - y);
      smooth[f - a] = win[win.length >> 1];
    }

    // Pitch steps.
    let start = a;
    let sum = 0;
    let count = 0;
    let away = 0;
    for (let f = a; f < b; f++) {
      const s = smooth[f - a];
      const ref = count ? sum / count : s;
      if (f - start >= minLen && count && Math.abs(s - ref) > STEP) {
        away++;
        if (away >= hold) {
          // Walk back to where the raw pitch first left the old note for good.
          let cut = f - away + 1;
          while (cut - 1 > start + minLen && Math.abs(midi[cut - 1] - ref) > LEAVE) cut--;
          bounds.add(cut);
          start = cut;
          // The new note's reference pitch is gathered from here on — where
          // the pitch has arrived — not from the glide that led to it.
          sum = s;
          count = 1;
          away = 0;
        }
        continue;
      }
      away = 0;
      sum += s;
      count++;
    }

    // Repeated notes: a dip in level of 6 dB or more, with the level back up
    // on both sides within 80 ms.
    const reach = Math.round(0.08 / hop);
    for (let f = a + minLen; f < b - minLen; f++) {
      let isMin = true;
      let before = -Infinity;
      let after = -Infinity;
      for (let k = Math.max(a, f - reach); k <= Math.min(b - 1, f + reach); k++) {
        if (level[k] < level[f]) isMin = false;
        if (k < f) before = Math.max(before, level[k]);
        if (k > f) after = Math.max(after, level[k]);
      }
      if (isMin && before - level[f] >= 6 && after - level[f] >= 6) {
        bounds.add(f);
        f += reach;
      }
    }
  }

  // Build, then fold notes that are too short into a neighbour.
  const starts = [...bounds].sort((x, y) => x - y);
  const spans = [];
  let run = null;
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i];
    if (ends.has(s)) run = { start: s, end: ends.get(s) };
    const e = i + 1 < starts.length && starts[i + 1] < run.end ? starts[i + 1] : run.end;
    spans.push({ start: s, end: e, runStart: run.start });
  }
  for (let i = 0; i < spans.length; i++) {
    const n = spans[i];
    if (n.end - n.start >= minLen) continue;
    const prev = spans[i - 1];
    const next = spans[i + 1];
    if (prev && prev.end === n.start && prev.runStart === n.runStart) prev.end = n.end;
    else if (next && next.start === n.end && next.runStart === n.runStart) next.start = n.start;
    else if (n.end - n.start >= 2) continue; // an isolated blip: keep it rather than lose sound from the editor
    spans.splice(i--, 1);
  }

  // A short span that is all slope is a glide caught on its own (a slow one,
  // cut at both ends). It belongs to the note it arrives at.
  for (let i = 0; i < spans.length - 1; i++) {
    const n = spans[i];
    const next = spans[i + 1];
    if (next.start !== n.end || (n.end - n.start) * hop > 0.15) continue;
    if (Math.abs(midi[n.end - 1] - midi[n.start]) < 0.8) continue;
    next.start = n.start;
    spans.splice(i--, 1);
  }

  // Last, the user's corrections — applied to the finished guess, so they
  // refer to the notes the editor showed and nothing above can undo them.
  for (const f of opts.joins ?? []) {
    const i = spans.findIndex((n) => n.start === f);
    if (i > 0 && spans[i - 1].end === f) {
      spans[i - 1].end = spans[i].end;
      spans.splice(i, 1);
    }
  }
  for (const f of opts.cuts ?? []) {
    const i = spans.findIndex((n) => f > n.start && f < n.end);
    if (i >= 0) spans.splice(i + 1, 0, { start: f, end: spans[i].end, runStart: spans[i].runStart }), (spans[i].end = f);
  }

  return spans.map(({ start, end }) => describe(track, start, end));
}

/** Measure one note. */
function describe(track, start, end) {
  const { midi, level, hop } = track;
  const n = end - start;
  // The body: past the scoop (or the glide in) at the start, short of the fall
  // at the end. The scoop ends where the pitch first comes within 30 cents of
  // where the note as a whole sits.
  const all = Array.from(midi.subarray(start, end)).sort((a, b) => a - b);
  const rough = all[all.length >> 1];
  let settled = start;
  while (settled < start + Math.floor(n * 0.5) && Math.abs(midi[settled] - rough) > 0.3) settled++;
  const skip = Math.max(Math.min(Math.round(0.06 / hop), Math.floor(n * 0.25)), Math.min(Math.floor(n * 0.5), settled - start + Math.round(0.02 / hop)));
  const tail = Math.floor(n * 0.1);
  const body = [];
  for (let f = start + skip; f < end - tail; f++) body.push(midi[f]);
  if (!body.length) for (let f = start; f < end; f++) body.push(midi[f]);
  const sorted = [...body].sort((a, b) => a - b);
  const center = sorted[sorted.length >> 1];

  // Drift: slope of a least-squares line through the body, times its length.
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  body.forEach((y, i) => ((sx += i), (sy += y), (sxx += i * i), (sxy += i * y)));
  const den = body.length * sxx - sx * sx;
  const slope = den ? (body.length * sxy - sx * sy) / den : 0;
  const drift = slope * body.length * 100;

  // Vibrato: what is left after taking the line out.
  const mean = sy / body.length;
  let sq = 0;
  let crossings = 0;
  let prev = 0;
  body.forEach((y, i) => {
    const r = y - (mean + slope * (i - sx / body.length));
    sq += r * r;
    if (i && r * prev < 0) crossings++;
    if (r !== 0) prev = r;
  });
  const depth = Math.sqrt((2 * sq) / body.length) * 100;
  const rate = body.length > 4 ? crossings / 2 / (body.length * hop) : 0;

  let lv = 0;
  for (let f = start; f < end; f++) lv += level[f];
  return {
    id: start,
    start,
    end,
    startSec: start * hop,
    endSec: end * hop,
    center,
    drift,
    vibrato: { depth, rate: depth > 8 ? rate : 0 },
    level: lv / n,
  };
}
