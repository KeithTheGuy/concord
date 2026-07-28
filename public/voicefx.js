// The voice FX rack. Everything here sits *after* the pitch shifter in
// voicefx-worklet.js, on the outgoing mic path, so whatever you pick is what
// the other end actually hears.
//
// A preset is a plain description of a signal chain — filters, drive, ring
// modulation, tremolo, delay, reverb, compression — and buildFxGraph turns
// that description into WebAudio nodes. Adding a voice is a matter of writing
// down numbers, not wiring.

/* ------------------------------- presets --------------------------------- */

export const VOICE_FX = [
  {
    id: "off",
    label: "Off — your actual voice",
    emoji: "🎙️",
    blurb: "No processing at all",
    spec: { semis: 0 },
  },
  {
    id: "freds",
    label: "FredsVoice (ASMR)",
    emoji: "🤫",
    blurb: "Close, breathy, right-in-your-ear",
    spec: {
      semis: -2,
      // Soften the top end, then add a narrow presence lift so it reads as
      // "close to the mic" rather than just muffled.
      lowpass: { freq: 6200, q: 0.7 },
      peaking: [
        { freq: 240, gain: -3, q: 1.0 }, // pull out chestiness
        { freq: 3200, gain: 3.5, q: 1.2 }, // intelligibility
        { freq: 8200, gain: 7, q: 0.8 }, // that whispery sparkle
      ],
      // Heavy, slow compression = the intimacy. Quiet breaths come up to meet
      // the loud bits, which is most of what makes ASMR sound like ASMR.
      compress: { threshold: -34, ratio: 9, knee: 28, attack: 0.006, release: 0.28 },
      // A few milliseconds of offset between ears reads as "beside your head".
      pingpong: { time: 0.017, feedback: 0.12, mix: 0.42 },
      reverb: { seconds: 1.4, decay: 3.2, mix: 0.22 },
      gain: 1.5,
    },
  },
  { id: "fem", label: "Feminine", emoji: "💁‍♀️", blurb: "Lifted, natural", spec: { semis: 5 } },
  { id: "anime", label: "Anime girl", emoji: "🌸", blurb: "Way up there", spec: { semis: 8 } },
  { id: "chipmunk", label: "Chipmunk", emoji: "🐿️", blurb: "Maximum helium", spec: { semis: 12 } },
  { id: "deep", label: "Deeper", emoji: "🗿", blurb: "Down a fifth", spec: { semis: -5 } },
  {
    id: "demon",
    label: "Demon",
    emoji: "👹",
    blurb: "From below",
    spec: {
      semis: -9,
      drive: 0.45,
      lowpass: { freq: 3400, q: 0.9 },
      reverb: { seconds: 2.4, decay: 2.4, mix: 0.3 },
      gain: 1.1,
    },
  },
  {
    id: "radio",
    label: "CB Radio",
    emoji: "📻",
    blurb: "Breaker breaker",
    spec: {
      semis: 0,
      highpass: { freq: 420, q: 0.8 },
      lowpass: { freq: 3000, q: 0.9 },
      peaking: [{ freq: 1800, gain: 8, q: 1.4 }],
      drive: 0.55,
      compress: { threshold: -22, ratio: 12, knee: 6, attack: 0.002, release: 0.12 },
      gain: 1.2,
    },
  },
  {
    id: "telephone",
    label: "Telephone",
    emoji: "☎️",
    blurb: "Tinny and far away",
    spec: {
      semis: 0,
      highpass: { freq: 520, q: 0.9 },
      lowpass: { freq: 2700, q: 1.1 },
      drive: 0.18,
      gain: 1.25,
    },
  },
  {
    id: "robot",
    label: "Robot",
    emoji: "🤖",
    blurb: "Ring modulated",
    spec: {
      semis: -1,
      ringMod: { hz: 58, mix: 0.85 },
      lowpass: { freq: 4200, q: 0.8 },
      gain: 1.1,
    },
  },
  {
    id: "megaphone",
    label: "Megaphone",
    emoji: "📢",
    blurb: "PLEASE DISPERSE",
    spec: {
      semis: 0,
      highpass: { freq: 600, q: 1.0 },
      lowpass: { freq: 3600, q: 1.0 },
      drive: 0.75,
      tremolo: { hz: 32, depth: 0.18 },
      gain: 1.3,
    },
  },
  {
    id: "underwater",
    label: "Underwater",
    emoji: "🫧",
    blurb: "Glub glub",
    spec: {
      semis: -3,
      lowpass: { freq: 620, q: 3.5 },
      tremolo: { hz: 5.5, depth: 0.35 },
      reverb: { seconds: 2.0, decay: 2.0, mix: 0.35 },
      gain: 1.8,
    },
  },
  {
    id: "alien",
    label: "Alien",
    emoji: "👽",
    blurb: "Take me to your leader",
    spec: {
      semis: 4,
      ringMod: { hz: 132, mix: 0.5 },
      pingpong: { time: 0.09, feedback: 0.3, mix: 0.35 },
      lowpass: { freq: 5200, q: 0.7 },
      gain: 1.1,
    },
  },
  {
    id: "cave",
    label: "Cavern",
    emoji: "🕳️",
    blurb: "Enormous empty room",
    spec: {
      semis: -2,
      reverb: { seconds: 4.0, decay: 1.8, mix: 0.55 },
      lowpass: { freq: 5200, q: 0.7 },
      gain: 1.2,
    },
  },
  {
    id: "ghost",
    label: "Ghost",
    emoji: "👻",
    blurb: "Wobbling and distant",
    spec: {
      semis: 3,
      tremolo: { hz: 6.5, depth: 0.5 },
      pingpong: { time: 0.14, feedback: 0.42, mix: 0.45 },
      reverb: { seconds: 3.0, decay: 2.2, mix: 0.45 },
      lowpass: { freq: 4200, q: 0.8 },
      gain: 1.3,
    },
  },
];

