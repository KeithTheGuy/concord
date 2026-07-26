// GREMLIN MODE — harmless visual/audio pranks you can fire at a friend.
// Design rules, all enforced below:
//   * Purely cosmetic: a prank must never alter data the victim sends.
//   * Always escapable: full-screen effects are dismissable by click or Esc.
//   * Safe: flashing stays under the WCAG 2.3.1 three-per-second threshold,
//     and motion-heavy effects are skipped for prefers-reduced-motion users.
//   * Self-cleaning: every effect expires on its own and names its sender.

export const PRANKS = [
  { kind: "earthquake", emoji: "🌋", label: "Earthquake", blurb: "Violently shakes their whole app" },
  { kind: "upsidedown", emoji: "🙃", label: "Upside Down", blurb: "Flips the client 180°" },
  { kind: "vaporwave", emoji: "🌴", label: "Vaporwave", blurb: "A E S T H E T I C overload" },
  { kind: "emojirain", emoji: "🌧️", label: "Emoji Rain", blurb: "Monsoon of emoji" },
  { kind: "fakekick", emoji: "🚪", label: "Fake Kick", blurb: "'You were removed' … psych" },
  { kind: "airhorn", emoji: "📣", label: "Air Horn", blurb: "MLG airhorn + flash" },
  { kind: "drunk", emoji: "🍺", label: "Drunk Mode", blurb: "Wobbly, blurry, questionable" },
  { kind: "butterfingers", emoji: "🧈", label: "Butter Fingers", blurb: "Scrambles what they type" },
  { kind: "cursedcursor", emoji: "👁️", label: "Cursed Cursor", blurb: "Something follows their mouse" },
  { kind: "bluescreen", emoji: "💀", label: "Blue Screen", blurb: "Fake Windows crash" },
  { kind: "tiny", emoji: "🐜", label: "Tiny Mode", blurb: "Shrinks the entire UI" },
  { kind: "spin", emoji: "🌀", label: "Spin Cycle", blurb: "Slowly rotates everything" },
];

const KINDS = new Set(PRANKS.map((p) => p.kind));
export const isPrank = (kind) => KINDS.has(kind);

// Effects that move the viewport; skipped entirely for reduced-motion users.
// emojirain (full-viewport translation) and tiny (whole-UI scale) count too.
const MOTION_KINDS = new Set([
  "earthquake", "spin", "drunk", "upsidedown", "emojirain", "tiny",
]);

const app = () => document.getElementById("app");
const reduceMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

let audioCtx = null;

/* ------------------------------ styles ---------------------------------- */

// Flash timing note: 0.34s per cycle = 2.9 flashes/sec, below the WCAG 2.3.1
// general flash threshold of 3/sec, and peak opacity is kept well under full
// white so the luminance swing stays modest.
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
@keyframes gq-flash { 0%,100%{opacity:0} 50%{opacity:.35} }
@keyframes gq-pop { from{transform:scale(.7);opacity:0} to{transform:scale(1);opacity:1} }

.gq-earthquake { animation: gq-shake .45s infinite; }
.gq-upsidedown { transform: rotate(180deg); transition: transform .8s ease; }
.gq-vaporwave { animation: gq-drift 4s linear infinite; }
.gq-drunk { animation: gq-wobble 1.6s ease-in-out infinite; filter: blur(1.4px); }
.gq-spin { animation: gq-spin 9s linear infinite; }
.gq-tiny { transform: scale(.38); transition: transform .6s ease; }

#gq-layer { position:fixed; inset:0; pointer-events:none; z-index:9000; overflow:hidden; }
.gq-drop { position:absolute; top:-8vh; font-size:34px; animation: gq-fall linear forwards; }
/* opacity:0 in the base rule is load-bearing: without it the element falls
   back to opacity 1 when the animation ends, producing a solid white frame
   that is both an extra flash and the largest luminance jump of the lot. */
