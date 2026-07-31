// Voice Lab: the settings-pane utilities around the FX rack in voicefx.js —
// noise gate, level meters, device/quality constraints, sender bitrate, and
// connection-quality stats. Nothing here talks to the network directly;
// callers (voice.js, the settings UI) own that.

/* -------------------------------------------------------------- noise gate */

const GATE_MIN_RMS = 0.002; // near-silence / room tone
const GATE_MAX_RMS = 0.08; // a raised speaking voice
const GATE_ATTACK_S = 0.005; // ~5ms to open — fast enough not to eat onsets
const GATE_RELEASE_S = 0.15; // ~150ms to close — slow enough not to clip word tails
const GATE_HOLD_MS = 150; // stay open this long after the last loud sample
const GATE_POLL_MS = 20; // 50Hz is plenty for RMS envelope tracking

// The threshold slider is 0..100, but loudness is perceived logarithmically —
// a linear map would spend the first half of the slider doing almost nothing
// and the back half doing everything. Interpolate exponentially instead so
// each step of the knob feels like an even step in perceived loudness.
function gateThresholdToRms(pct) {
  const t = Math.max(0, Math.min(100, pct)) / 100;
  return GATE_MIN_RMS * Math.pow(GATE_MAX_RMS / GATE_MIN_RMS, t);
}

/**
 * A real noise gate for the outgoing chain: analyser-driven GainNode, not a
 * hard mute. threshold 0 means bypassed — no analyser, no interval, no gain
 * automation — because this gets rebuilt on every slider drag and a leaked
 * interval per drag will grind the tab to a halt.
 */
export function buildNoiseGate(ctx, opts = {}) {
  const input = ctx.createGain();
  const output = ctx.createGain();
  input.connect(output); // always wired; gating is just automation on output.gain

  let threshold = opts.threshold || 0;
  let analyser = null;
  let buf = null;
  let timer = null;
  let open = true;
  let lastLoud = 0;

  function rms() {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) {
      const x = (v - 128) / 128;
      sum += x * x;
    }
    return Math.sqrt(sum / buf.length);
  }

  function tick() {
    const loud = rms() > gateThresholdToRms(threshold);
    const now = Date.now();
    if (loud) lastLoud = now;
    // Hold keeps the gate open through brief gaps (breaths, plosives) so it
    // doesn't chatter open/closed on the tail of a word.
    const shouldOpen = loud || now - lastLoud < GATE_HOLD_MS;
    if (shouldOpen === open) return;
    open = shouldOpen;
    // setTargetAtTime, never a bare assignment — a hard gain step is an
    // audible click, and this runs many times a second.
    output.gain.setTargetAtTime(open ? 1 : 0, ctx.currentTime, open ? GATE_ATTACK_S : GATE_RELEASE_S);
  }

  function start() {
    if (timer) return;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    buf = new Uint8Array(analyser.fftSize);
    input.connect(analyser);
    open = true;
    lastLoud = Date.now();
    output.gain.cancelScheduledValues(ctx.currentTime);
    output.gain.setValueAtTime(1, ctx.currentTime);
    timer = setInterval(tick, GATE_POLL_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (analyser) {
      try {
        input.disconnect(analyser);
      } catch {}
      analyser = null;
      buf = null;
    }
    open = true;
    output.gain.cancelScheduledValues(ctx.currentTime);
    output.gain.setValueAtTime(1, ctx.currentTime); // fully open, i.e. bypassed
  }

  if (threshold > 0) start();

  return {
    input,
    output,
    setThreshold(n) {
      threshold = Math.max(0, Math.min(100, n || 0));
      if (threshold > 0) start();
      else stop();
    },
    dispose() {
      stop(); // this is the part that matters: kill the interval
      try {
        input.disconnect();
      } catch {}
      try {
        output.disconnect();
      } catch {}
    },
  };
}

/* ------------------------------------------------------------------ meter */

/**
 * Live RMS meter for a stream (the Settings mic-test bar). Creates its own
 * source/analyser but no tracks, so stop() must not touch the caller's
 * stream — the caller decides when the mic itself is done.
 */
export function createMeter(ctx, stream) {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser); // analysis only — never to destination
  const buf = new Uint8Array(analyser.fftSize);
  return {
    level() {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const x = (v - 128) / 128;
        sum += x * x;
      }
      return Math.sqrt(sum / buf.length);
    },
    stop() {
      try {
        src.disconnect();
      } catch {}
      // No track.stop() here on purpose — we didn't create the stream.
    },
  };
}

/* -------------------------------------------------------------- constraints */

/** getUserMedia audio constraints from the persisted settings object. */
export function micConstraints(settings = {}) {
  const { micId, echoCancel, noiseSuppress, agc, stereo } = settings;
  const constraints = {
    echoCancellation: !!echoCancel,
    noiseSuppression: !!noiseSuppress,
    autoGainControl: !!agc,
  };
  if (stereo) {
    // Echo cancellation and AGC are mono-summing, single-channel algorithms:
    // fed two channels they collapse them to one internally before doing
    // their thing, so the stereo image is gone before it ever reaches the
    // encoder. Left on, "stereo" mode silently spends double the bandwidth
    // for a mono result — force them off so stereo actually stays stereo.
    constraints.channelCount = 2;
    constraints.echoCancellation = false;
    constraints.autoGainControl = false;
  }
  if (micId) constraints.deviceId = { ideal: micId };
  return constraints;
}

