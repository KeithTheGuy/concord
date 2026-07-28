// Soundboard. Every clip is synthesized with WebAudio at play time — there are
// no audio files to host, nothing to download, and the whole board costs zero
// bytes of bandwidth. The server only relays *which* sound to play, to the
// people in your voice channel.

let ctx = null;
function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Shared noise source — several clips are just filtered noise.
function noiseBuffer(c, seconds) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function env(c, node, at, peak, attack, hold, release) {
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + attack);
  g.gain.setValueAtTime(peak, at + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + hold + release);
  node.connect(g);
  return g;
}

function tone(c, dest, type, freqs, at, dur, peak = 0.3) {
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freqs[0], at);
  for (let i = 1; i < freqs.length; i++) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqs[i]), at + (dur * i) / (freqs.length - 1));
  }
  const g = env(c, osc, at, peak, 0.01, dur * 0.6, dur * 0.4);
  g.connect(dest);
  osc.start(at);
  osc.stop(at + dur + 0.1);
  return osc;
}

function noise(c, dest, at, dur, filterType, freq, peak = 0.3) {
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur + 0.05);
  const flt = c.createBiquadFilter();
  flt.type = filterType;
  flt.frequency.setValueAtTime(freq, at);
  src.connect(flt);
  const g = env(c, flt, at, peak, 0.005, dur * 0.5, dur * 0.5);
  g.connect(dest);
  src.start(at);
  src.stop(at + dur + 0.1);
  return { src, flt };
}

/* --------------------------------- clips --------------------------------- */

const CLIPS = {
  airhorn(c, out, t) {
    // Three stacked detuned saws with a rising wobble = the classic.
    for (const detune of [0, 7, -5]) {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(210 + detune, t);
      osc.frequency.linearRampToValueAtTime(330 + detune, t + 0.1);
      osc.frequency.setValueAtTime(330 + detune, t + 0.75);
      osc.frequency.linearRampToValueAtTime(200 + detune, t + 0.95);
      const g = env(c, osc, t, 0.22, 0.03, 0.7, 0.2);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 1.1);
    }
    return 1.1;
  },

  vine(c, out, t) {
    // Vine boom: a deep sine thud with a fast downward sweep.
    tone(c, out, "sine", [160, 55, 32], t, 0.8, 0.85);
    noise(c, out, t, 0.14, "lowpass", 260, 0.4);
    return 0.9;
  },

  bruh(c, out, t) {
    // Vocal-ish "bruh" — two formant-ish bands that slide down together.
    for (const [f0, f1, peak] of [[520, 300, 0.28], [1180, 780, 0.14]]) {
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.exponentialRampToValueAtTime(f1, t + 0.42);
      const flt = c.createBiquadFilter();
      flt.type = "bandpass";
      flt.Q.value = 6;
      flt.frequency.setValueAtTime(f0 * 1.4, t);
      flt.frequency.exponentialRampToValueAtTime(f1, t + 0.42);
      osc.connect(flt);
      const g = env(c, flt, t, peak, 0.04, 0.22, 0.2);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 0.6);
    }
    return 0.6;
  },

  sad(c, out, t) {
    // Sad trombone: four descending slides with a little wah on each.
    const steps = [233, 220, 196, 175];
    let at = t;
    steps.forEach((f, i) => {
      const dur = i === steps.length - 1 ? 0.55 : 0.26;
      const osc = c.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f * 1.06, at);
      osc.frequency.linearRampToValueAtTime(f, at + dur * 0.7);
      const flt = c.createBiquadFilter();
      flt.type = "lowpass";
      flt.frequency.setValueAtTime(900, at);
      flt.frequency.linearRampToValueAtTime(500, at + dur);
      osc.connect(flt);
      const g = env(c, flt, at, 0.3, 0.03, dur * 0.5, dur * 0.45);
      g.connect(out);
      osc.start(at);
      osc.stop(at + dur + 0.1);
      at += dur;
    });
    return at - t + 0.2;
  },

  yeet(c, out, t) {
    tone(c, out, "square", [420, 900, 1600], t, 0.28, 0.18);
    noise(c, out, t + 0.24, 0.18, "highpass", 1400, 0.25);
    return 0.5;
  },

  rimshot(c, out, t) {
    // ba-dum tss
    tone(c, out, "sine", [200, 90], t, 0.12, 0.6);
    tone(c, out, "sine", [170, 70], t + 0.16, 0.14, 0.6);
    noise(c, out, t + 0.34, 0.5, "highpass", 6000, 0.3);
    return 0.9;
  },

  bonk(c, out, t) {
    tone(c, out, "sine", [700, 120], t, 0.16, 0.7);
    noise(c, out, t, 0.06, "bandpass", 1800, 0.4);
    return 0.3;
  },

  quack(c, out, t) {
    const osc = c.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.linearRampToValueAtTime(190, t + 0.18);
    const flt = c.createBiquadFilter();
    flt.type = "bandpass";
    flt.Q.value = 4;
    flt.frequency.setValueAtTime(1400, t);
    flt.frequency.linearRampToValueAtTime(700, t + 0.18);
    osc.connect(flt);
    const g = env(c, flt, t, 0.4, 0.01, 0.09, 0.09);
    g.connect(out);
    osc.start(t);
    osc.stop(t + 0.35);
    return 0.35;
  },

  wow(c, out, t) {
    tone(c, out, "triangle", [300, 620, 480, 700], t, 0.55, 0.3);
    return 0.7;
  },

  fart(c, out, t) {
    // Immature. Non-negotiable.
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(95, t);
    const lfo = c.createOscillator();
    lfo.type = "square";
    lfo.frequency.setValueAtTime(22, t);
    lfo.frequency.linearRampToValueAtTime(9, t + 0.5);
    const lfoGain = c.createGain();
    lfoGain.gain.value = 40;
    lfo.connect(lfoGain).connect(osc.frequency);
    const flt = c.createBiquadFilter();
    flt.type = "lowpass";
    flt.frequency.setValueAtTime(700, t);
    flt.frequency.linearRampToValueAtTime(280, t + 0.5);
    osc.connect(flt);
    const g = env(c, flt, t, 0.3, 0.02, 0.28, 0.22);
    g.connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + 0.6);
    lfo.stop(t + 0.6);
    return 0.6;
  },

  applause(c, out, t) {
    // Dense filtered noise bursts fading in and out = a crowd, roughly.
    const dur = 1.6;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, dur);
    const flt = c.createBiquadFilter();
    flt.type = "bandpass";
    flt.frequency.value = 2200;
    flt.Q.value = 0.6;
    src.connect(flt);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.28, t + 0.18);
    g.gain.setValueAtTime(0.28, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    flt.connect(g).connect(out);
    src.start(t);
    src.stop(t + dur + 0.1);
    // A few individual claps on top so it isn't just hiss.
    for (let i = 0; i < 14; i++) {
      noise(c, out, t + Math.random() * dur * 0.85, 0.035, "highpass", 2500, 0.12);
    }
    return dur + 0.1;
  },

  windows(c, out, t) {
    // Two-note "you did something wrong" chime.
    tone(c, out, "sine", [988, 988], t, 0.22, 0.3);
    tone(c, out, "sine", [740, 740], t + 0.24, 0.4, 0.3);
    return 0.7;
  },
};