.gq-flash { position:fixed; inset:0; background:#fff; z-index:9100; pointer-events:none;
  opacity: 0; animation: gq-flash .34s 4; }
.gq-cursor { position:fixed; font-size:88px; z-index:9200; pointer-events:none; transform:translate(-50%,-50%);
  filter: drop-shadow(0 0 12px rgba(0,0,0,.6)); transition: transform .05s linear; }

.gq-full { position:fixed; inset:0; z-index:9500; display:flex; flex-direction:column;
  align-items:center; justify-content:center; text-align:center; padding:6vw; cursor:pointer;
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
.gq-dismiss { position:fixed; top:14px; right:18px; font-size:13px; opacity:.75;
  background:rgba(0,0,0,.35); color:#fff; padding:6px 12px; border-radius:6px; }

/* Butter Fingers: a read-only overlay painted over the composer. The real
   textarea underneath keeps its exact value — this only changes what is drawn. */
.gq-mirror { position:absolute; pointer-events:none; overflow:hidden; z-index:5;
  white-space:pre-wrap; overflow-wrap:break-word; box-sizing:border-box; }
/* The app's global ::selection sets a colour, which would otherwise render
   the real (transparent) text visible again the moment it's selected. */
#input.gq-butter::selection { color: transparent; }

/* Toasts must stay visible above prank overlays so the victim always sees
   who did it, even mid-BSOD. */
#toasts { z-index: 9600 !important; }

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

function dropLayerIfEmpty() {
  const node = document.getElementById("gq-layer");
  if (node && !node.childNodes.length) node.remove();
}

/* --------------------- one transform prank at a time --------------------- */

// Transform-based effects can't compose (upsidedown + tiny would fight over
// the same property), and two of the same kind would truncate each other's
// timer. So the newest one replaces whatever is running.
let activeTransform = null; // {cls, timer}

function timedClass(cls, ms) {
  const root = app();
  if (!root) return;
  if (activeTransform) {
    clearTimeout(activeTransform.timer);
    root.classList.remove(activeTransform.cls);
  }
  root.classList.add(cls);
  const timer = setTimeout(() => {
    root.classList.remove(cls);
    if (activeTransform && activeTransform.timer === timer) activeTransform = null;
  }, ms);
  activeTransform = { cls, timer };
}

/* ------------------------------- sounds --------------------------------- */

function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
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
    setTimeout(() => {
      drops.forEach((d) => d.remove());
      dropLayerIfEmpty();
    }, 4200);
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

// Guarded like every other effect: without this, concurrent air horns
// composite their white layers and run at independent phase, which pushes
// both the brightness and the flashes-per-second past the safe limits.
let flashUp = false;

function flash() {
  if (reduceMotion() || flashUp) return;
  flashUp = true;
  const s = document.createElement("div");
  s.className = "gq-flash";
  document.body.appendChild(s);
  setTimeout(() => {
    s.remove();
    flashUp = false;
  }, 1500);
}

// Butter Fingers scrambles what the victim SEES, never what they typed.
// The real textarea keeps its exact value and is simply rendered invisible;
// a mirror element painted over it shows the jumbled text. Because no user
// data is ever written, every input path — paste, mid-text edits, undo,
// drag-drop, IME composition, the emoji picker, overlapping pranks — is
// inherently safe, and the sent message is always byte-identical.
let butterActive = false;

// Deterministic so the mirror doesn't jitter between repaints: swap adjacent
// pairs of non-space characters. Iterates code points, not UTF-16 units, so
// emoji are moved whole instead of being split into replacement glyphs.
const jumble = (s) => {
  const chars = [...s];
  for (let i = 0; i + 1 < chars.length; i += 2) {
    if (/\s/.test(chars[i]) || /\s/.test(chars[i + 1])) continue;
    const swap = chars[i];
    chars[i] = chars[i + 1];
    chars[i + 1] = swap;
  }
  return chars.join("");
};

function butterFingers(ms) {
  const input = document.getElementById("input");
  const composer = document.getElementById("composer");
  if (!input || !composer || butterActive) return;
  butterActive = true;

  const cs = getComputedStyle(input);
  // Read the ink colour NOW: cs is live, so once the textarea is set
  // transparent below, cs.color would report transparent and the victim
  // would be left typing with no caret at all.
  const inkColor = cs.color;
  const mirror = document.createElement("div");
  mirror.className = "gq-mirror";
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight",
    "letterSpacing", "textIndent", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft",
  ]) {
    mirror.style[prop] = cs[prop];
  }
  mirror.style.color = inkColor;

  const place = () => {
    mirror.style.left = input.offsetLeft + "px";
    mirror.style.top = input.offsetTop + "px";
    mirror.style.width = input.offsetWidth + "px";
    mirror.style.height = input.offsetHeight + "px";
    mirror.textContent = jumble(input.value);
    mirror.scrollTop = input.scrollTop;
  };

  const prevPosition = composer.style.position;
  const prevColor = input.style.color;
  const prevCaret = input.style.caretColor;
  composer.style.position = "relative";
  input.style.color = "transparent";
  input.style.caretColor = inkColor; // caret must stay visible to type by
  input.classList.add("gq-butter"); // keeps ::selection from revealing the text
  composer.appendChild(mirror);
  place();

  // An interval (not just the input event) so programmatic writes — the emoji
  // picker, the post-send clear — stay mirrored without ever being touched.
  const sync = setInterval(place, 80);
  input.addEventListener("input", place);
  input.addEventListener("scroll", place);

  setTimeout(() => {
    clearInterval(sync);
    input.removeEventListener("input", place);
    input.removeEventListener("scroll", place);
    mirror.remove();
    composer.style.position = prevPosition;
    input.style.color = prevColor;
    input.style.caretColor = prevCaret;
    input.classList.remove("gq-butter");
    butterActive = false;
  }, ms);
}

