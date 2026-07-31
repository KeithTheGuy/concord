// The audio half of the Settings modal, plus the call-quality readout in the
// voice panel. This file owns its own markup: it finds the existing Voice
// section and appends to it, so nothing here needs a line of index.html.
//
// Everything it touches from the app arrives through the hooks object, and
// everything it knows about audio comes from voicelab.js.

import { createMeter, micConstraints, listDevices, SHARE_QUALITY, qualityLabel, qualityIssue } from "./voicelab.js";

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
 *   openSettings?(): void,       // app.js owns the modal; without this the
 *                                // voice panel's ⚙ isn't drawn at all,
 *                                // rather than drawn dead
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

  /* ---------------------------------------------------------- panel ⚙ */

  // Everything above lives ~1600px down a settings modal, which is a long way
  // to travel on a hunch. Someone who has just been told their keyboard is
  // deafening needs one button, in the panel they're already looking at, that
  // lands them on the noise gate. Built here rather than in index.html for
  // the same reason the rest of this file is: it isn't ours to edit.
  function installGear() {
    if (!hooks.openSettings) return;
    const row = hooks.qualityEl?.()?.closest(".vs-row");
    if (!row || row.querySelector("#vs-settings")) return;
    const btn = document.createElement("button");
    btn.id = "vs-settings";
    btn.type = "button";
    btn.title = "Audio settings — noise gate, devices, output";
    btn.textContent = "⚙";
    row.insertBefore(btn, row.querySelector("#btn-hangup"));
    btn.onclick = () => {
      hooks.openSettings();
      // One frame, because the modal is only unhidden as openSettings returns
      // and an element with no layout has nothing to scroll to. Not a loop.
      requestAnimationFrame(() => {
        const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        host.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
        host.classList.add("vs-spotlight");
        setTimeout(() => host.classList.remove("vs-spotlight"), 1600);
      });
    };
  }

  refresh();
  installGear();
  hooks.onSettingsOpen(() => {
    refresh();
    populateOutputs();
    startMeter();
  });
}

/* ------------------------------------------------------- quality readout */

// The readout's whole job is to be ignorable. A good call says "Voice
// Connected" and nothing else — no ping, no bitrate, no invitation to worry
// about a number that's fine. The moment something is genuinely wrong, the
// number that's wrong goes on the line, in the danger colour, where you'll
// see it without hovering anything. Silence when healthy, specifics when not.

const Q_CLASSES = ["q-excellent", "q-good", "q-ok", "q-poor", "q-wait"];
let qTimer = null;
let qNode = null;

// The panel title may carry a "↗" meaning the call is in another server.
// This readout is a guest in that element — it doesn't get to drop it.
function arrowOf(node) {
  return node.textContent.includes("↗") ? " ↗" : "";
}

function paint(node, text, cls, title) {
  node.textContent = text + arrowOf(node);
  node.classList.remove(...Q_CLASSES);
  if (cls) node.classList.add(cls);
  if (title) node.title = title;
  else node.removeAttribute("title");
}

function resetQuality(node) {
  paint(node, "Voice Connected", null, null);
}

const ms = (n) => (n == null ? "—" : Math.round(n) + "ms");

// Still worth keeping every number somewhere, just not as the only copy of
// them: this is for the person who wants to read out their ping, not the
// person who needs to know something's wrong.
function detail(s) {
  return (
    `${ms(s.rtt)} ping · ${s.loss.toFixed(1)}% loss · ${s.kbps.toFixed(0)} kbps · ${ms(s.jitter)} jitter` +
    (s.peers > 1 ? ` · worst of ${s.peers} peers` : "")
  );
}

