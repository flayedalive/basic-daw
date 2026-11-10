import test from "node:test";
import assert from "node:assert/strict";
import { trackPitch } from "../../src/audio/pitchtrack.js";
import { pitchMarks, shiftPitch, vocalStretch } from "../../src/audio/pitchshift.js";
import { sing, addConsonant, formantGain, SR } from "./voice.mjs";
import { rms, db, diffDb, tone } from "./helpers.mjs";

const semis = (st) => Math.pow(2, st / 12);
const constant = (track, ratio) => new Float32Array(track.frames).fill(ratio);
/** Median pitch (MIDI) of `x` between two times. */
function pitchOf(x, from, to) {
  const t = trackPitch(x, SR);
  const v = [];
  for (let f = Math.ceil(from / t.hop); f <= Math.floor(to / t.hop); f++) if (!Number.isNaN(t.midi[f])) v.push(t.midi[f]);
  v.sort((a, b) => a - b);
  return { median: v[v.length >> 1], spread: v.at(-1) - v[0], voiced: v.length, track: t };
}
/**
 * How well the harmonics of `x` (fundamental `hz`) follow the formant envelope
 * the voice was made with, when that envelope is taken to have been scaled in
 * frequency by `scale`: RMS deviation in dB over the first harmonics up to
 * 3 kHz. A formant-preserving shift fits scale 1; resampling fits the ratio.
 */
function envelopeFit(x, hz, scale, from, to) {
  const got = [];
  const want = [];
  for (let h = 1; h * hz < 3000; h++) {
    got.push(db(tone(x, SR, h * hz, from, to)));
    want.push(db(formantGain((h * hz) / scale) / h));
  }
  const offset = got.reduce((s, v, i) => s + v - want[i], 0) / got.length;
  return Math.sqrt(got.reduce((s, v, i) => s + (v - want[i] - offset) ** 2, 0) / got.length);
}