// Only one full-screen prank at a time, and always dismissable.
let fullScreenUp = false;

function fullScreenPrank({ className, build, revealText, ms }) {
  if (fullScreenUp) return false;
  fullScreenUp = true;

  const node = document.createElement("div");
  node.className = `gq-full ${className}`;
  build(node);

  const hint = document.createElement("div");
  hint.className = "gq-dismiss";
  hint.textContent = "click anywhere or press Esc to dismiss";
  node.appendChild(hint);

  let revealTimer = null;
  const close = () => {
    if (!fullScreenUp) return;
    fullScreenUp = false;
    clearTimeout(revealTimer);
    clearTimeout(autoTimer);
    window.removeEventListener("keydown", onKey, true);
    node.remove();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };

  node.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(node);

  revealTimer = setTimeout(() => {
    const reveal = document.createElement("div");
    reveal.className = "gq-reveal";
    reveal.textContent = revealText;
    node.appendChild(reveal);
  }, Math.max(900, ms - 1600));
  const autoTimer = setTimeout(close, ms);
  return true;
}

/* ------------------------------ dispatcher ------------------------------- */

/**
 * Run a prank locally. `fromName` is the culprit, revealed to the victim.
 * Returns the prank's metadata (so the caller can toast it), or null if the
 * effect was skipped (unknown kind, reduced-motion, or one already on screen).
 */
export function runPrank(kind, fromName) {
  ensureStyle();
  const meta = PRANKS.find((p) => p.kind === kind);
  if (!meta) return null;
  // Respect the OS-level motion preference — the toast still reveals the
  // sender, so the joke lands without the vestibular hit.
  if (MOTION_KINDS.has(kind) && reduceMotion()) return meta;
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
      flash();
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
            if (n >= 99 || !node.isConnected) clearInterval(t);
          }, 260);
        },
      });
      break;
    default:
      return null;
  }
  return meta;
}
