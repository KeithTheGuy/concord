// GORB — Concord's uninvited mascot.
// A large idiot creature that wanders the entire page while you use it,
// stops to do bits, and makes noises. Purely decorative: the whole thing is
// pointer-events:none so it can never intercept a click, it respects the
// app's sound setting and prefers-reduced-motion, and stop() removes every
// trace of it.

const SIZE = 150; // px tall — "big", as requested
const GROUND = 12; // px above the bottom edge
const SPEED = 78; // px per second
const KO_AT = 5; // squirts before Gorb gives up on life

const ACTIONS = ["wave", "spit", "dance", "nap", "look", "tap"];
const LINES = {
  wave: ["hi", "hey", "sup", "howdy"],
  spit: ["ptoo!", "hawk— ptoo", "*spits*"],
  dance: ["♪ ♫", "unf unf unf", "boogie"],
  nap: ["zzz", "just resting my eyes", "5 more minutes"],
  look: ["hm?", "what's that", "who's he"],
  tap: ["*tap tap*", "lemme in", "hello???"],
};

const CSS = `
#gorb { position:fixed; z-index:8800; pointer-events:none; width:${SIZE * 0.86}px; height:${SIZE}px;
  will-change: transform; transition: filter .2s; }
#gorb svg { width:100%; height:100%; overflow:visible; display:block; }
#gorb.flip { transform: scaleX(-1); }

@keyframes gorb-step-a { 0%,100%{transform:rotate(-16deg)} 50%{transform:rotate(16deg)} }
@keyframes gorb-step-b { 0%,100%{transform:rotate(16deg)} 50%{transform:rotate(-16deg)} }
@keyframes gorb-bob   { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-5px)} }
@keyframes gorb-wave  { 0%,100%{transform:rotate(8deg)} 50%{transform:rotate(-58deg)} }
@keyframes gorb-boogie{ 0%,100%{transform:rotate(-9deg) translateY(0)} 50%{transform:rotate(9deg) translateY(-11px)} }
@keyframes gorb-snore { 0%,100%{transform:scale(1,1)} 50%{transform:scale(1.05,.95)} }
@keyframes gorb-tap   { 0%,100%{transform:rotate(-6deg)} 50%{transform:rotate(-64deg)} }
@keyframes gorb-spit-fly { to { transform: translate(var(--gorb-fx), var(--gorb-fy)) scale(.4); opacity:0 } }
@keyframes gorb-zzz { to { transform: translate(26px,-46px) scale(1.5); opacity:0 } }
@keyframes gorb-say { 0%{transform:translateY(6px) scale(.8);opacity:0} 12%{transform:none;opacity:1}
                      82%{transform:none;opacity:1} 100%{transform:translateY(-8px);opacity:0} }

#gorb .leg-l { transform-origin: 50% 8%; animation: gorb-step-a .46s ease-in-out infinite; }
#gorb .leg-r { transform-origin: 50% 8%; animation: gorb-step-b .46s ease-in-out infinite; }
#gorb .torso { transform-origin: 50% 90%; animation: gorb-bob .46s ease-in-out infinite; }
#gorb .arm-l { transform-origin: 78% 12%; }
#gorb .arm-r { transform-origin: 22% 12%; }

#gorb.idle .leg-l, #gorb.idle .leg-r { animation: none; }
#gorb.idle .torso { animation: none; }
#gorb.act-wave .arm-r { animation: gorb-wave .5s ease-in-out infinite; }
#gorb.act-tap .arm-r  { animation: gorb-tap .28s ease-in-out infinite; }
#gorb.act-dance .torso { animation: gorb-boogie .34s ease-in-out infinite; }
#gorb.act-nap .torso   { animation: gorb-snore 1.7s ease-in-out infinite; }

.gorb-spit { position:fixed; z-index:8790; pointer-events:none; width:13px; height:13px; border-radius:50%;
  background:#9fe6b4; box-shadow:0 0 6px rgba(0,0,0,.35); animation: gorb-spit-fly .85s ease-in forwards; }
.gorb-zzz { position:fixed; z-index:8810; pointer-events:none; font-size:26px;
  animation: gorb-zzz 1.6s ease-out forwards; }
.gorb-say { position:fixed; z-index:8820; pointer-events:none; background:#1e1f22; color:#f2f3f5;
  border:1px solid #3a3c42; border-radius:12px; padding:6px 12px; font-size:14px; font-weight:600;
  font-family:"Segoe UI",system-ui,sans-serif; white-space:nowrap; box-shadow:0 6px 18px rgba(0,0,0,.45);
  animation: gorb-say 2.1s ease-out forwards; }

/* --- squirt gun --- */
@keyframes gorb-squirt { to { transform: translate(var(--sx), var(--sy)) scale(.45); opacity: .1 } }
@keyframes gorb-splash { from { transform: translate(-50%,-50%) scale(.3); opacity: 1 }
                         to   { transform: translate(-50%,-50%) scale(1.9); opacity: 0 } }
@keyframes gorb-flinch { 0%,100%{ filter:none } 50%{ filter: brightness(1.6) saturate(.4) } }

body.gorb-armed, body.gorb-armed * { cursor: crosshair !important; }
#gorb-gun { position:fixed; left:50%; bottom:-14px; z-index:8850; pointer-events:none;
  font-size:58px; transform-origin:50% 78%; transition: transform .06s linear;
  filter: drop-shadow(0 4px 10px rgba(0,0,0,.5)); }
.gorb-drop { position:fixed; width:11px; height:11px; border-radius:50%; z-index:8830; pointer-events:none;
  background:#8ddcff; box-shadow:0 0 9px rgba(141,220,255,.9); animation: gorb-squirt .3s linear forwards; }
.gorb-splash { position:fixed; z-index:8840; pointer-events:none; font-size:40px;
  animation: gorb-splash .5s ease-out forwards; }
#gorb.soggy { filter: brightness(.84) saturate(.6); }
#gorb.hit { animation: gorb-flinch .22s ease-in-out 2; }
#gorb.ko .torso, #gorb.ko .leg-l, #gorb.ko .leg-r { animation: none !important; }

@media (prefers-reduced-motion: reduce) { #gorb, #gorb-gun { display:none } }
`;

