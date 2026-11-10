// Noise gate processor.
//
// Stereo-linked: the louder channel decides, and both get the same gain, so
// the image does not wander as the gate works. With look-ahead the detector
// reads the input as it arrives while the audio itself is delayed, so the gate
// is already open when the attack it was opened by comes through.
//
// Every setting is an AudioParam. Parameters ride the render clock, which is
// what makes a bounce identical to playback; a message on the port would
// arrive whenever the main thread got round to it.

const MAX_LOOKAHEAD = 0.02; // seconds

class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    const k = (name, defaultValue, minValue, maxValue) => ({ name, defaultValue, minValue, maxValue, automationRate: "k-rate" });
    return [
      k("threshold", -45, -100, 0), // dBFS
      k("attack", 0.002, 0, 1), // seconds
      k("hold", 0.05, 0, 2),
      k("release", 0.12, 0.001, 5),
      k("lookahead", 0, 0, MAX_LOOKAHEAD),
      k("range", -100, -100, 0), // dB of attenuation when closed; -100 is silence
    ];
  }

  constructor() {
    super();
    let size = 256;
    while (size < MAX_LOOKAHEAD * sampleRate + 256) size <<= 1;
    this.mask = size - 1;
    this.delay = [new Float32Array(size), new Float32Array(size)];
    this.w = 0;
    this.gain = 0;
    this.open = false;
    this.holdLeft = 0;
    this.sinceMeter = 0;
  }

  process(inputs, outputs, params) {
    const inL = inputs[0][0];
    const inR = inputs[0][1] ?? inL;
    const outL = outputs[0][0];
    const outR = outputs[0][1];
    const n = outL.length;

    const openAt = Math.pow(10, params.threshold[0] / 20);
    const closeAt = openAt * 0.794; // 2 dB of hysteresis, so a level sitting on the threshold does not chatter
    const coef = (t) => (t <= 0 ? 1 : 1 - Math.exp(-1 / (t * sampleRate)));
    const up = coef(params.attack[0]);
    const down = coef(params.release[0]);
    const hold = Math.round(params.hold[0] * sampleRate);
    const look = Math.min(this.mask - 128, Math.round(params.lookahead[0] * sampleRate));
    const floor = params.range[0] <= -99.5 ? 0 : Math.pow(10, params.range[0] / 20);
    const { mask } = this;
    const dL = this.delay[0];
    const dR = this.delay[1];
    let { w, gain, open, holdLeft } = this;

    for (let i = 0; i < n; i++) {
      const l = inL ? inL[i] : 0;
      const r = inR ? inR[i] : 0;
      const level = Math.max(Math.abs(l), Math.abs(r));
      if (level >= (open ? closeAt : openAt)) {
        open = true;
        holdLeft = hold;
      } else if (holdLeft > 0) {
        holdLeft--;
      } else {
        open = false;
      }
      const target = open ? 1 : floor;
      gain += (target - gain) * (target > gain ? up : down);
      if (gain < 1e-7 && target === 0) gain = 0; // no denormals trailing off forever
      dL[w] = l;
      dR[w] = r;
      const rd = (w - look) & mask;
      outL[i] = dL[rd] * gain;
      if (outR) outR[i] = dR[rd] * gain;
      w = (w + 1) & mask;
    }
    this.w = w;
    this.gain = gain;
    this.open = open;
    this.holdLeft = holdLeft;

    // Metering only: how open the gate is, for the inspector.
    this.sinceMeter += n;
    if (this.sinceMeter >= 2048) {
      this.sinceMeter = 0;
      this.port.postMessage(gain);
    }
    return true;
  }
}

registerProcessor("daw-gate", GateProcessor);