/** Largest sample-to-sample jump: a click shows up here. */
const maxStep = (x, from = 0, to = x.length) => {
  let m = 0;
  for (let i = from + 1; i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
};

/** Two sung notes with a consonant between them and a breath before. */
function phrase() {
  const { x } = sing(2.2, (t) => (t < 0.25 || (t > 1.05 && t < 1.2) || t > 2 ? NaN : t < 1.1 ? 57 + 0.2 * Math.sin(2 * Math.PI * 5 * t) : 60), { breath: 0.001 });
  addConsonant(x, 1.11, 0.08);
  addConsonant(x, 0.12, 0.1, 0.05, 9);
  return x;
}

test("pitch marks: one per period through a note, evenly through the rest", () => {
  const { x } = sing(1, (t) => (t < 0.2 || t > 0.8 ? NaN : 57));
  const track = trackPitch(x, SR);
  const { marks, voiced } = pitchMarks(x, SR, track);
  const period = SR / 220;
  let worst = 0;
  let count = 0;
  for (let k = 1; k < marks.length; k++) {
    assert.ok(marks[k] > marks[k - 1], "marks must ascend");
    if (voiced[k] && voiced[k - 1]) {
      worst = Math.max(worst, Math.abs(marks[k] - marks[k - 1] - period));
      count++;
    }
  }
  assert.ok(count > 110 && count < 150, `${count} voiced periods in 0.6 s of 220 Hz`);
  // Through the body of the note the spacing is the period to a fraction of a
  // sample; at its faded edges, where the waveform is changing shape, less so.
  let steady = 0;
  for (let k = 1; k < marks.length; k++) if (marks[k - 1] > 0.3 * SR && marks[k] < 0.7 * SR) steady = Math.max(steady, Math.abs(marks[k] - marks[k - 1] - period));
  assert.ok(steady < 0.5, `in the body of the note a mark is ${steady.toFixed(2)} samples off the period`);
  assert.ok(worst < period * 0.15, `a voiced mark is ${worst.toFixed(1)} samples off the period (${period.toFixed(1)})`);
  assert.equal(marks[0], 0);
  assert.equal(marks.at(-1), x.length - 1);
});

test("a ratio of 1.0 nulls against the input", () => {
  const x = phrase();
  const track = trackPitch(x, SR);
  const y = shiftPitch([x], SR, track, constant(track, 1))[0];
  const d = diffDb(x, y);
  assert.ok(d < -120, `differs by ${d.toFixed(1)} dB`);
});

test("±2 semitones: the pitch lands, the level holds, nothing clicks", () => {
  const { x } = sing(1.5, (t) => (t < 0.15 || t > 1.35 ? NaN : 57));
  const track = trackPitch(x, SR);
  const ref = maxStep(x);
  for (const st of [-2, -1, 1, 2]) {
    const y = shiftPitch([x], SR, track, constant(track, semis(st)))[0];
    assert.equal(y.length, x.length);
    const p = pitchOf(y, 0.3, 1.2);
    assert.ok(Math.abs(p.median - (57 + st)) * 100 < 5, `${st} st: landed ${((p.median - 57 - st) * 100).toFixed(1)} cents off`);
    assert.ok(p.spread * 100 < 10, `${st} st: pitch wanders over ${(p.spread * 100).toFixed(1)} cents`);
    // Level in 20 ms blocks across the sustained part.
    let lo = Infinity;
    let hi = 0;
    for (let b = Math.ceil(0.3 * SR / 960); b < Math.floor(1.2 * SR / 960); b++) {
      const v = rms(y, b * 960, (b + 1) * 960);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    assert.ok(db(hi / lo) < 1, `${st} st: level ripples ${db(hi / lo).toFixed(2)} dB`);
    assert.ok(Math.abs(db(rms(y, 0.3 * SR, 1.2 * SR) / rms(x, 0.3 * SR, 1.2 * SR))) < 1.5, `${st} st: level changed`);
    assert.ok(maxStep(y) < ref * 1.6, `${st} st: a jump of ${maxStep(y).toFixed(3)} (source max ${ref.toFixed(3)})`);
  }
});

test("formants stay where they were (resampling would move them with the pitch)", () => {
  const { x } = sing(1.2, () => 52);
  const track = trackPitch(x, SR);
  const y = shiftPitch([x], SR, track, constant(track, semis(4)))[0];
  const a = Math.round(0.3 * SR);
  const b = Math.round(0.9 * SR);
  const hz = 440 * Math.pow(2, (56 - 69) / 12);
  const kept = envelopeFit(y, hz, 1, a, b);
  const moved = envelopeFit(y, hz, semis(4), a, b);
  assert.ok(kept < 3 && moved > kept * 2, `harmonics fit the original envelope to ${kept.toFixed(1)} dB, a shifted one to ${moved.toFixed(1)} dB`);
});

test("a ratio curve flattens vibrato and a drifting note", () => {
  // A note that starts 40 cents flat, drifts up, with vibrato on top.
  const truth = (t) => 59.6 + 0.3 * t + 0.25 * Math.sin(2 * Math.PI * 5.5 * t);
  const { x } = sing(1.5, (t) => (t < 0.1 || t > 1.4 ? NaN : truth(t)));
  const track = trackPitch(x, SR);
  const ratios = new Float32Array(track.frames).fill(1);
  for (let f = 0; f < track.frames; f++) if (!Number.isNaN(track.midi[f])) ratios[f] = semis(60 - track.midi[f]);
  const y = shiftPitch([x], SR, track, ratios)[0];
  const p = pitchOf(y, 0.25, 1.25);
  assert.ok(Math.abs(p.median - 60) * 100 < 3, `centre ${((p.median - 60) * 100).toFixed(1)} cents from the target`);
  assert.ok(p.spread * 100 < 12, `still wanders over ${(p.spread * 100).toFixed(1)} cents (was ~80)`);
});

test("consonants and breaths pass through untouched while the notes around them move", () => {
  const x = phrase();
  const track = trackPitch(x, SR);
  const y = shiftPitch([x], SR, track, constant(track, semis(2)))[0];
  // The middle of the consonant and of the opening breath: bit-for-bit the input.
  for (const [a, b] of [[1.14, 1.17], [0.13, 0.2]]) {
    for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) assert.ok(Math.abs(y[i] - x[i]) < 1e-6, `sample at ${(i / SR).toFixed(3)}s changed`);
  }
  assert.ok(Math.abs(pitchOf(y, 1.4, 1.9).median - 62) * 100 < 6);
});

test("stereo: both channels get the same grains", () => {
  const { x } = sing(0.8, () => 57);
  const r = x.map((v) => v * 0.5);
  const track = trackPitch(x, SR);
  const [yl, yr] = shiftPitch([x, r], SR, track, constant(track, semis(1)));
  for (let i = 0; i < yl.length; i += 7) assert.ok(Math.abs(yl[i] * 0.5 - yr[i]) < 1e-6);
});

test("vocal stretch: length changes, pitch and formants do not; with semitones the pitch moves alone", () => {
  const x = phrase();
  for (const ratio of [0.8, 1.25]) {
    const y = vocalStretch([x], SR, { ratio })[0];
    assert.equal(y.length, Math.round(x.length * ratio));
    const p = pitchOf(y, 0.5 * ratio, 0.9 * ratio);
    assert.ok(Math.abs(p.median - 57) * 100 < 8, `ratio ${ratio}: pitch ${((p.median - 57) * 100).toFixed(1)} cents off`);
    const q = pitchOf(y, 1.4 * ratio, 1.9 * ratio);
    assert.ok(Math.abs(q.median - 60) * 100 < 6, `ratio ${ratio}: second note ${((q.median - 60) * 100).toFixed(1)} cents off (timing slipped?)`);
    const fit = envelopeFit(y, 440 * Math.pow(2, (60 - 69) / 12), 1, Math.round(1.4 * ratio * SR), Math.round(1.8 * ratio * SR));
    assert.ok(fit < 3, `ratio ${ratio}: harmonics are ${fit.toFixed(1)} dB off the original envelope`);
  }
  const up = vocalStretch([x], SR, { ratio: 1, semitones: 3 })[0];
  assert.equal(up.length, x.length);
  assert.ok(Math.abs(pitchOf(up, 1.4, 1.9).median - 63) * 100 < 6);
  const hz63 = 440 * Math.pow(2, (63 - 69) / 12);
  assert.ok(envelopeFit(up, hz63, 1, Math.round(1.4 * SR), Math.round(1.8 * SR)) < 3, "formants moved with the pitch");
});