export const SHARE_QUALITY = [
  { id: "720p30", label: "720p30", width: 1280, height: 720, fps: 30 },
  { id: "1080p30", label: "1080p30", width: 1920, height: 1080, fps: 30 },
  { id: "1080p60", label: "1080p60", width: 1920, height: 1080, fps: 60 },
];
const SHARE_QUALITY_BY_ID = new Map(SHARE_QUALITY.map((q) => [q.id, q]));

/** getDisplayMedia constraints from the chosen quality + shareAudio toggle. */
export function displayConstraints(settings = {}) {
  const q = SHARE_QUALITY_BY_ID.get(settings.shareQuality) || SHARE_QUALITY[0];
  return {
    video: {
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: q.fps },
    },
    // System audio capture only exists in Chromium, and even there it's
    // tab-audio only on most platforms (no full-desktop audio share on
    // Windows/Linux, none at all in Chromium on macOS). The caller should
    // treat a share with no audio track as the normal case, not a failure.
    audio: !!settings.shareAudio,
  };
}

/* ------------------------------------------------------------ sender/bitrate */

/**
 * Applies target bitrate + priority to an RTCRtpSender. Firefox can return
 * getParameters() with no `encodings` array at all until something has been
 * sent on the transceiver once — guard for that rather than assume addTrack
 * always populates it. Unsupported fields/APIs are a silent no-op: the call
 * still works at default parameters, which beats throwing.
 */
export async function applySenderParams(sender, settings = {}) {
  if (!sender || typeof sender.getParameters !== "function") return;
  const params = sender.getParameters();
  if (!params.encodings || !params.encodings.length) params.encodings = [{}];
  const maxBitrate = settings.stereo ? 128000 : 64000;
  for (const enc of params.encodings) {
    enc.maxBitrate = maxBitrate;
    enc.networkPriority = "high";
  }
  if (typeof sender.setParameters !== "function") return;
  try {
    await sender.setParameters(params);
  } catch {
    // e.g. no prior setLocalDescription, or the field isn't supported here.
  }
}

/* --------------------------------------------------------------- devices */

export async function listDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = [];
  const outputs = [];
  let inCount = 0;
  let outCount = 0;
  for (const d of devices) {
    if (d.kind === "audioinput") {
      inCount++;
      // Labels are blank until mic permission has been granted at least
      // once — fall back to a stable, numbered placeholder instead of "".
      inputs.push({ deviceId: d.deviceId, label: d.label || `Microphone ${inCount}` });
    } else if (d.kind === "audiooutput") {
      outCount++;
      outputs.push({ deviceId: d.deviceId, label: d.label || `Speaker ${outCount}` });
    }
  }
  return { inputs, outputs };
}

/** setSinkId on a media element. Firefox has no setSinkId — return false, don't throw. */
export async function applySink(node, deviceId) {
  if (!node || typeof node.setSinkId !== "function") return false;
  try {
    await node.setSinkId(deviceId || "");
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------------------------------------------- stats */

// Per-connection previous sample, for turning cumulative bytesReceived into
// an instantaneous kbps. Keyed by the RTCPeerConnection itself so it's GC'd
// with it — no manual cleanup needed.
const _statsPrev = new WeakMap();

/**
 * Snapshots the inbound audio stream's health. Returns null if there's no
 * inbound audio RTP yet (call not up) rather than a zeroed-out object, so
 * callers can tell "no data" from "perfect connection".
 */
export async function summariseStats(pc) {
  if (!pc) return null;
  const stats = await pc.getStats();
  let inbound = null;
  let pair = null;
  stats.forEach((r) => {
    if (r.type === "inbound-rtp" && r.kind === "audio" && !r.isRemote) inbound = r;
    // `nominated` is the ICE-agreed active pair; older stacks that omit it
    // still report exactly one "succeeded" pair, so fall back to that.
    if (r.type === "candidate-pair" && r.state === "succeeded" && (r.nominated ?? true)) pair = r;
  });
  if (!inbound || !pair) return null;

  const prev = _statsPrev.get(pc);
  _statsPrev.set(pc, { ts: inbound.timestamp, bytes: inbound.bytesReceived });
  let kbps = 0;
  if (prev && inbound.timestamp > prev.ts && inbound.bytesReceived >= prev.bytes) {
    const bits = (inbound.bytesReceived - prev.bytes) * 8;
    const seconds = (inbound.timestamp - prev.ts) / 1000;
    kbps = bits / seconds / 1000;
  }

  const lost = Math.max(0, inbound.packetsLost || 0);
  const expected = inbound.packetsReceived + lost; // total packets expected, not just what arrived
  const loss = expected > 0 ? (lost / expected) * 100 : 0;

  return {
    rtt: pair.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    loss,
    kbps,
    jitter: inbound.jitter != null ? inbound.jitter * 1000 : null,
  };
}

// rtt (ms)   loss (%)   label        A person reading these numbers would
// < 100      < 1        Excellent    call this "great connection."
// < 200      < 3        Good         Still comfortable for conversation.
// < 400      < 8        Ok           Noticeable but usable.
// otherwise             Poor         Talking over each other, audible drops.
export function qualityLabel({ rtt, loss } = {}) {
  const r = rtt ?? 0;
  const l = loss ?? 0;
  if (r < 100 && l < 1) return { label: "Excellent", cls: "q-excellent" };
  if (r < 200 && l < 3) return { label: "Good", cls: "q-good" };
  if (r < 400 && l < 8) return { label: "Ok", cls: "q-ok" };
  return { label: "Poor", cls: "q-poor" };
}