export const SOUNDBOARD = [
  { id: "airhorn", label: "Air Horn", emoji: "📢" },
  { id: "vine", label: "Vine Boom", emoji: "💥" },
  { id: "bruh", label: "Bruh", emoji: "😑" },
  { id: "sad", label: "Sad Trombone", emoji: "🎺" },
  { id: "yeet", label: "Yeet", emoji: "🚀" },
  { id: "rimshot", label: "Rimshot", emoji: "🥁" },
  { id: "bonk", label: "Bonk", emoji: "🔨" },
  { id: "quack", label: "Quack", emoji: "🦆" },
  { id: "wow", label: "Wow", emoji: "😲" },
  { id: "fart", label: "Regrettable", emoji: "💨" },
  { id: "applause", label: "Applause", emoji: "👏" },
  { id: "windows", label: "Error Chime", emoji: "🪟" },
];

export const SOUND_IDS = new Set(SOUNDBOARD.map((s) => s.id));

let master = null;
let lastPlayed = 0;

export function playSound(id, volume = 1) {
  const clip = CLIPS[id];
  if (!clip) return 0;
  const c = audio();
  if (!c) return 0;
  // Two people spamming the board shouldn't stack into a wall of clipping.
  const now = c.currentTime;
  if (now - lastPlayed < 0.05) return 0;
  lastPlayed = now;
  if (!master) {
    master = c.createGain();
    const limiter = c.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.ratio.value = 12;
    master.connect(limiter).connect(c.destination);
  }
  master.gain.value = Math.max(0, Math.min(1.5, volume));
  try {
    return clip(c, master, now + 0.02) || 0.5;
  } catch {
    return 0;
  }
}