// Static markup — no user content is ever interpolated into it.
const BODY = `
<svg viewBox="0 0 86 120" aria-hidden="true">
  <g class="legs">
    <g class="leg-l"><rect x="20" y="86" width="15" height="30" rx="7" fill="#2f7d4f"/>
      <ellipse cx="26" cy="116" rx="12" ry="6" fill="#256b42"/></g>
    <g class="leg-r"><rect x="51" y="86" width="15" height="30" rx="7" fill="#2f7d4f"/>
      <ellipse cx="59" cy="116" rx="12" ry="6" fill="#256b42"/></g>
  </g>
  <g class="torso">
    <g class="arm-l"><rect x="0" y="46" width="13" height="34" rx="6.5" fill="#2f7d4f"/></g>
    <g class="arm-r"><rect x="73" y="46" width="13" height="34" rx="6.5" fill="#2f7d4f"/></g>
    <path d="M43 6 C68 6 80 26 80 52 C80 80 66 94 43 94 C20 94 6 80 6 52 C6 26 18 6 43 6 Z" fill="#3aa15f"/>
    <path d="M43 40 C60 40 70 50 70 66 C70 82 58 90 43 90 C28 90 16 82 16 66 C16 50 26 40 43 40 Z" fill="#8fd8a6" opacity=".55"/>
    <path d="M14 14 L8 0 L26 8 Z" fill="#3aa15f"/>
    <path d="M72 14 L78 0 L60 8 Z" fill="#3aa15f"/>
    <ellipse cx="30" cy="46" rx="13" ry="14.5" fill="#fff"/>
    <ellipse cx="57" cy="46" rx="13" ry="14.5" fill="#fff"/>
    <circle class="pupil" data-eye="l" cx="30" cy="47" r="5.6" fill="#12261a"/>
    <circle class="pupil" data-eye="r" cx="57" cy="47" r="5.6" fill="#12261a"/>
    <g class="ko-eyes" opacity="0" stroke="#12261a" stroke-width="4.2" stroke-linecap="round">
      <path d="M23 39 L37 53 M37 39 L23 53"/>
      <path d="M50 39 L64 53 M64 39 L50 53"/>
    </g>
    <path class="mouth" d="M30 68 Q43 80 56 68" stroke="#12261a" stroke-width="4.5" fill="none" stroke-linecap="round"/>
  </g>
</svg>`;

let el = null;
let raf = null;
let hooks = { sounds: () => true };
let audio = null;
let running = false;
let pointer = { x: innerWidth / 2, y: innerHeight / 2 };

const walker = {
  x: 60,
  y: 0, // px above ground
  dir: 1,
  mode: "walk",
  until: 0,
  climbTo: 0,
};

/* -------------------------------- audio --------------------------------- */

function ctx() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === "suspended") audio.resume().catch(() => {});
  return audio;
}

