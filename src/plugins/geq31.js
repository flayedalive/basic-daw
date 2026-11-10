// 31-band graphic EQ: one peaking biquad per ISO third-octave centre.
//
// It is a JS plugin only because of its face — thirty-one slider rows would be
// unusable, so the inspector mounts a slider bank for it (src/ui/geq.js). The
// audio is a plain series of native filters, and a band at 0 dB is an exact
// passthrough, so flat settings null against the dry signal.

import { dbToGain } from "../util.js";
import { setAudioParam } from "./dsp.js";

const ISO = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];

/** Third-octave constant Q: sqrt(2^(1/3)) / (2^(1/3) - 1). */
export const GEQ31_Q = 4.318;

const label = (hz) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
/** { key, hz, label } per band. Keys are what a saved project stores: never rename one. */
export const GEQ31_BANDS = ISO.map((hz) => ({ key: `hz${label(hz).replace(".", "_")}`, hz, label: label(hz) }));

export const geq31Plugin = {
  id: "core.geq31",
  name: "Graphic EQ (31-band)",
  category: "EQ / Filter",
  description: "Third-octave bands at the ISO centres, ±12 dB each. Drag across the bank to draw a curve; double-click a band to zero it.",
  params: [
    ...GEQ31_BANDS.map((b) => ({ key: b.key, label: b.label, min: -12, max: 12, def: 0, unit: "dB", prec: 1 })),
    { key: "out", label: "Output", min: -12, max: 12, def: 0, unit: "dB", prec: 1 },
  ],

  create(ctx, offline) {
    const top = ctx.sampleRate / 2 - 100;
    const filters = GEQ31_BANDS.map((b) => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      // The 20 kHz band of a 44.1 kHz context still sits under Nyquist; this
      // only guards odd, lower rates.
      f.frequency.value = Math.min(b.hz, top);
      f.Q.value = GEQ31_Q;
      return f;
    });
    const out = ctx.createGain();
    filters.reduce((a, b) => (a.connect(b), b)).connect(out);
    return {
      input: filters[0],
      output: out,
      update(p) {
        GEQ31_BANDS.forEach((b, i) => setAudioParam(ctx, filters[i].gain, p[b.key] ?? 0, offline));
        setAudioParam(ctx, out.gain, dbToGain(p.out ?? 0), offline);
      },
    };
  },
};
