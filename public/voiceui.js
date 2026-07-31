// The audio half of the Settings modal, plus the call-quality readout in the
// voice panel. This file owns its own markup: it finds the existing Voice
// section and appends to it, so nothing here needs a line of index.html.
//
// Everything it touches from the app arrives through the hooks object, and
// everything it knows about audio comes from voicelab.js.

import { createMeter, micConstraints, listDevices, SHARE_QUALITY, qualityLabel } from "./voicelab.js";

// Mirrors voicelab's private threshold curve. Duplicated on purpose: it lets
// the meter and the slider share one axis, so the bar and the marker are
// directly comparable — which is the entire reason for drawing them together.
const GATE_MIN_RMS = 0.002;
const GATE_MAX_RMS = 0.08;

function rmsToPct(rms) {
  if (rms <= GATE_MIN_RMS) return 0;
  const t = Math.log(rms / GATE_MIN_RMS) / Math.log(GATE_MAX_RMS / GATE_MIN_RMS);
  return Math.max(0, Math.min(100, t * 100));
}

const CONTROLS = `
  <label>Input sensitivity <span class="hint" id="set-gate-label">Off</span></label>
  <input type="range" id="set-gate" min="0" max="100" step="1" value="0">
  <div class="vmeter" id="set-meter">
    <div class="vmeter-fill" id="set-meter-fill"></div>
    <div class="vmeter-mark off" id="set-meter-mark"></div>
  </div>
  <p class="vnote">Anything left of the line counts as silence and never leaves your machine.</p>
  <label class="check-row"><input type="checkbox" id="set-echo"> Echo cancellation</label>
  <label class="check-row"><input type="checkbox" id="set-ns"> Noise suppression</label>
  <label class="check-row"><input type="checkbox" id="set-agc"> Automatic gain control</label>
  <label class="check-row"><input type="checkbox" id="set-stereo"> Stereo &amp; high bitrate (128kbps)</label>
  <p class="vnote">Stereo turns echo cancellation off — it's a mono algorithm, and it would flatten the image before the encoder ever saw it.</p>
  <label>Output device</label>
  <div class="vrow">
    <select id="set-output"></select>
    <button id="set-output-test" class="pill-btn" type="button">Test</button>
  </div>
  <label>Screen share quality</label>
  <select id="set-share-q"></select>
  <label class="check-row" title="Applies the next time you start a share."><input type="checkbox" id="set-share-audio"> Share system audio</label>
`;

/**
 * hooks: {
 *   voice,                       // the VoiceEngine
 *   settings(): object,          // the live settings object (mutated in place)
 *   save(): void,                // persist settings
 *   toast(text, isError): void,
 *   onSettingsOpen(fn): void,    // called with a fn to run whenever settings opens
 *   panelEl(): HTMLElement,      // the settings modal
 *   qualityEl(): HTMLElement,    // #vs-quality in the voice panel
 * }
 */