function tone({ type = "sine", from, to, dur, gain = 0.05, when = 0 }) {
  if (!hooks.sounds()) return;
  const c = ctx();
  const t0 = c.currentTime + when;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t0);
  if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function noiseBurst(dur = 0.22, gain = 0.07) {
  if (!hooks.sounds()) return;
  const c = ctx();
  const frames = Math.floor(c.sampleRate * dur);
  const buffer = c.createBuffer(1, frames, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames); // decaying hiss
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = 1800;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter);
  filter.connect(g);
  g.connect(c.destination);
  src.start();
}

const SOUNDS = {
  wave: () => tone({ from: 620, to: 940, dur: 0.16, gain: 0.045 }),
  spit: () => {
    tone({ type: "sawtooth", from: 320, to: 90, dur: 0.18, gain: 0.05 });
    setTimeout(() => noiseBurst(0.3, 0.075), 170);
  },
  dance: () => {
    tone({ type: "square", from: 300, to: 620, dur: 0.12, gain: 0.04 });
    tone({ type: "square", from: 400, to: 780, dur: 0.12, gain: 0.04, when: 0.16 });
  },
  nap: () => tone({ type: "sawtooth", from: 92, to: 62, dur: 0.7, gain: 0.05 }),
  look: () => tone({ from: 780, to: 520, dur: 0.12, gain: 0.035 }),
  tap: () => {
    for (let i = 0; i < 3; i++) tone({ type: "square", from: 190, to: 120, dur: 0.06, gain: 0.05, when: i * 0.16 });
  },
  step: () => tone({ type: "sine", from: 110, to: 70, dur: 0.05, gain: 0.022 }),
  squirt: () => {
    noiseBurst(0.2, 0.055);
    tone({ from: 880, to: 1750, dur: 0.17, gain: 0.03 });
  },
  splash: () => noiseBurst(0.24, 0.05),
  yelp: () => tone({ type: "square", from: 700, to: 1250, dur: 0.14, gain: 0.06 }),
  ko: () => tone({ type: "sawtooth", from: 420, to: 68, dur: 0.85, gain: 0.06 }),
};

/* ------------------------------- helpers -------------------------------- */

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

function say(text) {
  if (!el) return;
  const bubble = document.createElement("div");
  bubble.className = "gorb-say";
  bubble.textContent = text;
  document.body.appendChild(bubble);
  const box = el.getBoundingClientRect();
  bubble.style.left = Math.min(innerWidth - 170, Math.max(8, box.left + box.width / 2 - 40)) + "px";
  bubble.style.top = Math.max(8, box.top - 34) + "px";
  setTimeout(() => bubble.remove(), 2200);
}

function spit() {
  if (!el) return;
  const box = el.getBoundingClientRect();
  const drop = document.createElement("div");
  drop.className = "gorb-spit";
  drop.style.left = box.left + box.width * (walker.dir > 0 ? 0.72 : 0.28) + "px";
  drop.style.top = box.top + box.height * 0.55 + "px";
  drop.style.setProperty("--gorb-fx", walker.dir * rand(90, 150) + "px");
  drop.style.setProperty("--gorb-fy", rand(40, 80) + "px");
  document.body.appendChild(drop);
  setTimeout(() => drop.remove(), 900);
}

function zzz() {
  if (!el) return;
  const box = el.getBoundingClientRect();
  const z = document.createElement("div");
  z.className = "gorb-zzz";
  z.textContent = "💤";
  z.style.left = box.left + box.width * 0.7 + "px";
  z.style.top = box.top + "px";
  document.body.appendChild(z);
  setTimeout(() => z.remove(), 1700);
}

function setMouth(d) {
  const mouth = el?.querySelector(".mouth");
  if (mouth) mouth.setAttribute("d", d);
}

const MOUTH_GRIN = "M30 68 Q43 80 56 68";
const MOUTH_OH = "M36 68 Q43 82 50 68 Q43 74 36 68";
const MOUTH_FLAT = "M32 72 L54 72";

function beginAction(name) {
  walker.mode = name;
  walker.until = performance.now() + (name === "nap" ? 3400 : name === "dance" ? 2600 : 1900);
  el.classList.add("idle", "act-" + name);
  SOUNDS[name]?.();
  if (Math.random() < 0.8) say(pick(LINES[name]));

  if (name === "spit") {
    setMouth(MOUTH_OH);
    setTimeout(spit, 190);
  } else if (name === "nap") {
    setMouth(MOUTH_FLAT);
    zzz();
    const naps = setInterval(zzz, 900);
    setTimeout(() => clearInterval(naps), 3300);
  }
}