function render(node, s) {
  // Sitting in a voice channel alone is not a working call, and saying
  // "Voice Connected" at someone who is talking to nobody is how you end up
  // testing your microphone for ten minutes. But a peer we've given up on
  // has had its connection closed, so it isn't in `peers` any more — and
  // "waiting for someone else" would be a lie with a red banner underneath
  // naming the person we just lost.
  if (!s || !s.peers) {
    const lost = !!(s && s.troubled);
    paint(node, lost ? "Voice Nobody connected" : "Waiting for someone else…", lost ? "q-poor" : "q-wait", null);
    return;
  }
  if (!s.samples) {
    // Peers exist but no audio has arrived from any of them. Either the
    // handshake is still going, or it already lost — voice.js knows which.
    const stuck = s.troubled >= s.peers;
    paint(node, stuck ? "Voice Nobody connected" : "Voice Connecting…", stuck ? "q-poor" : "q-wait", null);
    return;
  }
  const issue = qualityIssue(s);
  if (!issue) {
    paint(node, "Voice Connected", null, detail(s));
    return;
  }
  let { label, cls } = qualityLabel(s);
  // Jitter isn't in qualityLabel's table, so it can be the only thing wrong
  // with a connection the table still calls Excellent. "Voice Excellent ·
  // 48ms jitter" is a readout arguing with itself.
  if (cls === "q-excellent" || cls === "q-good") {
    label = "Ok";
    cls = "q-ok";
  }
  paint(node, `Voice ${label} · ${issue}`, cls, detail(s));
}

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
    render(node, s);
  };
  tick();
  qTimer = setInterval(tick, 2000);
}

export function stopQualityMeter() {
  if (qTimer) {
    clearInterval(qTimer);
    qTimer = null;
  }
  clearTrouble(); // before qNode goes, since that's how the banner is found
  if (qNode) {
    resetQuality(qNode);
    qNode = null;
  }
}

/* --------------------------------------------------------- peer trouble */

// With no TURN server, a specific pair of people can fail to connect while
// everyone else in the call is fine (README: 5–15% of pairs). Left unsaid,
// that reads as "my mic is broken" or "they're ignoring me" — both wrong,
// and both send someone off fixing the wrong thing. So: name the person, name
// the cause, and say who it doesn't affect.

const troubled = new Map(); // sid -> {name, kind}
let troubleNode = null;

/**
 * The engine's onPeerTrouble hook, with a name attached — voice.js deals in
 * sids and has no idea who anyone is.
 *   kind "unreachable" — never connected. Almost always NAT: no TURN, no route.
 *   kind "dropped"     — was connected, then wasn't. Almost always someone's wifi.
 *   kind "recovered"   — take it back; they're here, or they've left.
 */
export function peerTrouble(sid, kind, name) {
  if (kind === "recovered") troubled.delete(sid);
  else troubled.set(sid, { name: name || "someone", kind });
  renderTrouble();
}

export function clearTrouble() {
  troubled.clear();
  renderTrouble();
}

const listNames = (rows) => {
  const names = rows.map((r) => r.name);
  if (names.length < 3) return names.join(" and ");
  return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
};

function troubleLines() {
  const rows = [...troubled.values()];
  const unreachable = rows.filter((r) => r.kind === "unreachable");
  const dropped = rows.filter((r) => r.kind === "dropped");
  const lines = [];
  // One person you can't reach is the NAT story and it's nobody's fault.
  // Everybody at once is a different story — that one's your end — and
  // telling you four times that it isn't would be actively misleading.
  if (unreachable.length > 1) {
    lines.push(
      `Can't reach ${listNames(unreachable)}. When it's everyone at once it's usually your side — a VPN, or a network that blocks peer-to-peer. Try it off, then rejoin.`
    );
  } else if (unreachable.length === 1) {
    lines.push(
      `Couldn't connect to ${unreachable[0].name} — your two routers won't talk to each other directly. Nothing either of you did, and it doesn't affect anyone else in the call.`
    );
  }
  for (const r of dropped) {
    lines.push(`Lost ${r.name} mid-call — that's usually someone's Wi-Fi, not the app. Either of you rejoining the channel should sort it.`);
  }
  return lines;
}

// Lives under the button row inside #voice-status, which means no line of
// index.html — same deal as the settings controls above.
function troubleHost() {
  if (troubleNode?.isConnected) return troubleNode;
  const panel = qNode?.closest("#voice-status");
  if (!panel) return null;
  troubleNode = panel.querySelector(".vs-trouble");
  if (!troubleNode) {
    troubleNode = document.createElement("div");
    troubleNode.className = "vs-trouble";
    panel.appendChild(troubleNode);
  }
  return troubleNode;
}

function renderTrouble() {
  const host = troubleHost();
  if (!host) return;
  const lines = troubleLines();
  host.textContent = "";
  host.classList.toggle("hidden", !lines.length);
  for (const line of lines) {
    const p = document.createElement("p");
    p.textContent = line;
    host.appendChild(p);
  }
}