export const FX_BY_ID = new Map(VOICE_FX.map((f) => [f.id, f]));

/* ------------------------------- builders -------------------------------- */

// A synthetic impulse response: white noise under an exponential decay. Not a
// real room, but it costs nothing to ship and sounds like one.
function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * seconds));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// Soft-clip curve. `amount` 0..1 maps to gentle warmth through to full fuzz.
function makeDriveCurve(amount) {
  const k = Math.max(0.0001, amount) * 120;
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/**
 * Builds the chain described by `spec` and returns { input, output, dispose }.
 * Wet/dry sections (delay, reverb) are mixed in parallel so the dry voice is
 * never lost — you always stay intelligible.
 */
export function buildFxGraph(ctx, spec = {}) {
  const nodes = [];
  const keep = (n) => {
    nodes.push(n);
    return n;
  };

  const input = keep(ctx.createGain());
  let cursor = input;
  const connect = (next) => {
    cursor.connect(next);
    cursor = next;
  };

  if (spec.highpass) {
    const f = keep(ctx.createBiquadFilter());
    f.type = "highpass";
    f.frequency.value = spec.highpass.freq;
    f.Q.value = spec.highpass.q ?? 1;
    connect(f);
  }

  if (spec.lowpass) {
    const f = keep(ctx.createBiquadFilter());
    f.type = "lowpass";
    f.frequency.value = spec.lowpass.freq;
    f.Q.value = spec.lowpass.q ?? 1;
    connect(f);
  }

  for (const band of spec.peaking || []) {
    const f = keep(ctx.createBiquadFilter());
    f.type = "peaking";
    f.frequency.value = band.freq;
    f.gain.value = band.gain;
    f.Q.value = band.q ?? 1;
    connect(f);
  }

  if (spec.drive) {
    const shaper = keep(ctx.createWaveShaper());
    shaper.curve = makeDriveCurve(spec.drive);
    shaper.oversample = "2x";
    connect(shaper);
  }

  // Ring modulation: multiply the signal by a sine. A gain node whose gain is
  // driven by an oscillator IS a multiplier.
  if (spec.ringMod) {
    const mixed = keep(ctx.createGain());
    const wet = keep(ctx.createGain());
    const dry = keep(ctx.createGain());
    const mix = Math.max(0, Math.min(1, spec.ringMod.mix ?? 0.8));
    wet.gain.value = mix;
    dry.gain.value = 1 - mix;

    const ring = keep(ctx.createGain());
    ring.gain.value = 0; // the oscillator supplies the whole value
    const osc = keep(ctx.createOscillator());
    osc.type = "sine";
    osc.frequency.value = spec.ringMod.hz;
    osc.connect(ring.gain);
    osc.start();

    cursor.connect(ring);
    cursor.connect(dry);
    ring.connect(wet);
    wet.connect(mixed);
    dry.connect(mixed);
    cursor = mixed;
  }

  if (spec.tremolo) {
    const trem = keep(ctx.createGain());
    trem.gain.value = 1 - (spec.tremolo.depth ?? 0.3);
    const lfo = keep(ctx.createOscillator());
    lfo.type = "sine";
    lfo.frequency.value = spec.tremolo.hz;
    const depth = keep(ctx.createGain());
    depth.gain.value = spec.tremolo.depth ?? 0.3;
    lfo.connect(depth).connect(trem.gain);
    lfo.start();
    connect(trem);
  }

  // Stereo ping-pong. The tiny-offset version of this is what gives FredsVoice
  // its "beside your head" quality rather than "in a hallway".
  if (spec.pingpong) {
    const wet = keep(ctx.createGain());
    wet.gain.value = spec.pingpong.mix ?? 0.3;
    const merger = keep(ctx.createChannelMerger(2));
    const left = keep(ctx.createDelay(1));
    const right = keep(ctx.createDelay(1));
    left.delayTime.value = spec.pingpong.time;
    right.delayTime.value = (spec.pingpong.time || 0.02) * 1.9;
    const fb = keep(ctx.createGain());
    fb.gain.value = Math.min(0.7, spec.pingpong.feedback ?? 0.2);

    cursor.connect(left);
    left.connect(right);
    right.connect(fb);
    fb.connect(left);
    left.connect(merger, 0, 0);
    right.connect(merger, 0, 1);
    merger.connect(wet);

    const sum = keep(ctx.createGain());
    cursor.connect(sum);
    wet.connect(sum);
    cursor = sum;
  }

  if (spec.reverb) {
    const convolver = keep(ctx.createConvolver());
    convolver.buffer = makeImpulse(ctx, spec.reverb.seconds, spec.reverb.decay);
    const wet = keep(ctx.createGain());
    wet.gain.value = spec.reverb.mix ?? 0.25;
    const dry = keep(ctx.createGain());
    dry.gain.value = 1;
    const sum = keep(ctx.createGain());
    cursor.connect(convolver);
    convolver.connect(wet).connect(sum);
    cursor.connect(dry).connect(sum);
    cursor = sum;
  }

  if (spec.compress) {
    const comp = keep(ctx.createDynamicsCompressor());
    comp.threshold.value = spec.compress.threshold ?? -24;
    comp.ratio.value = spec.compress.ratio ?? 6;
    comp.knee.value = spec.compress.knee ?? 20;
    comp.attack.value = spec.compress.attack ?? 0.01;
    comp.release.value = spec.compress.release ?? 0.2;
    connect(comp);
  }

  const output = keep(ctx.createGain());
  output.gain.value = spec.gain ?? 1;
  cursor.connect(output);

  // A limiter on the way out, because several of these presets add a lot of
  // gain and nobody should be able to blow out the call by picking Megaphone.
  const limiter = keep(ctx.createDynamicsCompressor());
  limiter.threshold.value = -3;
  limiter.ratio.value = 20;
  limiter.knee.value = 0;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.08;
  output.connect(limiter);

  return {
    input,
    output: limiter,
    dispose() {
      for (const n of nodes) {
        try {
          if (typeof n.stop === "function") n.stop();
        } catch {}
        try {
          n.disconnect();
        } catch {}
      }
    },
  };
}