function endAction() {
  el.className = el.classList.contains("flip") ? "flip" : "";
  setMouth(MOUTH_GRIN);
  walker.mode = "walk";
  walker.until = performance.now() + rand(2600, 6000);
  // Sometimes climb the wall instead of trudging along the floor.
  walker.climbTo = Math.random() < 0.25 ? rand(80, innerHeight * 0.55) : 0;
}

/* ------------------------------- main loop ------------------------------- */

let lastFrame = 0;
let lastStepSound = 0;

function frame(now) {
  if (!running) return;
  const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
  lastFrame = now;

  if (walker.mode === "ko") {
    // Out cold: he stays where he fell, lying on his side.
    el.style.transform = `translate(${walker.x}px, 0px) rotate(90deg)`;
    raf = requestAnimationFrame(frame);
    return;
  }

  if (walker.mode === "walk") {
    // Every soaking slows him down a little.
    walker.x += SPEED * Math.max(0.45, 1 - hits * 0.13) * walker.dir * dt;
    const maxX = innerWidth - SIZE * 0.86;
    if (walker.x < 4) {
      walker.x = 4;
      walker.dir = 1;
    } else if (walker.x > maxX) {
      walker.x = maxX;
      walker.dir = -1;
    }
    // Ease toward the current target height (floor, or partway up the wall).
    walker.y += (walker.climbTo - walker.y) * Math.min(1, dt * 1.6);

    if (now - lastStepSound > 460) {
      lastStepSound = now;
      if (Math.random() < 0.5) SOUNDS.step();
    }
    if (now > walker.until) beginAction(pick(ACTIONS));
  } else if (now > walker.until) {
    endAction();
  }

  el.classList.toggle("flip", walker.dir < 0);
  el.style.transform = `translate(${walker.x}px, ${-walker.y}px)` + (walker.dir < 0 ? " scaleX(-1)" : "");

  // Eyes follow the pointer.
  const box = el.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height * 0.4;
  const dx = Math.max(-1, Math.min(1, (pointer.x - cx) / 320));
  const dy = Math.max(-1, Math.min(1, (pointer.y - cy) / 320));
  for (const pupil of el.querySelectorAll(".pupil")) {
    const base = pupil.dataset.eye === "l" ? 30 : 57;
    pupil.setAttribute("cx", base + dx * 3.6 * (walker.dir < 0 ? -1 : 1));
    pupil.setAttribute("cy", 47 + dy * 3.6);
  }

  raf = requestAnimationFrame(frame);
}

const trackPointer = (e) => {
  pointer = { x: e.clientX, y: e.clientY };
  aimGun();
};

/* ------------------------------ squirt gun ------------------------------- */

let armed = false;
let gun = null;
let hits = 0;
let koTimer = null;

const GUN_X = () => innerWidth / 2;
const GUN_Y = () => innerHeight - 34;

function aimGun() {
  if (!gun) return;
  const angle = (Math.atan2(pointer.y - innerHeight, pointer.x - GUN_X()) * 180) / Math.PI;
  // The water-pistol glyph points left, so undo that 180 to aim it.
  gun.style.transform = `translateX(-50%) rotate(${angle - 180}deg)`;
}

function fire(e) {
  if (!armed || !running) return;
  const gx = GUN_X();
  const gy = GUN_Y();
  const tx = e.clientX;
  const ty = e.clientY;
  SOUNDS.squirt();
  const jitter = () => (Math.random() - 0.5) * 24;
  for (let i = 0; i < 9; i++) {
    const drop = document.createElement("div");
    drop.className = "gorb-drop";
    drop.style.left = gx + jitter() * 0.4 + "px";
    drop.style.top = gy + "px";
    drop.style.setProperty("--sx", tx - gx + jitter() + "px");
    drop.style.setProperty("--sy", ty - gy + jitter() + "px");
    drop.style.animationDelay = i * 14 + "ms";
    document.body.appendChild(drop);
    setTimeout(() => drop.remove(), 500 + i * 14);
  }
  // Hit is tested when the water lands, not when you click — so he can dodge.
  setTimeout(() => impact(tx, ty), 300);
}

function impact(x, y) {
  const splash = document.createElement("div");
  splash.className = "gorb-splash";
  splash.textContent = "💦";
  splash.style.left = x + "px";
  splash.style.top = y + "px";
  document.body.appendChild(splash);
  setTimeout(() => splash.remove(), 520);
  SOUNDS.splash();

  if (!el || walker.mode === "ko") return;
  const box = el.getBoundingClientRect();
  const pad = 14;
  const hit =
    x >= box.left - pad && x <= box.right + pad && y >= box.top - pad && y <= box.bottom + pad;
  if (hit) registerHit();
}

