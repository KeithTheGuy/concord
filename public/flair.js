// The purely decorative layer: themes, TURBO MODE effects, XP levels and
// achievements. Nothing in here changes what any control does — it's all
// opt-in sparkle, and it all stands down under prefers-reduced-motion.

const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/* -------------------------------- themes --------------------------------- */

export const THEMES = [
  { id: "midnight", label: "Midnight", emoji: "🌑" },
  { id: "synthwave", label: "Synthwave", emoji: "🌆" },
  { id: "vapor", label: "Vaporwave", emoji: "🫧" },
  { id: "nord", label: "Nord", emoji: "🧊" },
  { id: "matrix", label: "Matrix", emoji: "🖥️" },
  { id: "gold", label: "Gold", emoji: "🏆" },
  { id: "blossom", label: "Blossom", emoji: "🌸" },
];

export function applyTheme(id) {
  const theme = THEMES.some((t) => t.id === id) ? id : "midnight";
  // "midnight" is the stylesheet's own :root, so it's the absence of an attribute.
  if (theme === "midnight") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-chat").trim();
    if (bg) meta.setAttribute("content", bg);
  }
  return theme;
}

export function applyTurbo(on) {
  document.body.classList.toggle("turbo", !!on);
}

/* ------------------------------- effects --------------------------------- */

// A ring that expands out of a point. Used on send, in turbo mode.
export function burst(x, y) {
  if (reduced()) return;
  const ring = document.createElement("div");
  ring.className = "turbo-burst";
  ring.style.left = x + "px";
  ring.style.top = y + "px";
  document.body.appendChild(ring);
  setTimeout(() => ring.remove(), 550);
}

const CONFETTI_COLORS = ["#5865f2", "#f23f43", "#23a559", "#f0b232", "#eb459e", "#00bcd4", "#ff8fb1"];

export function confetti(count = 90) {
  if (reduced()) return;
  const n = Math.min(200, count);
  for (let i = 0; i < n; i++) {
    const bit = document.createElement("div");
    bit.className = "confetti-bit";
    bit.style.left = Math.random() * 100 + "vw";
    bit.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    const dur = 2.4 + Math.random() * 2.2;
    bit.style.animationDuration = dur + "s";
    bit.style.animationDelay = Math.random() * 0.45 + "s";
    if (Math.random() < 0.35) bit.style.borderRadius = "50%";
    document.body.appendChild(bit);
    setTimeout(() => bit.remove(), (dur + 0.6) * 1000);
  }
}

/* -------------------------------- levels --------------------------------- */
// Local, personal, and completely non-competitive: nothing is sent anywhere,
// so nobody can farm it or be judged by it. It's a progress bar for you.

// Each level costs a bit more than the last.
export const xpForLevel = (level) => Math.round(60 * Math.pow(level, 1.45));

export function levelFromXp(xp) {
  let level = 1;
  let spent = 0;
  while (spent + xpForLevel(level) <= xp && level < 200) {
    spent += xpForLevel(level);
    level++;
  }
  return { level, into: xp - spent, need: xpForLevel(level) };
}

/* ----------------------------- achievements ------------------------------ */

export const ACHIEVEMENTS = [
  { id: "first-word", emoji: "💬", name: "First Word", desc: "Send a message" },
  { id: "chatterbox", emoji: "🗣️", name: "Chatterbox", desc: "Send 100 messages" },
  { id: "novelist", emoji: "📚", name: "Novelist", desc: "Send 1,000 messages" },
  { id: "voice-crack", emoji: "🎭", name: "Voice Crack", desc: "Try the voice changer" },
  { id: "asmr", emoji: "🤫", name: "Unreasonably Soothing", desc: "Switch on FredsVoice" },
  { id: "full-rack", emoji: "🎚️", name: "Sound Engineer", desc: "Try every voice preset" },
  { id: "on-air", emoji: "📹", name: "On Air", desc: "Turn your camera on" },
  { id: "presenting", emoji: "🖥️", name: "Presenting", desc: "Share your screen" },
  { id: "friendly", emoji: "🤝", name: "Friendly", desc: "Make a friend" },
  { id: "popular", emoji: "🎉", name: "Popular", desc: "Have 5 friends" },
  { id: "gremlin", emoji: "🃏", name: "Gremlin", desc: "Land a prank" },
  { id: "menace", emoji: "😈", name: "Public Menace", desc: "Land 25 pranks" },
  { id: "noisy", emoji: "📢", name: "Noisy", desc: "Use the soundboard" },
  { id: "dj", emoji: "🎛️", name: "Resident DJ", desc: "Play 50 soundboard clips" },
  { id: "pinned", emoji: "📌", name: "Immortalised", desc: "Pin a message" },
  { id: "pollster", emoji: "📊", name: "Pollster", desc: "Run a poll" },
  { id: "gorb-friend", emoji: "🫧", name: "Gorb's Friend", desc: "Revive Gorb after knocking him out" },
  { id: "gorb-menace", emoji: "💦", name: "Hydro Homicide", desc: "Knock Gorb out cold" },
  { id: "night-owl", emoji: "🦉", name: "Night Owl", desc: "Send a message between 3am and 5am" },
  { id: "turbo", emoji: "⚡", name: "Turbo", desc: "Switch on TURBO MODE" },
  { id: "themed", emoji: "🎨", name: "Interior Decorator", desc: "Try every theme" },
  { id: "level-10", emoji: "🏅", name: "Regular", desc: "Reach level 10" },
  { id: "level-25", emoji: "👑", name: "Veteran", desc: "Reach level 25" },
];

export const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

// Shows the unlock card. `onDone` fires after it clears, so the caller can
// chain a sound or confetti without guessing at timings.
export function achievementToast(ach, container) {
  const card = document.createElement("div");
  card.className = "achievement";
  const emoji = document.createElement("span");
  emoji.className = "achievement-emoji";
  emoji.textContent = ach.emoji;
  const col = document.createElement("div");
  const title = document.createElement("div");
  title.className = "achievement-title";
  title.textContent = "ACHIEVEMENT UNLOCKED";
  const name = document.createElement("div");
  name.className = "achievement-name";
  name.textContent = ach.name;
  const desc = document.createElement("div");
  desc.className = "achievement-desc";
  desc.textContent = ach.desc;
  col.append(title, name, desc);
  card.append(emoji, col);
  container.appendChild(card);
  setTimeout(() => card.remove(), 6000);
}
