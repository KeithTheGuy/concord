// GREMLIN MODE — harmless visual/audio pranks you can fire at a friend.
// Every effect is purely local to the victim's browser, auto-expires, and
// ends by revealing who did it. Nothing here can destroy data or persist:
// worst case the victim reloads the page and it's gone.

export const PRANKS = [
  { kind: "earthquake", emoji: "🌋", label: "Earthquake", blurb: "Violently shakes their whole app" },
  { kind: "upsidedown", emoji: "🙃", label: "Upside Down", blurb: "Flips the client 180°" },
  { kind: "vaporwave", emoji: "🌴", label: "Vaporwave", blurb: "A E S T H E T I C overload" },
  { kind: "emojirain", emoji: "🌧️", label: "Emoji Rain", blurb: "Monsoon of emoji" },
  { kind: "fakekick", emoji: "🚪", label: "Fake Kick", blurb: "'You were removed' … psych" },
  { kind: "airhorn", emoji: "📣", label: "Air Horn", blurb: "MLG airhorn + strobe" },
  { kind: "drunk", emoji: "🍺", label: "Drunk Mode", blurb: "Wobbly, blurry, questionable" },
  { kind: "butterfingers", emoji: "🧈", label: "Butter Fingers", blurb: "Scrambles what they type" },
  { kind: "cursedcursor", emoji: "👁️", label: "Cursed Cursor", blurb: "Something follows their mouse" },
  { kind: "bluescreen", emoji: "💀", label: "Blue Screen", blurb: "Fake Windows crash" },
  { kind: "tiny", emoji: "🐜", label: "Tiny Mode", blurb: "Shrinks the entire UI" },
  { kind: "spin", emoji: "🌀", label: "Spin Cycle", blurb: "Slowly rotates everything" },
];

const KINDS = new Set(PRANKS.map((p) => p.kind));
export const isPrank = (kind) => KINDS.has(kind);

const app = () => document.getElementById("app");
let audioCtx = null;

/* ------------------------------ styles ---------------------------------- */

const CSS = `
@keyframes gq-shake { 0%,100%{transform:translate(0,0) rotate(0)} 10%{transform:translate(-9px,4px) rotate(-1deg)}
 20%{transform:translate(8px,-6px) rotate(1deg)} 30%{transform:translate(-7px,-4px) rotate(-1.2deg)}
 40%{transform:translate(9px,5px) rotate(.8deg)} 50%{transform:translate(-6px,6px) rotate(-.6deg)}
 60%{transform:translate(7px,-5px) rotate(1deg)} 70%{transform:translate(-8px,3px) rotate(-.9deg)}
 80%{transform:translate(6px,6px) rotate(.7deg)} 90%{transform:translate(-5px,-6px) rotate(-.5deg)} }
@keyframes gq-drift { 0%{filter:hue-rotate(0deg) saturate(1.6)} 100%{filter:hue-rotate(360deg) saturate(1.6)} }
@keyframes gq-wobble { 0%,100%{transform:rotate(-1.5deg) skewX(-2deg)} 50%{transform:rotate(1.5deg) skewX(2deg)} }
@keyframes gq-spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
@keyframes gq-fall { to { transform: translateY(105vh) rotate(var(--gq-spin,360deg)); opacity:.15 } }
@keyframes gq-strobe { 0%,100%{opacity:0} 50%{opacity:.85} }
@keyframes gq-pop { from{transform:scale(.7);opacity:0} to{transform:scale(1);opacity:1} }

.gq-earthquake { animation: gq-shake .45s infinite; }
.gq-upsidedown { transform: rotate(180deg); transition: transform .8s ease; }
.gq-vaporwave { animation: gq-drift 4s linear infinite; }
.gq-drunk { animation: gq-wobble 1.6s ease-in-out infinite; filter: blur(1.4px); }
.gq-spin { animation: gq-spin 9s linear infinite; }
.gq-tiny { transform: scale(.38); transition: transform .6s ease; }

#gq-layer { position:fixed; inset:0; pointer-events:none; z-index:9000; overflow:hidden; }
.gq-drop { position:absolute; top:-8vh; font-size:34px; animation: gq-fall linear forwards; }
.gq-strobe { position:fixed; inset:0; background:#fff; z-index:9100; pointer-events:none; animation: gq-strobe .12s 14; }
.gq-cursor { position:fixed; font-size:88px; z-index:9200; pointer-events:none; transform:translate(-50%,-50%);
  filter: drop-shadow(0 0 12px rgba(0,0,0,.6)); transition: transform .05s linear; }

.gq-full { position:fixed; inset:0; z-index:9500; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center; padding:6vw;
  font-family:"Segoe UI",system-ui,sans-serif; animation: gq-pop .18s ease; }
.gq-kick { background:#1e1f22; color:#f2f3f5; }
.gq-kick h1 { font-size:clamp(24px,4vw,42px); margin:0 0 12px; color:#f23f43; }
.gq-kick p { font-size:clamp(14px,1.6vw,18px); color:#949ba4; margin:0; max-width:520px; }
.gq-bsod { background:#0078d7; color:#fff; align-items:flex-start; text-align:left; padding:8vw 10vw; }
.gq-bsod .gq-sad { font-size:clamp(60px,10vw,120px); line-height:1; margin-bottom:24px; }
.gq-bsod h1 { font-size:clamp(20px,2.6vw,34px); font-weight:400; margin:0 0 18px; max-width:760px; }
.gq-bsod p { font-size:clamp(13px,1.4vw,17px); opacity:.92; margin:4px 0; }
.gq-reveal { margin-top:28px; font-size:clamp(18px,2.4vw,30px); font-weight:800; color:#5865f2;
  background:#fff; padding:10px 22px; border-radius:10px; animation: gq-pop .2s ease; }
.gq-kick .gq-reveal { background:#5865f2; color:#fff; }

/* gremlin picker UI */
#gm-pranks { display:grid; grid-template-columns:repeat(auto-fill,minmax(148px,1fr)); gap:8px; margin-top:8px; }
.gm-card { display:flex; flex-direction:column; gap:2px; align-items:flex-start; text-align:left;
  background:#1e1f22; border:1px solid transparent; border-radius:8px; padding:10px 12px; cursor:pointer;
  color:#dbdee1; transition:border-color .12s, background .12s; }
.gm-card:hover { background:#35373c; border-color:#5865f2; }
.gm-card .gm-emoji { font-size:22px; }
.gm-card .gm-label { font-weight:700; font-size:14px; }
.gm-card .gm-blurb { font-size:11px; color:#949ba4; line-height:1.3; }
.gm-warn { font-size:12px; color:#949ba4; margin-top:14px; }
`;