function registerHit() {
  hits++;
  hooks.onHits?.(hits);
  SOUNDS.yelp();
  el.classList.add("hit");
  setTimeout(() => el?.classList.remove("hit"), 480);
  if (hits >= 2) el.classList.add("soggy");

  if (hits >= KO_AT) {
    knockOut();
    return;
  }
  say(pick(["HEY", "ow", "stop it", "rude!", "that's WATER", "im telling", "not the face"]));
  // Bolt in the other direction — he's not going to stand there and take it.
  walker.mode = "walk";
  walker.dir = pointer.x > el.getBoundingClientRect().left ? -1 : 1;
  walker.until = performance.now() + rand(2200, 3800);
}

function knockOut(silent = false) {
  walker.mode = "ko";
  walker.until = Infinity;
  el.classList.add("ko", "soggy");
  el.style.transformOrigin = "50% 100%";
  setMouth(MOUTH_FLAT);
  el.querySelector(".ko-eyes")?.setAttribute("opacity", "1");
  for (const pupil of el.querySelectorAll(".pupil")) pupil.setAttribute("opacity", "0");
  if (!silent) {
    say("goodnight");
    SOUNDS.ko();
  }
  zzz();
  if (koTimer) clearInterval(koTimer);
  koTimer = setInterval(zzz, 1700);
}

export function setSquirt(on) {
  armed = !!on;
  document.body.classList.toggle("gorb-armed", armed);
  if (armed) {
    if (!gun) {
      gun = document.createElement("div");
      gun.id = "gorb-gun";
      gun.textContent = "🔫";
      document.body.appendChild(gun);
    }
    aimGun();
    // Capture phase, but nothing is prevented — the app stays fully usable.
    window.addEventListener("click", fire, true);
    window.addEventListener("keydown", escDisarm, true);
  } else {
    gun?.remove();
    gun = null;
    window.removeEventListener("click", fire, true);
    window.removeEventListener("keydown", escDisarm, true);
  }
  return armed;
}

function escDisarm(e) {
  if (e.key !== "Escape") return;
  setSquirt(false);
  hooks.onSquirt?.(false);
}

export function reviveMascot() {
  hits = 0;
  hooks.onHits?.(0);
  if (koTimer) {
    clearInterval(koTimer);
    koTimer = null;
  }
  if (!el) return;
  el.classList.remove("ko", "soggy", "hit");
  el.style.transformOrigin = "";
  el.querySelector(".ko-eyes")?.setAttribute("opacity", "0");
  for (const pupil of el.querySelectorAll(".pupil")) pupil.setAttribute("opacity", "1");
  setMouth(MOUTH_GRIN);
  walker.mode = "walk";
  walker.until = performance.now() + 1400;
  say("i'm back");
}

export const mascotDown = () => walker.mode === "ko";

/* --------------------------------- api ---------------------------------- */

export function startMascot(opts = {}) {
  if (running) return;
  hooks = { sounds: () => true, ...opts };

  if (!document.getElementById("gorb-style")) {
    const style = document.createElement("style");
    style.id = "gorb-style";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  el = document.createElement("div");
  el.id = "gorb";
  el.innerHTML = BODY; // static markup only
  el.style.left = "0px";
  el.style.bottom = GROUND + "px";
  document.body.appendChild(el);

  walker.x = rand(40, Math.max(80, innerWidth - 240));
  walker.y = 0;
  walker.dir = Math.random() < 0.5 ? 1 : -1;
  walker.mode = "walk";
  walker.until = performance.now() + rand(1800, 4000);
  walker.climbTo = 0;

  window.addEventListener("mousemove", trackPointer);
  running = true;
  lastFrame = 0;
  raf = requestAnimationFrame(frame);

  // Restore how soaked he was last time; if he was out, he stays out.
  hits = Math.max(0, Number(opts.hits) || 0);
  if (hits >= 2) el.classList.add("soggy");
  if (hits >= KO_AT) knockOut(true);
  else setTimeout(() => running && walker.mode !== "ko" && say("i live here now"), 900);
}

export function stopMascot() {
  running = false;
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (koTimer) {
    clearInterval(koTimer);
    koTimer = null;
  }
  setSquirt(false);
  window.removeEventListener("mousemove", trackPointer);
  el?.remove();
  el = null;
  for (const leftover of document.querySelectorAll(".gorb-spit, .gorb-zzz, .gorb-say, .gorb-drop, .gorb-splash")) {
    leftover.remove();
  }
}

export const mascotRunning = () => running;
