// Real-time pitch shifter that runs on the mic before it reaches the call.
//
// Two delay taps whose delay ramps linearly and wraps, half a grain apart,
// each windowed by a Hann curve. Hann windows at 50% overlap sum to 1, so the
// crossfade is seamless and the wrap discontinuity lands where both windows
// are zero. Pitch and formants shift together, which is exactly the cartoon
// sound people actually want from a voice changer.

const GRAIN = 1536; // ~32ms at 48kHz: short enough to stay responsive
const BUFFER = 16384;

class VoiceFx extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "semitones", defaultValue: 0, minValue: -24, maxValue: 24, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    this.buf = new Float32Array(BUFFER);
    this.write = 0;
    this.delay = 0;
  }

  // Linearly interpolated read `d` samples behind the write head, windowed.
  tap(d) {
    let pos = this.write - 1 - d;
    while (pos < 0) pos += BUFFER;
    const i = Math.floor(pos);
    const frac = pos - i;
    const sample = this.buf[i] * (1 - frac) + this.buf[(i + 1) % BUFFER] * frac;
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * d) / GRAIN));
    return sample * window;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    const inCh = input && input.length ? input[0] : null;
    const outCh = output[0];
    if (!inCh) {
      outCh.fill(0);
      return true;
    }

    const semis = params.semitones[0];
    if (Math.abs(semis) < 0.01) {
      // True bypass: no buffering, so "off" adds no latency at all.
      outCh.set(inCh);
      for (let c = 1; c < output.length; c++) output[c].set(outCh);
      return true;
    }

    const ratio = Math.pow(2, semis / 12);
    const step = 1 - ratio; // delay ramp per sample; negative shifts pitch up

    for (let i = 0; i < inCh.length; i++) {
      this.buf[this.write] = inCh[i];
      this.write = (this.write + 1) % BUFFER;

      let d1 = this.delay + step;
      if (d1 < 0) d1 += GRAIN;
      else if (d1 >= GRAIN) d1 -= GRAIN;
      this.delay = d1;

      let d2 = d1 + GRAIN / 2;
      if (d2 >= GRAIN) d2 -= GRAIN;

      outCh[i] = this.tap(d1) + this.tap(d2);
    }
    for (let c = 1; c < output.length; c++) output[c].set(outCh);
    return true;
  }
}

registerProcessor("voice-fx", VoiceFx);