export function installVoiceUI(hooks) {
  const root = hooks.panelEl?.();
  if (!root || root.querySelector("#set-gate")) return; // idempotent
  const host = root.querySelector("#set-mic")?.closest("section") || root;
  host.insertAdjacentHTML("beforeend", CONTROLS);

  const q = (id) => host.querySelector("#" + id);
  const gate = q("set-gate");
  const gateLabel = q("set-gate-label");
  const fill = q("set-meter-fill");
  const mark = q("set-meter-mark");
  const echo = q("set-echo");
  const ns = q("set-ns");
  const agc = q("set-agc");
  const stereo = q("set-stereo");
  const output = q("set-output");
  const shareQ = q("set-share-q");
  const shareAudio = q("set-share-audio");

  for (const item of SHARE_QUALITY) {
    const opt = document.createElement("option");
    opt.value = item.id;
    opt.textContent = item.label;
    shareQ.appendChild(opt);
  }

  /* ------------------------------------------------------------- meter */

  let meter = null;
  let meterCtx = null;
  let meterStream = null;
  let meterRaf = 0;
  let ownCtx = false;
  let ownStream = false;
  // The modal can close while getUserMedia is still resolving; without this
  // the meter would come up behind a closed modal and never be stopped.
  let wanted = false;
  // `wanted` alone only covers open-then-close. Opening, closing and opening
  // again while the permission prompt is still up leaves *two* getUserMedia
  // calls in flight, both of which think they're current — which used to leak a
  // live microphone and a second animation loop that ran forever. Every attempt
  // takes a ticket, and only the newest one is allowed to publish its stream.
  let meterGen = 0;

  function paintGate() {
    const th = hooks.settings().noiseGate || 0;
    gateLabel.textContent = th === 0 ? "Off" : String(th);
    mark.style.left = th + "%";
    mark.classList.toggle("off", th === 0);
  }

  function draw() {
    // A stale loop that outlived its meter must die rather than throw sixty
    // times a second — the reschedule happens first, so a throw here would be
    // permanent.
    if (!meter) {
      meterRaf = 0;
      return;
    }
    meterRaf = requestAnimationFrame(draw);
    const pct = rmsToPct(meter.level());
    fill.style.width = pct.toFixed(1) + "%";
    const th = hooks.settings().noiseGate || 0;
    fill.classList.toggle("open", th === 0 || pct >= th);
  }

  async function startMeter() {
    wanted = true;
    if (meter) return;
    const gen = ++meterGen;
    // Held locally until we know this attempt is still the current one, so a
    // superseded attempt can only ever tear down what it opened itself.
    let ctx = null;
    let stream = null;
    let mineCtx = false;
    let mineStream = false;
    try {
      // Borrow the call's mic and context when there is one — a second
      // getUserMedia on the same device is a coin flip on some drivers, and
      // this way the bar shows the audio actually being sent.
      if (hooks.voice?.ctx && hooks.voice?.localStream) {
        ctx = hooks.voice.ctx;
        stream = hooks.voice.localStream;
      } else {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        mineCtx = true;
        stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(hooks.settings()) });
        mineStream = true;
      }
    } catch {
      if (mineCtx && ctx) ctx.close().catch(() => {});
      if (gen === meterGen) {
        stopMeter();
        hooks.toast("Can't read the microphone for the level meter — check permissions.", true);
      }
      return;
    }
    if (!wanted || gen !== meterGen) {
      if (mineStream) for (const t of stream.getTracks()) t.stop();
      if (mineCtx) ctx.close().catch(() => {});
      return;
    }
    meterCtx = ctx;
    meterStream = stream;
    ownCtx = mineCtx;
    ownStream = mineStream;
    if (mineStream) populateOutputs(); // labels were blank until permission landed
    if (meterCtx.state === "suspended") meterCtx.resume();
    meter = createMeter(meterCtx, meterStream);
    draw();
  }

  function stopMeter() {
    wanted = false;
    meterGen++; // invalidates anything still waiting on getUserMedia
    if (meterRaf) {
      cancelAnimationFrame(meterRaf);
      meterRaf = 0;
    }
    if (meter) {
      meter.stop();
      meter = null;
    }
    if (ownStream && meterStream) for (const t of meterStream.getTracks()) t.stop();
    if (ownCtx && meterCtx) meterCtx.close().catch(() => {});
    meterStream = null;
    meterCtx = null;
    ownStream = false;
    ownCtx = false;
    fill.style.width = "0%";
    fill.classList.remove("open");
  }

  // Watching the class beats asking the app for an onClose hook: whatever
  // route the modal takes to hidden — Done, ✕, Escape — it ends up here.
  new MutationObserver(() => {
    if (root.classList.contains("hidden")) stopMeter();
  }).observe(root, { attributes: true, attributeFilter: ["class"] });

  /* ----------------------------------------------------------- devices */

  async function populateOutputs() {
    let outputs = [];
    try {
      ({ outputs } = await listDevices());
    } catch {}
    output.textContent = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "System default";
    output.appendChild(def);
    for (const dev of outputs) {
      if (!dev.deviceId || dev.deviceId === "default") continue; // that's the entry above
      const opt = document.createElement("option");
      opt.value = dev.deviceId;
      opt.textContent = dev.label;
      output.appendChild(opt);
    }
    // A device that's been unplugged since it was saved simply isn't in the
    // list any more, and this quietly falls back to the system default.
    output.value = hooks.settings().outputId || "";
  }

  async function testTone() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    let aimed = typeof ctx.setSinkId === "function";
    if (aimed) {
      try {
        await ctx.setSinkId(hooks.settings().outputId || "");
      } catch {
        aimed = false;
      }
    }
    const t0 = ctx.currentTime;
    for (const [freq, start, dur] of [
      [660, 0, 0.12],
      [880, 0.14, 0.22],
    ]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + start + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(t0 + start);
      osc.stop(t0 + start + dur + 0.05);
    }
    setTimeout(() => ctx.close().catch(() => {}), 800);
    if (!aimed) hooks.toast("Played on the system default — this browser can't aim audio at one device.", true);
  }

  /* ------------------------------------------------------------ wiring */

  function refresh() {
    const s = hooks.settings();
    gate.value = s.noiseGate || 0;
    echo.checked = s.echoCancel !== false;
    ns.checked = s.noiseSuppress !== false;
    agc.checked = s.agc !== false;
    stereo.checked = !!s.stereo;
    // Stereo forces echo cancellation off in the constraints, so show that
    // rather than leave a checkbox claiming something that isn't true.
    echo.disabled = !!s.stereo;
    shareQ.value = s.shareQuality || SHARE_QUALITY[0].id;
    shareAudio.checked = !!s.shareAudio;
    paintGate();
  }

  gate.oninput = () => {
    hooks.settings().noiseGate = Number(gate.value);
    hooks.voice.setGate(Number(gate.value)); // live, mid-sentence
    paintGate();
  };
  gate.onchange = () => hooks.save(); // once, on release — not 100 times a drag

  const constraintToggle = (input, key) => {
    input.onchange = () => {
      hooks.settings()[key] = input.checked;
      hooks.save();
      hooks.voice.applyAudioSettings();
    };
  };
  constraintToggle(echo, "echoCancel");
  constraintToggle(ns, "noiseSuppress");
  constraintToggle(agc, "agc");

  stereo.onchange = () => {
    const s = hooks.settings();
    s.stereo = stereo.checked;
    hooks.save();
    echo.disabled = stereo.checked;
    hooks.voice.applyAudioSettings(); // channel count is a constraint
    hooks.voice.applyBitrate(); // …but the bitrate is just sender params
  };

  output.onchange = () => {
    hooks.settings().outputId = output.value;
    hooks.save();
    hooks.voice.setOutputDevice(output.value);
  };
  q("set-output-test").onclick = testTone;

  shareQ.onchange = () => {
    hooks.settings().shareQuality = shareQ.value;
    hooks.save();
  };
  shareAudio.onchange = () => {
    hooks.settings().shareAudio = shareAudio.checked;
    hooks.save();
  };

  refresh();
  hooks.onSettingsOpen(() => {
    refresh();
    populateOutputs();
    startMeter();
  });
}