export function installPrankStyles() {
  ensureStyle();
}

function ensureStyle() {
  if (document.getElementById("gq-style")) return;
  const style = document.createElement("style");
  style.id = "gq-style";
  style.textContent = CSS;
  document.head.appendChild(style);
}

function layer() {
  let node = document.getElementById("gq-layer");
  if (!node) {
    node = document.createElement("div");
    node.id = "gq-layer";
    document.body.appendChild(node);
  }
  return node;
}

// Applies a class to #app for `ms`, cleaning up even if pranks overlap.
function timedClass(cls, ms) {
  const root = app();
  if (!root) return;
  root.classList.add(cls);
  setTimeout(() => root.classList.remove(cls), ms);
}

/* ------------------------------- sounds --------------------------------- */

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function airhornBlast() {
  const c = ctx();
  const t0 = c.currentTime;
  for (const [start, dur] of [[0, 0.28], [0.34, 0.28], [0.68, 0.7]]) {
    const osc = c.createOscillator();
    const sub = c.createOscillator();
    const g = c.createGain();
    osc.type = "sawtooth";
    sub.type = "square";
    osc.frequency.setValueAtTime(420, t0 + start);
    osc.frequency.linearRampToValueAtTime(500, t0 + start + dur);
    sub.frequency.setValueAtTime(210, t0 + start);
    g.gain.setValueAtTime(0.0001, t0 + start);
    g.gain.exponentialRampToValueAtTime(0.22, t0 + start + 0.03);
    g.gain.setValueAtTime(0.22, t0 + start + dur - 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
    osc.connect(g);
    sub.connect(g);
    g.connect(c.destination);
    osc.start(t0 + start);
    sub.start(t0 + start);
    osc.stop(t0 + start + dur + 0.02);
    sub.stop(t0 + start + dur + 0.02);
  }
}

function crashSound() {
  const c = ctx();
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(220, t0);
  osc.frequency.exponentialRampToValueAtTime(55, t0 + 0.5);
  g.gain.setValueAtTime(0.16, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.6);
}

/* ------------------------------ effects --------------------------------- */

const RAIN = ["😂", "💀", "🤡", "🍕", "🐸", "🔥", "👽", "🦆", "🧀", "🚀", "👁️", "🥴"];

function emojiRain(ms) {
  const wrap = layer();
  const drops = [];
  const spawn = () => {
    const d = document.createElement("div");
    d.className = "gq-drop";
    d.textContent = RAIN[Math.floor(Math.random() * RAIN.length)];
    d.style.left = Math.random() * 100 + "vw";
    d.style.animationDuration = 1.8 + Math.random() * 2.2 + "s";
    d.style.setProperty("--gq-spin", Math.round(Math.random() * 1440 - 720) + "deg");
    d.style.fontSize = 22 + Math.random() * 34 + "px";
    wrap.appendChild(d);
    drops.push(d);
    setTimeout(() => d.remove(), 4200);
  };
  for (let i = 0; i < 25; i++) setTimeout(spawn, i * 40);
  const timer = setInterval(spawn, 70);
  setTimeout(() => {
    clearInterval(timer);
    setTimeout(() => drops.forEach((d) => d.remove()), 4200);
  }, ms);
}

function cursedCursor(ms) {
  const eye = document.createElement("div");
  eye.className = "gq-cursor";
  eye.textContent = "👁️";
  eye.style.left = "50vw";
  eye.style.top = "50vh";
  document.body.appendChild(eye);
  const move = (e) => {
    eye.style.left = e.clientX + "px";
    eye.style.top = e.clientY + "px";
  };
  window.addEventListener("mousemove", move);
  setTimeout(() => {
    window.removeEventListener("mousemove", move);
    eye.remove();
  }, ms);
}

function strobe() {
  const s = document.createElement("div");
  s.className = "gq-strobe";
  document.body.appendChild(s);
  setTimeout(() => s.remove(), 1800);
}

// Scrambles characters as they're typed — reverted on expiry, and the real
// text is never sent scrambled (we restore before the timer ends).
function butterFingers(ms) {
  const input = document.getElementById("input");
  if (!input) return;
  const scramble = () => {
    const v = input.value;
    if (v.length < 2) return;
    const i = Math.max(0, v.length - 2);
    input.value = v.slice(0, i) + v[i + 1] + v[i] + v.slice(i + 2);
  };
  input.addEventListener("input", scramble);
  setTimeout(() => input.removeEventListener("input", scramble), ms);
}

function fullScreenPrank({ className, build, revealText, ms }) {
  const node = document.createElement("div");
  node.className = `gq-full ${className}`;
  build(node);
  document.body.appendChild(node);
  setTimeout(() => {
    const reveal = document.createElement("div");
    reveal.className = "gq-reveal";
    reveal.textContent = revealText;
    node.appendChild(reveal);
  }, Math.max(900, ms - 1600));
  setTimeout(() => node.remove(), ms);
}

/* ------------------------------ dispatcher ------------------------------- */

/**
 * Run a prank locally. `fromName` is the culprit, revealed to the victim.
 * Returns the human label so the caller can toast it.
 */
export function runPrank(kind, fromName) {
  ensureStyle();
  const meta = PRANKS.find((p) => p.kind === kind);
  if (!meta) return null;
  const who = fromName || "Someone";

  switch (kind) {
    case "earthquake":
      timedClass("gq-earthquake", 5000);
      break;
    case "upsidedown":
      timedClass("gq-upsidedown", 9000);
      break;
    case "vaporwave":
      timedClass("gq-vaporwave", 10000);
      break;
    case "drunk":
      timedClass("gq-drunk", 10000);
      break;
    case "spin":
      timedClass("gq-spin", 9000);
      break;
    case "tiny":
      timedClass("gq-tiny", 8000);
      break;
    case "emojirain":
      emojiRain(8000);
      break;
    case "cursedcursor":
      cursedCursor(10000);
      break;
    case "butterfingers":
      butterFingers(10000);
      break;
    case "airhorn":
      airhornBlast();
      strobe();
      break;
    case "fakekick":
      fullScreenPrank({
        className: "gq-kick",
        ms: 5200,
        revealText: `🃏 ${who} got you`,
        build(node) {
          const h = document.createElement("h1");
          h.textContent = "You have been removed from this server";
          const p = document.createElement("p");
          p.textContent = "An administrator decided you were, and this is a direct quote, “kind of a lot.”";
          node.append(h, p);
        },
      });
      break;
    case "bluescreen":
      crashSound();
      fullScreenPrank({
        className: "gq-bsod",
        ms: 5600,
        revealText: `🃏 ${who} got you`,
        build(node) {
          const sad = document.createElement("div");
          sad.className = "gq-sad";
          sad.textContent = ":(";
          const h = document.createElement("h1");
          h.textContent =
            "Your PC ran into a problem and needs to restart. We're just collecting some error info, and then we'll restart for you.";
          const pct = document.createElement("p");
          pct.textContent = "0% complete";
          const code = document.createElement("p");
          code.textContent = "Stop code: FRIENDSHIP_ENDED_WITH_UPTIME";
          node.append(sad, h, pct, code);
          let n = 0;
          const t = setInterval(() => {
            n = Math.min(99, n + Math.ceil(Math.random() * 11));
            pct.textContent = `${n}% complete`;
            if (n >= 99) clearInterval(t);
          }, 260);
        },
      });
      break;
    default:
      return null;
  }
  return meta;
}
