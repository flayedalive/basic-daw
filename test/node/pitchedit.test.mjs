// Note segmentation and the correction model, and the two together with the
// shifter: a sung phrase in, a corrected phrase out.

import test from "node:test";
import assert from "node:assert/strict";
import { trackPitch } from "../../src/audio/pitchtrack.js";
import { segmentNotes } from "../../src/audio/pitchnotes.js";
import { correctedCurve, snapToScale, noteSettings, newEdit } from "../../src/audio/pitchcorrect.js";
import { shiftPitch } from "../../src/audio/pitchshift.js";
import { sing, addConsonant, SR } from "./voice.mjs";
import { diffDb } from "./helpers.mjs";

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(3)}, expected ${b} ±${tol}`);
/** Median tracked pitch between two times. */
function pitchIn(track, from, to) {
  const v = [];
  for (let f = Math.ceil(from / track.hop); f <= Math.floor(to / track.hop); f++) if (!Number.isNaN(track.midi[f])) v.push(track.midi[f]);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  v.sort((a, b) => a - b);
  return { median: v[v.length >> 1], mean, spread: v.length ? v.at(-1) - v[0] : NaN };
}

/**
 * A phrase with one of everything: a flat note with vibrato, a legato step up
 * through a glide, a sharp note after a consonant, then the same pitch twice.
 *   0.20–0.90  A3 (57), 30 cents flat, vibrato ±25 cents
 *   0.90–0.98  glide up to…
 *   0.98–1.60  C4 (60), 20 cents sharp
 *   1.60–1.75  consonant
 *   1.75–2.30  D4 (62), 35 cents sharp
 *   2.30–2.34  a dip in level, then
 *   2.34–2.90  D4 again, in tune
 */
function phrase() {
  const midiAt = (t) => {
    if (t < 0.2 || (t >= 1.6 && t < 1.75) || t >= 2.9) return NaN;
    if (t < 0.9) return 56.7 + 0.25 * Math.sin(2 * Math.PI * 5.5 * t);
    if (t < 0.98) return 56.7 + ((60.2 - 56.7) * (t - 0.9)) / 0.08;
    if (t < 1.6) return 60.2;
    if (t < 2.3) return 62.35;
    return 62;
  };
  const { x } = sing(3.1, midiAt);
  // The repeated note: duck the level briefly at 2.30–2.34.
  for (let i = Math.round(2.27 * SR); i < Math.round(2.37 * SR); i++) {
    const t = i / SR;
    x[i] *= 1 - 0.92 * Math.exp(-(((t - 2.32) / 0.015) ** 2));
  }
  addConsonant(x, 1.63, 0.09);
  return { x, midiAt };
}

const P = phrase();
const TRACK = trackPitch(P.x, SR);
const NOTES = segmentNotes(TRACK);

test("segmentation: four notes become four notes, with the glide given to the note it arrives at", () => {
  assert.equal(NOTES.length, 4, `found ${NOTES.length}: ${NOTES.map((n) => `${n.startSec.toFixed(2)}–${n.endSec.toFixed(2)} @${n.center.toFixed(2)}`).join(", ")}`);
  const [a, b, c, d] = NOTES;
  near(a.center, 56.7, 0.05, "note 1 centre");
  near(b.center, 60.2, 0.05, "note 2 centre");
  near(c.center, 62.35, 0.05, "note 3 centre");
  near(d.center, 62, 0.05, "note 4 centre");
  near(a.startSec, 0.2, 0.03, "note 1 start");
  // The boundary sits at the start of the glide (0.90), not its end (0.98).
  near(b.startSec, 0.9, 0.03, "note 2 start");
  assert.equal(a.end, b.start, "legato notes should touch");
  near(c.startSec, 1.75, 0.04, "note 3 start (after the consonant)");
  assert.ok(c.start > b.end, "the consonant should leave a gap");
  near(d.startSec, 2.32, 0.03, "note 4 start (the repeat)");
});

test("segmentation: vibrato is measured, not split", () => {
  const [a, b] = NOTES;
  near(a.vibrato.depth, 25, 5, "vibrato depth, cents");
  near(a.vibrato.rate, 5.5, 0.8, "vibrato rate, Hz");
  assert.ok(b.vibrato.depth < 5, `a straight note reads ${b.vibrato.depth.toFixed(1)} cents of vibrato`);
  // Wide vibrato, ±80 cents, on its own: still one note.
  const wide = sing(1.6, (t) => (t < 0.1 || t > 1.5 ? NaN : 60 + 0.8 * Math.sin(2 * Math.PI * 6 * t)));
  const notes = segmentNotes(trackPitch(wide.x, SR));
  assert.equal(notes.length, 1, `±80 cent vibrato was split into ${notes.length}`);
  near(notes[0].center, 60, 0.15, "its centre");
});

test("segmentation: drift is reported; cuts and joins override the guess", () => {
  const sliding = sing(1.2, (t) => (t < 0.1 || t > 1.1 ? NaN : 60 - 0.2 + 0.4 * (t - 0.1)));
  const tr = trackPitch(sliding.x, SR);
  const [n] = segmentNotes(tr);
  assert.ok(n.drift > 20 && n.drift < 45, `drift ${n.drift.toFixed(1)} cents over the note`);
  const cut = Math.round(0.6 / tr.hop);
  const two = segmentNotes(tr, { cuts: [cut] });
  assert.equal(two.length, 2);
  assert.equal(two[1].start, cut);
  // Joining the legato pair in the phrase makes one note of them.
  const joined = segmentNotes(TRACK, { joins: [NOTES[1].start] });
  assert.equal(joined.length, 3);
  assert.equal(joined[0].end, NOTES[1].end);
  // A join cannot bridge a gap: there is no sound there to join through.
  assert.equal(segmentNotes(TRACK, { joins: [NOTES[2].start] }).length, 4);
});

test("snapToScale and per-note settings", () => {
  assert.equal(snapToScale(60.4), 60);
  assert.equal(snapToScale(60.6), 61);
  assert.equal(snapToScale(61.2, 0, "major"), 62, "C♯ is not in C major: nearest is D… or C");
  assert.equal(snapToScale(60.9, 0, "major"), 60);
  assert.equal(snapToScale(63.1, 9, "minor"), 64, "A minor has E, not E♭");
  const edit = newEdit({ amount: 0.5, notes: { [NOTES[0].id]: { target: 58, vibrato: 0 } } });
  const own = noteSettings(NOTES[0], edit);
  assert.deepEqual([own.target, own.vibrato, own.amount, own.manual], [58, 0, 0.5, true]);
  assert.equal(noteSettings(NOTES[1], edit).target, 60);
});

test("correct to key: every note lands on its target, vibrato kept", () => {
  const { ratios, midi } = correctedCurve(TRACK, NOTES, newEdit({ speed: 0 }));
  const y = shiftPitch([P.x], SR, TRACK, ratios)[0];
  const out = trackPitch(y, SR);
  for (const [from, to, want] of [[1.15, 1.5, 60], [1.9, 2.2, 62], [2.45, 2.8, 62]]) {
    near(pitchIn(out, from, to).median, want, 0.04, `note at ${from}s`);
  }
  // The note with vibrato: its mean over two whole cycles is the centre.
  near(pitchIn(out, 0.4, 0.4 + 2 / 5.5).mean, 57, 0.04, "note with vibrato");
  // Vibrato survives on the first note: still ~±25 cents around the new centre.
  const v = pitchIn(out, 0.35, 0.8);
  assert.ok(v.spread * 50 > 18 && v.spread * 50 < 32, `vibrato after correction ±${(v.spread * 50).toFixed(1)} cents`);
  // The model's own curve says the same.
  near(pitchIn({ midi, hop: TRACK.hop }, 1.15, 1.5).median, 60, 0.01, "model curve, note 2");
});

test("amount, variance, vibrato and speed each do what they say", () => {
  const curve = (over) => correctedCurve(TRACK, NOTES, newEdit({ speed: 0, ...over }));
  const at = (c, from, to) => pitchIn({ midi: c.midi, hop: TRACK.hop }, from, to);
  // Amount 0.5: half the error remains (note 3 was 35 cents sharp).
  near(at(curve({ amount: 0.5 }), 1.9, 2.2).median, 62.175, 0.01, "half amount");
  // Variance 25 cents: note 2 (20 sharp) is left alone — ratio exactly 1 — and
  // note 3 (35 sharp) is pulled to the edge of the band, not to the target.
  const tol = curve({ variance: 25 });
  for (let f = NOTES[1].start + 30; f < NOTES[1].end - 5; f++) assert.equal(tol.ratios[f], 1, `frame ${f} of an in-tolerance note was corrected`);
  near(at(tol, 1.9, 2.2).median, 62.25, 0.01, "out-of-tolerance note stops at the band edge");
  // Vibrato 0 flattens it; 1 keeps it.
  assert.ok(at(curve({ vibrato: 0 }), 0.35, 0.8).spread * 50 < 4, "vibrato 0 should flatten");
  assert.ok(at(curve({ vibrato: 1 }), 0.35, 0.8).spread * 50 > 20, "vibrato 1 should keep");
  // Speed 200 ms: 50 ms into note 3 most of the error is still there; by 250 ms it is gone.
  const slow = curve({ speed: 200 });
  const s3 = NOTES[2].startSec;
  assert.ok(at(slow, s3 + 0.04, s3 + 0.06).median > 62.1, "correction arrived too early");
  near(at(slow, s3 + 0.3, s3 + 0.4).median, 62, 0.02, "correction did not arrive");
});

test("a dragged target wins over the scale, and the transition between notes is smooth", () => {
  const edit = newEdit({ speed: 0, transition: 80, notes: { [NOTES[1].id]: { target: 59 } } });
  const { midi, ratios } = correctedCurve(TRACK, NOTES, edit);
  near(pitchIn({ midi, hop: TRACK.hop }, 1.15, 1.5).median, 59, 0.01, "dragged note");
  // Across the legato boundary the correction (in cents) never jumps: it ramps.
  let worst = 0;
  for (let f = NOTES[1].start - 12; f < NOTES[1].start + 12; f++) worst = Math.max(worst, Math.abs(1200 * Math.log2(ratios[f + 1] / ratios[f])));
  assert.ok(worst < 25, `correction jumps ${worst.toFixed(1)} cents between frames at the boundary`);
  const abrupt = correctedCurve(TRACK, NOTES, { ...edit, transition: 0 });
  let jump = 0;
  for (let f = NOTES[1].start - 2; f < NOTES[1].start + 2; f++) jump = Math.max(jump, Math.abs(1200 * Math.log2(abrupt.ratios[f + 1] / abrupt.ratios[f])));
  assert.ok(jump > worst * 2, "with no transition time the same boundary should jump");
});

test("nothing to correct means nothing changes: an in-tune phrase comes back identical", () => {
  const { x } = sing(1.2, (t) => (t < 0.1 || t > 1.1 ? NaN : t < 0.6 ? 60 : 64));
  const tr = trackPitch(x, SR);
  const { ratios } = correctedCurve(tr, segmentNotes(tr), newEdit({ variance: 5 }));
  const y = shiftPitch([x], SR, tr, ratios)[0];
  assert.ok(diffDb(x, y) < -120, `changed by ${diffDb(x, y).toFixed(1)} dB`);
});