/* ------------------------------------------------------- quality readout */

const Q_CLASSES = ["q-excellent", "q-good", "q-ok", "q-poor"];
let qTimer = null;
let qNode = null;

// The panel title may carry a "↗" meaning the call is in another server.
// This readout is a guest in that element — it doesn't get to drop it.
function arrowOf(node) {
  return node.textContent.includes("↗") ? " ↗" : "";
}

function resetQuality(node) {
  node.textContent = "Voice Connected" + arrowOf(node);
  node.classList.remove(...Q_CLASSES);
  node.removeAttribute("title");
}

const ms = (n) => (n == null ? "—" : Math.round(n) + "ms");

export function startQualityMeter(hooks) {
  stopQualityMeter();
  const node = hooks.qualityEl?.();
  if (!node) return;
  qNode = node;
  const tick = async () => {
    if (!hooks.voice.connected) {
      stopQualityMeter(); // nothing to measure, and nothing to keep polling for
      return;
    }
    let s = null;
    try {
      s = await hooks.voice.stats();
    } catch {}
    // No inbound RTP yet (alone in the channel, or still connecting) is not
    // the same as a bad connection — say nothing rather than guess.
    if (!s || !s.samples) {
      resetQuality(node);
      return;
    }
    const label = qualityLabel(s);
    node.textContent = `Voice ${label.label}${arrowOf(node)}`;
    node.classList.remove(...Q_CLASSES);
    node.classList.add(label.cls);
    node.title =
      `${ms(s.rtt)} ping · ${s.loss.toFixed(1)}% loss · ${s.kbps.toFixed(0)} kbps · ${ms(s.jitter)} jitter` +
      (s.peers > 1 ? ` · worst of ${s.peers} peers` : "");
  };
  tick();
  qTimer = setInterval(tick, 2000);
}

export function stopQualityMeter() {
  if (qTimer) {
    clearInterval(qTimer);
    qTimer = null;
  }
  if (qNode) {
    resetQuality(qNode);
    qNode = null;
  }
}
