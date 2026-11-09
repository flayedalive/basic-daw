// Chromatic tuner insert.
//
// Audio passes straight through (or is muted while you tune); a side path
// low-passes the signal into an analyser, and `tick` runs pitch detection off
// the UI frame loop. That is the one legitimate use of `tick` for a JS plugin:
// nothing the tuner measures changes the sound, so an offline bounce — which
// never calls `tick` — renders exactly what playback does. Offline, the side
// path is not even built.
//
// To tune an instrument that is being input, arm its track and turn on
// monitoring: that is what routes the interface input into the track's inserts.

import { clamp } from "../util.js";
import { setAudioParam } from "./dsp.js";
import { detectPitch, refinePitch, noteFromHz, PitchTracker } from "./pitch.js";

const MIN_HZ = 27; // A0, and below a 5-string bass's low B (30.9 Hz)
const MAX_HZ = 1500; // fundamentals, not harmonics
const DETECT_HZ = 30; // detections per second; the needle is smoothed between
const DECIMATE_TO = 12000; // detector sample rate (approximate)

export const tunerPlugin = {
  id: "core.tuner",
  name: "Tuner",
  category: "Utility",
  description:
    "Chromatic tuner. To tune an instrument you're plugging in, arm the track and turn on input monitoring; it also reads whatever is playing through the track.",
  params: [
    { key: "mute", label: "Mute out", bool: true, def: false, hint: "Silence this insert's output while you tune. The tuner keeps listening." },
    { key: "ref", label: "A4 ref", min: 415, max: 466, def: 440, unit: "Hz", prec: 1 },
    { key: "names", label: "Names", choices: ["sharps", "flats"], def: "sharps" },
    { key: "gate", label: "Gate", min: -90, max: -20, def: -60, unit: "dB", hint: "Input quieter than this is ignored." },
  ],

  create(ctx, offline) {
    const input = ctx.createGain();
    const out = ctx.createGain();
    input.connect(out);

    let params = { mute: false, ref: 440, names: "sharps", gate: -60 };
    const handle = {
      input,
      output: out,
      update(p) {
        params = p;
        setAudioParam(ctx, out.gain, p.mute ? 0 : 1, offline);
      },
    };
    if (offline) return handle;

    // Detector side path: sum to mono, two Butterworth low-passes as the
    // anti-alias filter for decimation (biquad lowpass Q is in dB in Web Audio;
    // -3.01 dB is a Butterworth Q of 0.707), then an analyser to read from.
    const mono = ctx.createGain();
    mono.channelCount = 1;
    mono.channelCountMode = "explicit";
    mono.channelInterpretation = "speakers";
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    for (const f of [lp1, lp2]) {
      f.type = "lowpass";
      f.frequency.value = 3000;
      f.Q.value = -3.0103;
    }
    const decim = Math.max(1, Math.round(ctx.sampleRate / DECIMATE_TO));
    const rate = ctx.sampleRate / decim;
    // Three periods of the lowest note: one for the integration window plus
    // the largest lag, with room to spare.
    const need = Math.ceil(rate / MIN_HZ) * 3;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = clamp(2 ** Math.ceil(Math.log2(need * decim)), 2048, 32768);
    input.connect(mono).connect(lp1).connect(lp2).connect(analyser);

    const full = new Float32Array(analyser.fftSize);
    const dec = new Float32Array(Math.floor(full.length / decim));
    const tracker = new PitchTracker();
    let acc = 0;
    let shown = { active: false, held: false, level: -Infinity };

    handle.tick = (dt) => {
      acc += dt;
      if (acc < 1 / DETECT_HZ) return;
      const step = acc;
      acc = 0;
      analyser.getFloatTimeDomainData(full);
      // Decimate from the end so the newest audio is always included.
      const off = full.length - dec.length * decim;
      for (let i = 0; i < dec.length; i++) dec[i] = full[off + i * decim];
      const raw = detectPitch(dec, rate, { minHz: MIN_HZ, maxHz: MAX_HZ });
      if (raw.hz > 0) raw.hz = refinePitch(full.subarray(off), ctx.sampleRate, raw.hz);
      // The analyser sees the post-filter signal; that is within a dB of the
      // input for anything with a fundamental below 3 kHz.
      tracker.push(raw, step, params.gate);
      const r = tracker.reading();
      if (!r.hz) {
        shown = { active: false, held: false, level: r.level };
        return;
      }
      shown = { active: true, held: r.held, level: r.level, hz: r.hz, ...noteFromHz(r.hz, params.ref, params.names) };
    };
    /** What the inspector draws: { active, held, level, hz?, name?, octave?, cents? } */
    handle.reading = () => shown;
    handle.readout = () => (shown.active ? shown.cents : 0);
    handle.dispose = () => {
      try {
        input.disconnect(mono);
      } catch {
        /* already torn down */
      }
      mono.disconnect();
      lp1.disconnect();
      lp2.disconnect();
    };
    return handle;
  },
};
