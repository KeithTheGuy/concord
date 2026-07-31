// Concord client — state, WebSocket protocol, and all UI.
import { VoiceEngine } from "./voice.js";
import { installVoiceUI, startQualityMeter, stopQualityMeter } from "./voiceui.js";
import { PRANKS, runPrank, installPrankStyles } from "./prank.js";
import { startMascot, stopMascot, setSquirt, reviveMascot, mascotDown } from "./mascot.js";
import { HubConnection, groupTitle } from "./hub.js";
import { SOUNDBOARD, playSound } from "./sounds.js";
import { VOICE_FX, FX_BY_ID } from "./voicefx.js";
import {
  createUploader, renderAttachments, openLightbox, humanSize, fileIcon, isImage,
} from "./uploads.js";
import {
  EmojiRegistry, renderCustomEmoji, reactionLabel, emojiCandidates,
  pickerRow as emojiPickerRow, isOnlyEmoji, nameOk,
} from "./customemoji.js";
import {
  THEMES, applyTheme, applyTurbo, burst, confetti,
  levelFromXp, ACHIEVEMENTS, ACH_BY_ID, achievementToast,
} from "./flair.js";

/* ============================== constants =============================== */

const AVATARS = ["🙂", "😎", "🦊", "🐻", "🐸", "🐙", "🦖", "👻", "🤖", "🍕", "🚀", "🎮", "🧙", "🦆", "🌵", "💀"];
const SERVER_ICONS = ["🎮", "🏴‍☠️", "🚀", "🎲", "🍻", "🔥", "🌮", "🧀", "⚔️", "🛸", "🎧", "🏰"];
const COLORS = ["#5865f2", "#f23f43", "#23a559", "#f0b232", "#eb459e", "#3ba55c", "#e67e22", "#1abc9c", "#9b59b6", "#e91e63", "#00bcd4", "#95a5a6"];
const EMOJIS = (
  "😀 😂 🤣 😊 😍 😘 😜 🤔 🙃 😴 😭 😱 🤯 🥳 😤 🥺 🫠 😇 🤡 💀 👻 🤖 👽 🎃 " +
  "👍 👎 👌 ✌️ 🤞 🤙 👏 🙌 🙏 💪 🫡 🖖 ✋ 🤝 " +
  "❤️ 🧡 💛 💚 💙 💜 🖤 💔 ❣️ 💯 ✨ ⭐ 🔥 💥 ⚡ 🌈 " +
  "🎉 🎊 🎁 🏆 🥇 🎮 🕹️ 🎲 🎯 🎵 🎶 🎤 🎧 " +
  "🍕 🌮 🍔 🍟 🍿 🍩 🍪 🍺 🍻 ☕ 🧋 " +
  "🐶 🐱 🦊 🐻 🐼 🐸 🐵 🦄 🐙 🦖 🦈 🦆 🐢 " +
  "🚀 🛸 🌙 ☀️ 🌊 🍀 🌵 ⛺ 🗿 💎 🔑 🛠️ 📌 ✅ ❌ ❓ ‼️ 💤"
).split(" ").filter(Boolean);
const QUICK_REACTS = ["👍", "❤️", "😂", "😮", "😢", "🔥"];

// Every server mints its own :names:, so one registry keyed by server code is
// the only shape that can tell two different :blobcat: apart.
const emojiReg = new EmojiRegistry();

const SLOWMODE_CHOICES = [
  { label: "Off", seconds: 0 },
  { label: "5 seconds", seconds: 5 },
  { label: "10 seconds", seconds: 10 },
  { label: "30 seconds", seconds: 30 },
  { label: "1 minute", seconds: 60 },
  { label: "5 minutes", seconds: 300 },
];

const EMOJI_MAX_BYTES = 256 * 1024;
const SOUND_MAX_BYTES = 512 * 1024;
const SAVED_CAP = 200;

const PRESENCE_META = {
  online: { dot: "online", label: "Online", emoji: "🟢" },
  idle: { dot: "idle", label: "Idle", emoji: "🌙" },
  dnd: { dot: "dnd", label: "Do Not Disturb", emoji: "⛔" },
  invisible: { dot: "offline", label: "Invisible", emoji: "⚫" },
};

// Slash commands. Each returns the text to actually send, or null to swallow
// the command entirely (it did something else instead).
const SLASH = [
  { name: "shrug", args: "[message]", help: "Appends ¯\\_(ツ)_/¯", run: (rest) => `${rest} ¯\\_(ツ)_/¯`.trim() },
  { name: "tableflip", args: "[message]", help: "(╯°□°)╯︵ ┻━┻", run: (rest) => `${rest} (╯°□°)╯︵ ┻━┻`.trim() },
  { name: "unflip", args: "[message]", help: "┬─┬ ノ( ゜-゜ノ)", run: (rest) => `${rest} ┬─┬ ノ( ゜-゜ノ)`.trim() },
  { name: "me", args: "<action>", help: "Italicised action", run: (rest) => (rest ? `*${rest}*` : null) },
  { name: "spoiler", args: "<text>", help: "Hide it behind a click", run: (rest) => (rest ? `||${rest}||` : null) },
  { name: "big", args: "<text>", help: "MAKES IT LOUD", run: (rest) => (rest ? `**${rest.toUpperCase()}**` : null) },
  {
    name: "mock",
    args: "<text>",
    help: "sPoNgEbOb CaSe",
    run: (rest) => (rest ? rest.split("").map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join("") : null),
  },
  { name: "clap", args: "<text>", help: "Puts 👏 between 👏 every 👏 word", run: (rest) => (rest ? rest.split(/\s+/).join(" 👏 ") : null) },
  { name: "roll", args: "[sides]", help: "Roll a die", run: (rest) => {
      const sides = Math.max(2, Math.min(1000, parseInt(rest, 10) || 6));
      return `🎲 rolled a **${1 + Math.floor(Math.random() * sides)}** (d${sides})`;
    } },
  { name: "flip", args: "", help: "Coin flip", run: () => `🪙 **${Math.random() < 0.5 ? "Heads" : "Tails"}**` },
  { name: "8ball", args: "<question>", help: "Ask the magic 8-ball", run: (rest) => {
      const answers = ["It is certain.", "Absolutely not.", "Ask again later.", "Without a doubt.",
        "My sources say no.", "Yes — definitely.", "Very doubtful.", "Signs point to yes.",
        "Don't count on it.", "Obviously.", "lol no", "The 8-ball is tired. Try tomorrow."];
      return rest ? `🎱 *${rest}* — ${answers[Math.floor(Math.random() * answers.length)]}` : null;
    } },
  { name: "nick", args: "<name>", help: "Change your display name", run: (rest) => {
      if (!rest) return null;
      state.profile.name = rest.slice(0, 32);
      store.set("profile", state.profile);
      renderMe();
      pushProfile();
      toast(`You are now ${state.profile.name}.`);
      return null;
    } },
  { name: "status", args: "<text>", help: "Set your custom status", run: (rest) => {
      state.profile.status = rest.slice(0, 60);
      store.set("profile", state.profile);
      renderMe();
      pushProfile();
      toast(rest ? `Status set: ${rest}` : "Status cleared.");
      return null;
    } },
  { name: "sound", args: "<name>", help: "Fire a soundboard clip", run: (rest) => {
      const clip = SOUNDBOARD.find((s) => s.id === rest.trim().toLowerCase());
      if (!clip) { toast(`Sounds: ${SOUNDBOARD.map((s) => s.id).join(", ")}`, true); return null; }
      fireSound(clip.id);
      return null;
    } },
  { name: "shout", args: "<text>", help: "Sends it, then air-horns the call", run: (rest) => {
      fireSound("airhorn");
      return rest ? `📢 **${rest.toUpperCase()}**` : null;
    } },
  { name: "poll", args: "<question> | <option> | <option>", help: "Start a poll", run: (rest) => {
      const built = buildPollMessage(rest);
      if (built) unlock("pollster");
      return built;
    } },
  { name: "confetti", args: "", help: "Throw confetti at yourself", run: () => {
      confetti(120);
      return null;
    } },
  { name: "theme", args: "<name>", help: "Switch theme", run: (rest) => {
      const wanted = rest.trim().toLowerCase();
      const theme = THEMES.find((t) => t.id === wanted);
      if (!theme) { toast(`Themes: ${THEMES.map((t) => t.id).join(", ")}`, true); return null; }
      setTheme(theme.id);
      return null;
    } },
  { name: "voice", args: "<name>", help: "Switch voice preset", run: (rest) => {
      const wanted = rest.trim().toLowerCase();
      const preset = FX_BY_ID.get(wanted);
      if (!preset) { toast(`Voices: ${VOICE_FX.map((f) => f.id).join(", ")}`, true); return null; }
      applyVoiceFx(preset.id, preset.spec.semis || 0);
      toast(`${preset.emoji} Voice: ${preset.label}`);
      return null;
    } },
  { name: "help", args: "", help: "List every command", run: () => {
      toast("Commands: " + SLASH.map((c) => "/" + c.name).join(", "));
      return null;
    } },
];

// Voice presets live in voicefx.js — each one is a whole signal chain, not
// just a pitch number.

/* =============================== storage ================================ */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem("concord-" + key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    localStorage.setItem("concord-" + key, JSON.stringify(value));
  },
};

/* ================================ state ================================= */

const state = {
  profile: store.get("profile", null), // {userId, name, color, avatar, status}
  account: store.get("account", null), // {uid, token, tag} — the global identity
  settings: Object.assign(
    {
      micId: "", ptt: false, pttKey: "ControlLeft", sounds: true, volume: 100,
      notifs: false, gremlin: true, mascot: true, board: true, fx: "off",
      fxPitch: 0, gorbHits: 0, presence: "online",
      userVolumes: {}, // userId -> 0..200, remembered forever
      muted: {}, // server code -> true, silences pings from that server
      embeds: true, tts: false, autoIdle: true,
      theme: "midnight", turbo: false,
      // Local-only progression. Never sent anywhere, so it can't be farmed,
      // compared, or used to judge anyone.
      xp: 0, stats: {}, achievements: [], seenThemes: [], triedVoices: [],
      // Bookmarks, private notes and folded categories. All three are about
      // how *you* read this place, so none of them are ever transmitted.
      saved: [], notes: {}, collapsed: {},
    },
    store.get("settings", {})
  ),
  servers: store.get("servers", []), // [{code, name, icon}]
  view: "server", // server | home | dm

  // Every server you're in — and every DM you've opened — keeps its own live
  // socket and its own copy of channels/messages/members. `activeCode` is
  // merely which one the UI is currently *showing*, and `voiceCode` is which
  // one owns the call. They are deliberately independent: browsing another
  // server, or reading a DM, must never touch a call in progress.
  realms: new Map(), // code -> realm
  activeCode: null,
  voiceCode: null, // realm holding the live call, if any
  voiceChan: null, // channel id within that realm

  fvTab: "online",
  lastTypingSent: 0,
  autocomplete: null, // {kind:'mention'|'slash'|'emoji', items, index, from}
  switchIndex: 0,
  switchItems: [],
};

const NO_ARR = [];
const NO_MAP = new Map();
const NO_SET = new Set();

function makeRealm(code, kind) {
  const realm = {
    code,
    kind, // "guild" | "dm"
    peer: null, // the friend, when kind === "dm"
    group: null, // the group record, when kind === "group"
    ws: null,
    wsState: "idle", // idle | connecting | open
    gotWelcome: false,
    reconnectDelay: 1000,
    reconnectTimer: null,
    pingTimer: null,
    intent: null, // {kind:'create'|'join'|...} while connecting
    resume: null, // {voiceChan, activeChan} across an unplanned reconnect
    failCount: 0,
    closing: false,
    me: null,
    meta: null,
    channels: [],
    members: new Map(), // sid -> member, one entry per LIVE SOCKET
    // The durable half of membership: one row per person, present or not. Kept
    // beside `members` rather than merged into it, because voice, WebRTC and
    // typing all address people by sid and two tabs are two sids.
    roster: new Map(), // userId -> {userId, name, color, avatar, tag, status, at, joinedAt}
    owner: null,
    sounds: [], // custom soundboard clips [{id, name, url}]
    messages: new Map(), // chanId -> msg[]
    historyLoaded: new Set(),
    historyPending: new Set(),
    noMoreHistory: new Set(),
    // Channels whose next history response is a refill after a dropped socket,
    // so it can be counted as unread instead of arriving silently.
    resync: new Set(),
    activeChan: null,
    unread: new Map(), // chanId -> count
    firstUnread: new Map(), // chanId -> id of the first message you missed
    mentions: 0, // how many of those unreads were aimed at you
    typing: new Map(), // sid -> {name, chanId, until}
    replyTo: null,
    editingId: null,
    pendingByNonce: new Map(),
    touched: Date.now(), // for evicting stale DM sockets
    flushing: false, // an upload flush is waiting on this socket for tickets
    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },
  };
  // One uploader per realm, so half-attached files survive a glance at another
  // server. Tickets come back on this realm's socket, which is why the uploader
  // can't be global.
  realm.uploader = createUploader({
    send: (obj) => realm.send(obj),
    code: () => realm.code,
    onError: (text) => toast(text, true),
    onProgress: () => {
      if (realm.code === state.activeCode) renderTray();
    },
  });
  return realm;
}

const R = () => (state.activeCode ? state.realms.get(state.activeCode) : null) || null;
const voiceRealm = () => (state.voiceCode ? state.realms.get(state.voiceCode) : null) || null;

// The UI reads the *active* realm through plain `state.channels`-style names,
// so every render and click handler stays realm-agnostic. Anything driven by
// the network instead takes an explicit realm argument, because a message can
// arrive for a server you aren't currently looking at.
const REALM_FIELDS = {
  channels: NO_ARR,
  members: NO_MAP,
  roster: NO_MAP,
  messages: NO_MAP,
  historyLoaded: NO_SET,
  historyPending: NO_SET,
  noMoreHistory: NO_SET,
  unread: NO_MAP,
  typing: NO_MAP,
  pendingByNonce: NO_MAP,
  me: null,
  meta: null,
  activeChan: null,
  replyTo: null,
  editingId: null,
};
for (const [key, fallback] of Object.entries(REALM_FIELDS)) {
  Object.defineProperty(state, key, {
    get() {
      const r = R();
      return r ? r[key] : fallback;
    },
    set(v) {
      const r = R();
      if (r) r[key] = v;
    },
  });
}
Object.defineProperty(state, "currentCode", { get: () => R()?.code || null });
Object.defineProperty(state, "realmKind", { get: () => R()?.kind || "guild" });
Object.defineProperty(state, "dmPeer", { get: () => R()?.peer || null });

/* ============================== dom helpers ============================= */

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
/* -------------------------------- splash --------------------------------- */
// The splash is markup + CSS that paints before this file has even parsed.
// All the JS does is narrate progress and take it away.

let splashDone = false;

function splashSay(text) {
  const node = document.getElementById("splash-sub");
  if (node && !splashDone) node.textContent = text;
}

function hideSplash(delay = 0) {
  if (splashDone) return;
  splashDone = true;
  setTimeout(() => {
    const node = document.getElementById("splash");
    if (!node) return;
    node.classList.add("gone");
    setTimeout(() => node.remove(), 700);
  }, delay);
}

// A stuck connection must never trap you behind a loading screen.
setTimeout(() => {
  if (!splashDone) {
    splashSay("taking longer than usual…");
    hideSplash(600);
  }
}, 6000);

function toast(text, isError = false) {
  const t = el("div", "toast" + (isError ? " error" : ""), text);
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
// Identity is per server, not global: the server can hand us a different
// userId on one server (if ours was already claimed there) without disturbing
// who we are anywhere else. Stored as {code: {userId, token}}.
function identityFor(code) {
  const saved = store.get("identities", {})[code];
  if (saved) return saved;
  const legacyToken = store.get("tokens", {})[code]; // pre-per-server clients
  if (legacyToken && state.profile) return { userId: state.profile.userId, token: legacyToken };
  return null;
}

function rememberIdentity(code, userId, token) {
  if (!code || !userId || !token) return;
  const all = store.get("identities", {});
  all[code] = { userId, token };
  store.set("identities", all);
}

const myUserId = () =>
  state.me?.userId || identityFor(state.currentCode)?.userId || state.profile?.userId;

// Control characters go first, because renderMarkdown uses U+0000 as a sentinel
// for protected fragments. The worker strips them on the way in, but the
// composer's optimistic local render never goes near the worker — a typed
// U+0000 forged a sentinel there and duplicated the reader's links. Holding the
// invariant here means the renderer no longer depends on who fed it.
const esc = (s) =>
  s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// A lone surrogate paints as U+FFFD. Ours are prevented by clip(), but a quote
// can arrive already cut — from durable storage written before that was true,
// or from another client — and the reader should not see the wreckage.
const dropHalfPairs = (s) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");

// Previews are cut by code point, not by UTF-16 unit: slicing "…😀" mid-pair
// leaves a lone surrogate, which every renderer draws as �.
const clip = (s, n) => (s.length <= n ? s : [...s].slice(0, n).join(""));

/* ============================ voice engine ============================== */

// Every hook resolves against the realm holding the CALL, never the one on
// screen — that separation is what lets you wander between servers and DMs
// mid-conversation without dropping anybody.
const voice = new VoiceEngine({
  mySid: () => voiceRealm()?.me?.sid || "",
  send: (obj) => voiceRealm()?.send(obj),
  onSpeaking(sid, speaking) {
    const key = sid === "me" ? voiceRealm()?.me?.sid : sid;
    if (!key) return;
    document.querySelectorAll(`[data-vsid="${key}"]`).forEach((n) => n.classList.toggle("speaking", speaking));
  },
  onShareStart(sid, stream) {
    const member = voiceRealm()?.members.get(sid);
    const who = member?.name || "Someone";
    const camera = member?.voice?.shareKind === "camera";
    addShareTile(sid, stream, camera ? who : `${who}'s screen`);
  },
  onShareEnd(sid) {
    removeShareTile(sid);
  },
  onLocalShareEnd() {
    removeShareTile("me");
    $("btn-share").classList.remove("on");
    $("btn-camera").classList.remove("on");
  },
  onError: (t) => toast(t, true),
  settings: () => state.settings,
  inMyChannel: (sid) => !!state.voiceChan && voiceRealm()?.members.get(sid)?.voice?.chanId === state.voiceChan,
  // Per-person volume keyed on the stable userId, so it survives reconnects,
  // reloads, and the sid churning on every join.
  volumeFor: (sid) => {
    const uid = voiceRealm()?.members.get(sid)?.userId;
    const saved = uid ? state.settings.userVolumes?.[uid] : undefined;
    return typeof saved === "number" ? saved : undefined;
  },
  saveVolume: (sid, percent) => {
    const uid = voiceRealm()?.members.get(sid)?.userId;
    if (!uid) return;
    state.settings.userVolumes = { ...(state.settings.userVolumes || {}), [uid]: percent };
    store.set("settings", state.settings);
  },
});

// The audio settings (gate, meter, devices, share quality) build their own DOM
// inside the Voice section of the settings modal, so they need telling when
// that modal opens rather than owning the open path themselves.
const settingsOpenHooks = [];

const voiceUiHooks = {
  voice,
  settings: () => state.settings,
  save: () => store.set("settings", state.settings),
  toast,
  onSettingsOpen: (fn) => settingsOpenHooks.push(fn),
  panelEl: () => $("settings-modal"),
  qualityEl: () => $("vs-quality"),
};
installVoiceUI(voiceUiHooks);

/* ================================= hub ================================== */

const hub = new HubConnection({
  savedAccount: () => state.account,
  profile: () => state.profile || { name: "Wumpus", avatar: "🙂", color: COLORS[0], status: "" },
  presence: () => effectivePresence(),
  rememberAccount(uid, token, tag) {
    state.account = { uid, token, tag };
    store.set("account", state.account);
  },
  rememberTag(tag) {
    if (state.account) {
      state.account.tag = tag;
      store.set("account", state.account);
    }
  },
  toast,
  onWelcome() {
    bumpMentions();
    renderHomeBadge();
    if (state.view === "home") renderFriendsView();
  },
  onChange() {
    bumpMentions();
    renderHomeBadge();
    renderDmList();
    if (state.view === "home") renderFriendsView();
    if (hub.friends.size >= 1) unlock("friendly");
    if (hub.friends.size >= 5) unlock("popular");
  },
  onRequest(user) {
    toast(`👋 ${user.name} (@${user.tag}) wants to be your friend.`);
    if (state.settings.sounds) voice.playCue("ping");
  },
  onFriendRemoved(uid, known) {
    if (known) toast(`${known.name} is no longer on your friends list.`);
    // If you were reading their DM, there's nothing to read any more.
    const code = hub.dmCodes.get(uid);
    if (code) {
      const wasActive = state.activeCode === code;
      closeRealm(code);
      if (wasActive) {
        state.activeCode = state.servers[0]?.code || null;
        goHome();
      }
    }
  },
  onDmReady(uid, code, user) {
    openDmRealm(uid, code, user);
  },
  onGroupReady(group) {
    openGroupRealm(group);
  },
  onGroupRemoved(id, group) {
    if (group) toast(`You left "${groupTitle(group, hub.me?.uid)}".`);
    const code = group?.code;
    if (code) {
      const wasActive = state.activeCode === code;
      closeRealm(code);
      if (wasActive) {
        state.activeCode = state.servers[0]?.code || null;
        goHome();
      }
    }
    renderDmList();
  },
  onDmNudge(key, name, preview, isGroup) {
    const uid = key;
    const code = isGroup ? hub.groups.get(key)?.code : hub.dmCodes.get(key);
    const realm = code ? state.realms.get(code) : null;
    if (realm && realm.code === state.activeCode && state.view === "dm" && !document.hidden && document.hasFocus()) {
      hub.markDmRead(uid); // we're literally looking at it
      return;
    }
    // If that DM has a live socket, its own `msg` already made the noise —
    // don't announce the same message twice.
    if (realm && realm.wsState === "open") {
      updateTitle();
      return;
    }
    if (state.settings.sounds) voice.playCue("mention");
    updateTitle();
    if (notificationsReady()) {
      const where = isGroup
        ? `${name} • ${groupTitle(hub.groups.get(key) || {}, hub.me?.uid)}`
        : `${name} — direct message`;
      try {
        const n = new Notification(`🔔 ${where}`, {
          body: preview || "(no preview)",
          icon: "/icon-192.png",
          tag: "concord-dm-" + uid,
          renotify: true,
        });
        n.onclick = () => {
          window.focus();
          if (isGroup) openGroup(key);
          else openDm(uid);
          n.close();
        };
      } catch {}
    }
  },
  onPoked(name) {
    toast(`👉 ${name} poked you.`);
    if (state.settings.sounds) playSound("bonk", 0.6);
    document.body.classList.add("poked");
    setTimeout(() => document.body.classList.remove("poked"), 700);
  },
});

// Your name/avatar/colour should change everywhere at once, not just in the
// server you happen to be looking at.
// What everyone else sees. Auto-idle only ever downgrades "online" — an
// explicit DND or Invisible is left exactly as you set it.
function effectivePresence() {
  const chosen = state.settings.presence || "online";
  return autoIdle && chosen === "online" ? "idle" : chosen;
}

function pushProfile() {
  hub.pushProfile();
  const payload = {
    type: "set-profile",
    name: state.profile.name,
    color: state.profile.color,
    avatar: state.profile.avatar,
    status: state.profile.status,
  };
  for (const realm of state.realms.values()) realm.send(payload);
}

/* ============================== websocket =============================== */

// Sends on the realm the UI is showing. Network-driven code should use
// `realm.send(...)` directly instead — this one follows the user's eyes.
function wsSend(obj) {
  R()?.send(obj);
}

// Idle DM sockets are cheap but not free. Servers stay connected forever (you
// want their pings); DMs beyond this many get closed, oldest-touched first.
const MAX_DM_REALMS = 6;

function openRealm(code, kind, intent) {
  let realm = state.realms.get(code);
  if (!realm) {
    realm = makeRealm(code, kind);
    state.realms.set(code, realm);
  }
  realm.kind = kind;
  realm.touched = Date.now();
  if (realm.wsState === "idle") connectRealm(realm, intent);
  evictStaleDms();
  return realm;
}

function evictStaleDms() {
  const dms = [...state.realms.values()].filter(
    (r) => isDirect(r) && r.code !== state.activeCode && r.code !== state.voiceCode
  );
  if (dms.length <= MAX_DM_REALMS) return;
  dms.sort((a, b) => a.touched - b.touched);
  for (const r of dms.slice(0, dms.length - MAX_DM_REALMS)) closeRealm(r.code);
}

function connectRealm(realm, intent) {
  const code = realm.code;
  if (intent?.kind !== "reconnect") realm.resume = null;
  realm.intent = intent || { kind: "reopen", code };
  realm.wsState = "connecting";
  realm.gotWelcome = false;

  let url = `${location.origin.replace(/^http/, "ws")}/ws?server=${encodeURIComponent(code)}`;
  if (intent?.kind === "create") {
    url += `&create=1&name=${encodeURIComponent(intent.name)}&icon=${encodeURIComponent(intent.icon)}`;
  } else if (isDirect(realm)) {
    // The DM's Durable Object is created lazily the first time either friend
    // opens it; create=1 is a no-op once it exists.
    url += `&create=1&kind=dm&name=${encodeURIComponent("DM")}&icon=${encodeURIComponent("💬")}`;
  }

  let ws;
  try {
    ws = new WebSocket(url);
  } catch {
    realm.wsState = "idle";
    return;
  }
  realm.ws = ws;

  ws.onopen = () => {
    realm.wsState = "open";
    realm.send({
      type: "hello",
      userId: identityFor(code)?.userId || state.profile.userId,
      token: identityFor(code)?.token || "", // proves this userId is ours
      tag: hub.me?.tag || state.account?.tag || "",
      name: state.profile.name,
      color: state.profile.color,
      avatar: state.profile.avatar,
      status: state.profile.status || "",
    });
  };
  ws.onmessage = (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(realm, m);
  };
  ws.onclose = () => {
    if (ws !== realm.ws) return;
    const hadWelcome = realm.gotWelcome;
    realm.wsState = "idle";
    stopRealmPing(realm);

    if (!hadWelcome) {
      if (realm.intent?.kind === "join") {
        hideSplash();
        toast("Couldn't join — double-check the invite code.", true);
        state.servers = state.servers.filter((s) => s.code !== code);
        store.set("servers", state.servers);
        state.realms.delete(code);
        if (state.activeCode === code) state.activeCode = state.servers[0]?.code || null;
        renderServerRail();
        applyView();
        if (!state.servers.length) openJoinModal();
        return;
      }
      realm.failCount++;
      if (realm.failCount >= 5) {
        realm.failCount = 0;
        hideSplash();
        toast(`Can't reach ${realm.meta?.name || code} right now — click it in the rail to retry.`, true);
        return;
      }
    } else {
      realm.failCount = 0;
      realm.resume = {
        voiceChan: state.voiceCode === code ? state.voiceChan : null,
        activeChan: realm.activeChan,
      };
    }
    // Only the realm that actually owns the call loses it.
    if (state.voiceCode === code) leaveVoice({ silent: true });
    if (!realm.closing) scheduleRealmReconnect(realm);
  };
}

function scheduleRealmReconnect(realm) {
  if (realm.reconnectTimer) clearTimeout(realm.reconnectTimer);
  if (realm.code === state.activeCode) toast("Connection lost — reconnecting…", true);
  realm.reconnectTimer = setTimeout(() => {
    realm.reconnectDelay = Math.min(realm.reconnectDelay * 1.6, 10000);
    if (state.realms.has(realm.code) && !realm.closing) {
      connectRealm(realm, { kind: "reconnect", code: realm.code });
    }
  }, realm.reconnectDelay);
}

function closeRealm(code) {
  const realm = state.realms.get(code);
  if (!realm) return;
  realm.closing = true;
  if (realm.reconnectTimer) clearTimeout(realm.reconnectTimer);
  stopRealmPing(realm);
  if (state.voiceCode === code) leaveVoice({ silent: true });
  if (realm.ws) {
    const old = realm.ws;
    realm.ws = null;
    try {
      old.onclose = null;
      old.close();
    } catch {}
  }
  state.realms.delete(code);
}

function startRealmPing(realm) {
  stopRealmPing(realm);
  realm.pingTimer = setInterval(() => {
    if (realm.ws?.readyState === WebSocket.OPEN) realm.ws.send('{"type":"ping"}');
  }, 30000);
}
function stopRealmPing(realm) {
  if (realm.pingTimer) clearInterval(realm.pingTimer);
  realm.pingTimer = null;
}

/* ========================== server msg handling ========================= */

// `realm` is which connection this arrived on — NOT necessarily the one on
// screen. Anything visual is gated on `live` so a busy server you aren't
// looking at can't repaint the one you are.
function handleServerMessage(realm, m) {
  const live = realm.code === state.activeCode;
  const inCall = state.voiceCode === realm.code;

  switch (m.type) {
    case "pong":
      break;

    case "welcome": {
      realm.gotWelcome = true;
      realm.reconnectDelay = 1000;
      realm.me = m.you;
      rememberIdentity(realm.code, m.you.userId, m.token);
      realm.meta = m.meta;
      realm.channels = m.channels;
      realm.members = new Map(m.members.map((mm) => [mm.sid, mm]));
      bumpMentions();
      realm.roster = new Map((m.roster || []).map((e) => [e.userId, e]));
      realm.owner = m.owner || null;
      realm.sounds = m.sounds || [];
      emojiReg.setFor(realm.code, m.emoji || []);
      startRealmPing(realm);

      const resume = realm.resume;
      realm.resume = null;
      const wasIntent = realm.intent;
      realm.intent = null;

      // While the socket was down we heard nothing, so every channel in here is
      // stale — not just the one on screen. Invalidating the whole realm costs
      // one refetch per channel you actually reopen; invalidating only the
      // resumed one would leave the rest quietly missing messages forever, with
      // no badge to hint at it. `resync` marks them so the refill still counts
      // as unread; `historyPending` is cleared because any request in flight
      // died with the socket and would otherwise block the refill for 8s.
      if (resume) {
        realm.resync = new Set(realm.historyLoaded);
        realm.historyLoaded.clear();
        realm.historyPending.clear();
        realm.noMoreHistory.clear();
      }

      // A DM is a ConcordServer too, but it never belongs in the server rail.
      if (isDirect(realm)) {
        const chan = realm.channels.find((c) => c.type === "text");
        if (chan && !realm.activeChan) realm.activeChan = chan.id;
        if (live) {
          renderAll();
          if (realm.activeChan) activateChannel(realm.activeChan);
          hideSplash(150);
        } else if (realm.activeChan && !realm.historyLoaded.has(realm.activeChan)) {
          requestHistoryIn(realm, realm.activeChan);
        }
        if (resume?.voiceChan && realm.channels.some((c) => c.id === resume.voiceChan && c.type === "voice")) {
          joinVoiceIn(realm, resume.voiceChan);
        }
        break;
      }

      // Persist / refresh this server in the rail.
      const existing = state.servers.find((s) => s.code === realm.code);
      if (existing) {
        existing.name = m.meta.name;
        existing.icon = m.meta.icon;
      } else {
        state.servers.push({ code: realm.code, name: m.meta.name, icon: m.meta.icon });
      }
      store.set("servers", state.servers);

      if (wasIntent?.kind === "create") {
        toast(`Server "${m.meta.name}" created! Hit Invite to get your friends in.`);
        openInviteModal();
      } else if (wasIntent?.kind === "join") {
        toast(`Joined ${m.meta.name}!`);
      }

      const firstText = realm.channels.find((c) => c.type === "text");
      const target =
        (resume && realm.channels.some((c) => c.id === resume.activeChan && c.type === "text")
          ? resume.activeChan
          : null) ||
        (realm.channels.some((c) => c.id === realm.activeChan && c.type === "text") ? realm.activeChan : null) ||
        firstText?.id;
      realm.activeChan = target || null;

      if (live) {
        store.set("lastServer", realm.code);
        renderAll();
        if (target) activateChannel(target);
        hideSplash(150);
      } else {
        renderServerRail();
        // Load enough to know whether anything in here needs your attention.
        if (target && !realm.historyLoaded.has(target)) requestHistoryIn(realm, target);
      }
      if (resume?.voiceChan && realm.channels.some((c) => c.id === resume.voiceChan && c.type === "voice")) {
        joinVoiceIn(realm, resume.voiceChan); // rejoin the call we were dropped from
      }
      break;
    }

    case "member-join": {
      realm.members.set(m.member.sid, m.member);
      bumpMentions();
      if (live) {
        renderMembers();
        renderChannels();
      }
      break;
    }

    case "member-leave": {
      const member = realm.members.get(m.sid);
      realm.members.delete(m.sid);
      bumpMentions();
      realm.typing.delete(m.sid);
      if (inCall && member?.voice?.chanId && member.voice.chanId === state.voiceChan) {
        voice.peerLeft(m.sid);
        voice.playCue("leave");
      }
      if (live) {
        renderMembers();
        renderChannels();
        renderTyping();
      }
      break;
    }

    case "roster": {
      realm.roster.set(m.entry.userId, m.entry);
      if (live) renderMembers();
      break;
    }

    case "roster-remove": {
      realm.roster.delete(m.userId);
      if (live) renderMembers();
      break;
    }

    // A ban is permanent from this client's point of view, so the realm goes
    // away entirely — reconnecting would just get refused again, forever.
    case "banned": {
      const name = realm.meta?.name || realm.code;
      toast(`You've been banned from ${name}.`, true);
      const wasActive = realm.code === state.activeCode;
      state.servers = state.servers.filter((s) => s.code !== realm.code);
      store.set("servers", state.servers);
      closeRealm(realm.code); // sets closing + clears the reconnect timer
      renderServerRail();
      if (wasActive) {
        state.activeCode = state.servers[0]?.code || null;
        if (state.activeCode) goServer(state.activeCode);
        else goHome();
      }
      break;
    }

    case "upload-tickets": {
      // Arrives on the socket that asked, which is not necessarily the one
      // you're looking at.
      realm.uploader.handleTickets(m);
      break;
    }

    case "member-update": {
      const prev = realm.members.get(m.member.sid);
      realm.members.set(m.member.sid, m.member);
      bumpMentions();
      if (inCall && m.member.sid !== realm.me?.sid && state.voiceChan) {
        const was = prev?.voice?.chanId === state.voiceChan;
        const is = m.member.voice?.chanId === state.voiceChan;
        if (was && !is) {
          voice.peerLeft(m.member.sid);
          voice.playCue("leave");
        } else if (!was && is) {
          voice.playCue("join"); // they'll initiate the WebRTC offer to us
        }
      }
      if (live) {
        renderMembers();
        renderChannels();
      }
      break;
    }

    case "msg": {
      pushMessage(realm, m.msg);
      notifyIfNeeded(realm, m.msg);
      break;
    }

    case "msg-ack": {
      const pending = realm.pendingByNonce.get(m.nonce);
      realm.pendingByNonce.delete(m.nonce);
      const list = realm.messages.get(m.msg.chanId) || [];
      let swapped = null;
      if (pending) {
        const i = list.indexOf(pending);
        if (i >= 0) {
          list[i] = m.msg;
          swapped = pending.id;
        } else list.push(m.msg);
      } else {
        list.push(m.msg);
      }
      realm.messages.set(m.msg.chanId, list);
      if (live && m.msg.chanId === realm.activeChan) {
        const done = swapped ? swapMsgNode(realm, swapped, m.msg) : appendMessage(realm, m.msg);
        if (!done) renderMessages(false, realm);
      }
      break;
    }

    case "history": {
      realm.historyPending.delete(m.chanId);
      const existing = realm.messages.get(m.chanId) || [];
      if (m.before) {
        if (!m.messages.length) realm.noMoreHistory.add(m.chanId);
        const known = new Set(existing.map((x) => x.id));
        realm.messages.set(m.chanId, [...m.messages.filter((x) => !known.has(x.id)), ...existing]);
      } else {
        // Initial load — keep optimistic pendings and any live messages that
        // raced in before this response (deduped by id).
        const known = new Set(m.messages.map((x) => x.id));
        const extras = existing.filter((x) => x.pending || !known.has(x.id));
        const refill = realm.resync.delete(m.chanId);
        const had = refill ? new Set(existing.map((x) => x.id)) : null;
        realm.messages.set(m.chanId, [...m.messages, ...extras]);
        realm.historyLoaded.add(m.chanId);
        if (m.messages.length < 60) realm.noMoreHistory.add(m.chanId);
        if (refill) noteMissed(realm, m.chanId, m.messages.filter((x) => !had.has(x.id)));
      }
      if (live && m.chanId === realm.activeChan) renderMessages(!m.before, realm, !!m.before);
      break;
    }

    case "msg-edit": {
      const list = realm.messages.get(m.msg.chanId) || [];
      const i = list.findIndex((x) => x.id === m.msg.id);
      if (i >= 0) list[i] = m.msg;
      if (live && m.msg.chanId === realm.activeChan) renderMessages();
      break;
    }

    case "msg-delete": {
      const list = realm.messages.get(m.chanId) || [];
      realm.messages.set(m.chanId, list.filter((x) => x.id !== m.msgId));
      if (live && m.chanId === realm.activeChan) renderMessages();
      break;
    }

    case "msg-react": {
      const list = realm.messages.get(m.chanId) || [];
      const msg = list.find((x) => x.id === m.msgId);
      if (msg) {
        if (Object.keys(m.reactions).length) msg.reactions = m.reactions;
        else delete msg.reactions;
        if (live && m.chanId === realm.activeChan) renderMessages();
      }
      break;
    }

    case "typing": {
      if (m.chanId !== realm.activeChan) break;
      realm.typing.set(m.sid, { name: m.name, chanId: m.chanId, until: Date.now() + 6000 });
      if (live) renderTyping();
      // A friend typing at you shows up in the DM list even when you're
      // reading something else.
      else if (isDirect(realm)) renderDmList();
      break;
    }

    case "channel-create": {
      realm.channels.push(m.channel);
      if (live) {
        renderChannels();
        if (m.channel.type === "thread") toast(`💬 Thread "${m.channel.name}" started`);
        else toast(`Channel ${m.channel.type === "text" ? "#" : "🔊 "}${m.channel.name} created`);
      }
      break;
    }

    // The thread already exists as a channel by now — this is only the source
    // message learning that it has one, so it can show its chip.
    case "msg-thread": {
      const list = realm.messages.get(m.chanId) || [];
      const msg = list.find((x) => x.id === m.msgId);
      if (msg) {
        msg.threadId = m.threadId;
        msg.threadName = m.name;
        if (live && m.chanId === realm.activeChan) renderMessages();
      }
      break;
    }

    // The send was refused, so the optimistic copy has to come back out —
    // otherwise it sits there greyed out forever waiting on an ack that is
    // never coming, and the words go with it.
    case "slowmode": {
      slowUntil.set(`${realm.code}/${m.chanId}`, Date.now() + m.seconds * 1000);
      startSlowTicker();
      const bounced = unsendOptimistic(realm, m.chanId);
      if (live) {
        if (m.chanId === realm.activeChan) {
          if (bounced) renderMessages();
          // Handing the text back beats making someone retype it. Only into an
          // empty box: they may have started something else while they waited.
          const box = $("input");
          if (bounced?.content && !box.value.trim()) {
            box.value = bounced.content;
            autoGrow(box);
            updateCharCount();
          }
        }
        syncComposer();
        toast(`🐌 Slowmode — ${m.seconds}s before you can post again.`, true);
      }
      break;
    }

    case "emoji": {
      emojiReg.setFor(realm.code, m.list || []);
      if (live) renderMessages();
      if (live && !$("settings-modal").classList.contains("hidden")) renderEmojiSettings();
      break;
    }

    case "sounds": {
      realm.sounds = m.list || [];
      if (live && !$("soundboard").classList.contains("hidden")) renderSoundboard();
      break;
    }

    case "bans": {
      if (live) renderBans(m.list || []);
      break;
    }

    case "channel-update": {
      const i = realm.channels.findIndex((c) => c.id === m.channel.id);
      if (i >= 0) realm.channels[i] = m.channel;
      if (live) {
        renderChannels();
        if (m.channel.id === realm.activeChan) renderChatHeader();
      }
      break;
    }

    case "channel-delete": {
      realm.channels = realm.channels.filter((c) => c.id !== m.chanId);
      realm.messages.delete(m.chanId);
      realm.historyLoaded.delete(m.chanId);
      realm.historyPending.delete(m.chanId);
      realm.noMoreHistory.delete(m.chanId);
      realm.unread.delete(m.chanId);
      if (inCall && state.voiceChan === m.chanId) leaveVoice();
      if (realm.activeChan === m.chanId) {
        const first = realm.channels.find((c) => c.type === "text");
        realm.activeChan = first?.id || null;
        if (live && first) activateChannel(first.id);
      }
      if (live) renderChannels();
      break;
    }

    case "server-meta": {
      realm.meta = m.meta;
      const entry = state.servers.find((s) => s.code === realm.code);
      if (entry) {
        entry.name = m.meta.name;
        entry.icon = m.meta.icon;
        store.set("servers", state.servers);
      }
      if (live) $("server-name").textContent = m.meta.name;
      renderServerRail();
      break;
    }

    case "msg-pin": {
      const list = realm.messages.get(m.chanId) || [];
      const msg = list.find((x) => x.id === m.msgId);
      if (msg) {
        if (m.pinned) msg.pinned = true;
        else delete msg.pinned;
      }
      if (live && m.chanId === realm.activeChan) {
        renderMessages();
        toast(m.pinned ? `📌 ${m.by} pinned a message.` : `${m.by} unpinned a message.`);
        if (m.pinned) unlock("pinned");
      }
      break;
    }

    case "pins": {
      if (live) renderPins(m.messages);
      break;
    }

    case "search-results": {
      if (live) renderSearchResults(m);
      break;
    }

    case "sound": {
      // Soundboard is a voice-channel thing: only the call's realm plays it.
      if (!inCall || !state.settings.board) break;
      if (m.sid === realm.me?.sid) break; // we already played it locally
      // A custom clip is a file, so it arrives with a url and there is nothing
      // to synthesize.
      if (m.url) {
        playClip(m.url);
        const custom = realm.sounds.find((s) => s.id === m.sound);
        toast(`📼 ${m.name} played ${custom?.name || "a clip"}`);
        break;
      }
      playSound(m.sound, (state.settings.volume || 100) / 100);
      const clip = SOUNDBOARD.find((s) => s.id === m.sound);
      if (clip) toast(`${clip.emoji} ${m.name} played ${clip.label}`);
      break;
    }

    // WebRTC signaling is only ever meaningful for the realm holding the call.
    case "voice-peers": {
      if (inCall) voice.connectToPeers(m.peers);
      break;
    }

    case "rtc": {
      if (inCall) voice.handleRtc(m.from, m.data);
      break;
    }

    case "rtc-gone": {
      if (inCall) voice.peerLeft(m.sid);
      break;
    }

    case "pranked": {
      if (!state.settings.gremlin) {
        toast(`🛡️ Blocked a ${m.kind} prank from ${m.name}. Coward mode is on.`);
        break;
      }
      const meta = runPrank(m.kind, m.name);
      if (meta) toast(`🃏 ${m.name} hit you with ${meta.emoji} ${meta.label}!`);
      break;
    }

    case "prank-sent": {
      const meta = PRANKS.find((p) => p.kind === m.kind);
      toast(`🃏 ${meta ? meta.emoji + " " + meta.label : "Prank"} deployed. You monster.`);
      unlock("gremlin");
      if (bumpStat("pranks") >= 25) unlock("menace");
      addXp(6);
      break;
    }

    case "prank-shielded": {
      toast("They're still recovering from the last prank. Give them a few seconds.", true);
      break;
    }

    case "prank-missed": {
      toast("They vanished before it landed. Cooldown refunded.", true);
      break;
    }

    case "prank-cooldown": {
      toast(`Gremlin cooldown — ${m.seconds}s until you can strike again.`, true);
      break;
    }

    case "error": {
      // A refused upload-ticket comes back as a plain error, and the uploader
      // would otherwise sit on its 15s timeout with the composer locked.
      if (realm.flushing) realm.uploader.handleTickets({ tickets: [] });
      if (live) toast(m.error, true);
      break;
    }
  }
}

/* ============================== messaging =============================== */

function pushMessage(realm, msg) {
  const list = realm.messages.get(msg.chanId) || [];
  if (list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  realm.messages.set(msg.chanId, list);
  realm.typing.forEach((t, sid) => {
    if (realm.members.get(sid)?.userId === msg.author.userId) realm.typing.delete(sid);
  });
  if (realm.code === state.activeCode && msg.chanId === realm.activeChan) {
    if (!appendMessage(realm, msg)) renderMessages(false, realm);
    renderTyping();
  }
}

// Takes the newest un-acked message in a channel back off the screen. The
// newest is the only one it can be: a refusal names no nonce, and the composer
// only ever has one message in flight at a time.
function unsendOptimistic(realm, chanId) {
  const list = realm.messages.get(chanId) || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].pending) continue;
    const [msg] = list.splice(i, 1);
    realm.pendingByNonce.forEach((pending, nonce) => {
      if (pending === msg) realm.pendingByNonce.delete(nonce);
    });
    return msg;
  }
  return null;
}

// A message mentions you if it says @everyone, @here, your display name, or
// your friend tag. Names can contain spaces, so we test against the known
// names rather than trying to parse a token out of the text.
function mentionNames() {
  const names = [];
  if (state.profile?.name) names.push(state.profile.name);
  if (state.account?.tag) names.push(state.account.tag);
  return names;
}

function mentionsMe(msg, realm) {
  const meId = realm ? realmUserId(realm) : myUserId();
  if (msg.author.userId === meId) return false;
  const text = msg.content.toLowerCase();
  if (text.includes("@everyone") || text.includes("@here")) return true;
  return mentionNames().some((n) => n && text.includes("@" + n.toLowerCase()));
}

const realmUserId = (realm) =>
  realm?.me?.userId || identityFor(realm?.code)?.userId || state.profile?.userId;

function notifyIfNeeded(realm, msg) {
  if (msg.author.userId === realmUserId(realm)) return;
  const isDm = isDirect(realm);
  // A DM announces itself while you're away for the same reason a mention does,
  // so it counts as `pinged` for notification purposes — but it is NOT a
  // mention, and treating it as one flashed the whole app and rang the mention
  // chime for every ordinary line of a conversation you were already reading.
  const mentioned = mentionsMe(msg, realm);
  const pinged = isDm || mentioned;
  const looking =
    realm.code === state.activeCode &&
    msg.chanId === realm.activeChan &&
    state.view !== "home" &&
    !document.hidden &&
    document.hasFocus();

  if (!looking) {
    realm.unread.set(msg.chanId, (realm.unread.get(msg.chanId) || 0) + 1);
    // Remember where you'd got to, so the "new messages" line lands in the
    // right place when you come back.
    if (!realm.firstUnread.has(msg.chanId)) realm.firstUnread.set(msg.chanId, msg.id);
    if (pinged) realm.mentions = (realm.mentions || 0) + 1;
    if (realm.code === state.activeCode) renderChannels();
    renderServerRail();
  }

  // A muted server still counts unread — it just doesn't make a sound or
  // throw a notification at you.
  if (state.settings.muted?.[realm.code]) {
    updateTitle();
    return;
  }

  // A direct mention always announces itself, even in the channel you're
  // staring at — that's the entire point. A DM you're already reading doesn't.
  if (!looking || mentioned) {
    if (state.settings.sounds) voice.playCue(mentioned ? "mention" : "ping");
    updateTitle();
    if (!looking) desktopNotify(realm, msg, pinged);
    if (mentioned && !document.hidden) flashMention();
  }
  if (looking && state.settings.tts) speakMessage(msg);
}

// Messages recovered by a post-reconnect refill arrive as plain history, so
// nothing has counted them. They're announced as one batch rather than fed
// through notifyIfNeeded one at a time — an outage's worth of backlog would
// otherwise fire sixty pings and sixty desktop notifications at once.
function noteMissed(realm, chanId, missed) {
  const mine = realmUserId(realm);
  const fresh = missed.filter((msg) => msg.author.userId !== mine);
  if (!fresh.length) return;
  const looking =
    realm.code === state.activeCode &&
    chanId === realm.activeChan &&
    state.view !== "home" &&
    !document.hidden &&
    document.hasFocus();
  if (looking) return;

  realm.unread.set(chanId, (realm.unread.get(chanId) || 0) + fresh.length);
  if (!realm.firstUnread.has(chanId)) realm.firstUnread.set(chanId, fresh[0].id);
  const mentioned = fresh.filter((msg) => mentionsMe(msg, realm)).length;
  const pinged = isDirect(realm) ? fresh.length : mentioned;
  if (pinged) realm.mentions = (realm.mentions || 0) + pinged;
  if (realm.code === state.activeCode) renderChannels();
  renderServerRail();
  renderDmList();
  updateTitle();
  if (!state.settings.muted?.[realm.code] && state.settings.sounds) {
    voice.playCue(mentioned ? "mention" : "ping");
  }
}

/* --------------------------- read messages aloud ------------------------- */
// Opt-in on the receiving side only — nobody can force speech onto anyone
// else's machine, which is the flaw in the version Discord shipped.
function speakMessage(msg) {
  if (typeof speechSynthesis === "undefined") return;
  const text = clip(
    msg.content
      .replace(/```[\s\S]*?```/g, " code block ")
      .replace(/https?:\/\/\S+/g, " link ")
      .replace(/[*_~`|]/g, ""),
    240
  );
  if (!text.trim()) return;
  try {
    const u = new SpeechSynthesisUtterance(`${msg.author.name} says ${text}`);
    u.rate = 1.05;
    u.volume = Math.min(1, (state.settings.volume || 100) / 100);
    speechSynthesis.speak(u);
  } catch {}
}

function flashMention() {
  document.body.classList.add("mentioned");
  setTimeout(() => document.body.classList.remove("mentioned"), 900);
}

// Fires a real OS notification (a Windows toast in the desktop app). `urgent`
// marks mentions and DMs so they bypass the "only when unfocused" rule and
// don't get coalesced away by a same-channel notification.
function desktopNotify(realm, msg, urgent) {
  if (!notificationsReady()) return;
  const chan = realm.channels.find((c) => c.id === msg.chanId);
  const where =
    realm.kind === "dm"
      ? `${realm.peer?.name || msg.author.name} — direct message`
      : `${msg.author.name} • #${chan?.name || "?"} — ${realm.meta?.name || "Concord"}`;
  try {
    const n = new Notification(urgent ? `🔔 ${where}` : where, {
      body: clip(msg.content, 140),
      icon: "/icon-192.png",
      tag: "concord-" + realm.code + "-" + msg.chanId, // coalesce per channel
      renotify: !!urgent,
      requireInteraction: false,
      silent: false,
    });
    n.onclick = () => {
      window.focus();
      switchToRealm(realm.code);
      activateChannel(msg.chanId);
      n.close();
    };
  } catch {
    // some platforms throw on constructor; nothing to do
  }
}

function notificationsReady() {
  return (
    state.settings.notifs &&
    typeof Notification !== "undefined" &&
    Notification.permission === "granted"
  );
}

// Asked once, right after onboarding. If the browser has already granted it
// (common in the desktop app), just switch notifications on.
async function ensureNotificationPermission({ ask } = { ask: true }) {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") {
    if (!state.settings.notifs) {
      state.settings.notifs = true;
      store.set("settings", state.settings);
    }
    return true;
  }
  if (!ask || Notification.permission === "denied" || store.get("notifAsked", false)) return false;
  store.set("notifAsked", true);
  try {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      state.settings.notifs = true;
      store.set("settings", state.settings);
      return true;
    }
  } catch {}
  return false;
}

// DM and group unread belongs to the hub, which counts it whether or not the
// conversation has a socket open. Counting it here too would double every DM in
// the tab title — the same trap `onDmNudge` already sidesteps for the chime.
function totalUnread() {
  let n = 0;
  for (const realm of state.realms.values()) {
    if (isDirect(realm)) continue;
    realm.unread.forEach((v) => (n += v));
  }
  return n;
}
function updateTitle() {
  const n = totalUnread() + hub.totalUnread() + hub.pendingCount();
  document.title = (n ? `(${n}) ` : "") + "Concord";
}

async function sendCurrentMessage() {
  const input = $("input");
  const realm = R();
  const uploader = realm?.uploader;
  let content = input.value.trim();
  // A picture with no caption is a message. Only the pair being empty isn't.
  const staged = uploader && !uploader.isEmpty();
  if ((!content && !staged) || !state.activeChan) return;
  if (uploader?.busy()) return; // an upload in flight owns the tray

  // Slash commands rewrite (or swallow) the message before it goes anywhere.
  if (content.startsWith("/") && !content.startsWith("//")) {
    const [, name, rest = ""] = content.match(/^\/(\S+)\s*([\s\S]*)$/) || [];
    const cmd = SLASH.find((c) => c.name === (name || "").toLowerCase());
    if (cmd) {
      const out = cmd.run(rest.trim());
      input.value = "";
      autoGrow(input);
      hideAutocomplete();
      if (out === null || out === undefined || !String(out).trim()) return;
      content = String(out).slice(0, 4000);
    } else {
      toast(`No command called /${name}. Try /help.`, true);
      return;
    }
  }

  // Everything staged goes up before the message that references it exists.
  // A failure here keeps the tray exactly as it was — losing someone's file
  // because a PUT hiccuped would be unforgivable.
  let attachments = [];
  if (staged) {
    realm.flushing = true;
    renderTray(); // repaints the bars and locks the composer
    try {
      attachments = await uploader.flush();
    } catch {
      realm.flushing = false; // the uploader already said what went wrong
      renderTray();
      return;
    }
    realm.flushing = false;
    const failed = uploader.items().filter((it) => it.state === "error");
    if (failed.length || !attachments.length) {
      toast(failed[0]?.error || "Nothing uploaded — give it another go.", true);
      renderTray();
      return;
    }
    attachments = attachments.map((a) => ({ ...a, url: "/f/" + a.key }));
  }

  // An upload takes time, and the rail is still clickable while it runs — so
  // everything below addresses the realm this message was composed in.
  const chanId = realm.activeChan;
  const nonce = "n" + Math.random().toString(36).slice(2);
  const optimistic = {
    id: "pending-" + nonce,
    chanId,
    author: { userId: myUserId(), name: state.profile.name, color: state.profile.color, avatar: state.profile.avatar },
    content,
    ts: Date.now(),
    pending: true,
  };
  if (attachments.length) optimistic.attachments = attachments;
  if (realm.replyTo) optimistic.replyTo = { id: realm.replyTo.id, name: realm.replyTo.name, content: realm.replyTo.content };
  realm.pendingByNonce.set(nonce, optimistic);
  const list = realm.messages.get(chanId) || [];
  list.push(optimistic);
  realm.messages.set(chanId, list);

  realm.send({
    type: "msg",
    chanId,
    content,
    nonce,
    replyTo: realm.replyTo?.id,
    attachments: attachments.length ? attachments : undefined,
  });
  uploader?.clear();
  renderTray();
  // The other half of a DM isn't connected to its Durable Object unless they
  // have it open, so the hub is what lights up their sidebar.
  if (realm?.kind === "dm" && realm.peer) {
    hub.nudgeDm(realm.peer.uid, clip(content, 120));
  } else if (realm?.kind === "group" && realm.group) {
    hub.nudgeGroup(realm.group.id, clip(content, 120));
  }
  state.lastTypingSent = 0; // sending ends "typing"; next keystroke signals fresh
  input.value = "";
  autoGrow(input);
  updateCharCount();
  hideAutocomplete();
  clearReply();
  renderMessages(true, realm); // sending is a deliberate act; always show the result

  // Progression + the little burst of light, both entirely local.
  const sent = bumpStat("messages");
  addXp(4);
  if (sent === 1) unlock("first-word");
  if (sent === 100) unlock("chatterbox");
  if (sent === 1000) unlock("novelist");
  const hour = new Date().getHours();
  if (hour >= 3 && hour < 5) unlock("night-owl");
  if (state.settings.turbo) {
    const box = $("composer").getBoundingClientRect();
    burst(box.right - 40, box.top + box.height / 2);
  }
}

/* ============================ markdown-lite ============================= */

// `code` says which server's :names: are in scope. Passed in rather than read
// off the active realm, because a pin or a search hit is rendered for the realm
// it came from, not the one the eye happens to be on. `realm` is that same
// realm — derived from `code` so no caller has to remember, since the member
// list backing @mentions has to travel with the emoji or they disagree.
function renderMarkdown(text, code, realm = state.realms.get(code) || R()) {
  const codeBlocks = [];
  // esc() has just removed every control character, so U+0000 cannot appear in
  // the text below and is a collision-free sentinel for protected fragments.
  const placeholder = (i) => `\u0000${i}\u0000`;
  let t = esc(text);
  t = t.replace(/```([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre><code>${code.replace(/^\n|\n$/g, "")}</code></pre>`);
    return placeholder(codeBlocks.length - 1);
  });
  t = t.replace(/`([^`\n]+)`/g, (_, code) => {
    codeBlocks.push(`<code>${code}</code>`);
    return placeholder(codeBlocks.length - 1);
  });
  // Links are sentinel-protected too, so the emphasis passes below can never
  // mangle characters inside an emitted href.
  // \u0000 excluded so a URL can't swallow an earlier fragment's sentinel.
  t = t.replace(/(https?:\/\/[^\s<\u0000]+)/g, (url) => {
    // A trailing pipe closes a spoiler far more often than it belongs to an
    // address, and swallowing it left the link someone meant to hide in plain
    // sight with no spoiler around it at all.
    const tail = url.match(/\|+$/)?.[0] || "";
    const href = url.slice(0, url.length - tail.length);
    codeBlocks.push(`<a href="${href}" target="_blank" rel="noreferrer noopener">${href}</a>`);
    return placeholder(codeBlocks.length - 1) + tail;
  });
  // Lazy rather than [^*]+, so bold can contain an italic run instead of
  // failing to form and showing the reader its own asterisks.
  t = t.replace(/\*\*([\s\S]+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" title="Click to reveal">$1</span>');
  t = highlightMentions(t, realm);
  // After code and links are behind sentinels, before those come back: a
  // ":shrug:" typed inside a fenced block has to stay literal both ways round.
  t = renderCustomEmoji(t, code, emojiReg);
  t = t.replace(/\u0000(\d+)\u0000/g, (whole, i) => codeBlocks[+i] ?? whole);
  return t;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Sorting a few hundred names and compiling the alternation costs more than the
// markdown does, and it happens once per message rendered. The set only moves
// when someone joins, leaves or is renamed, so those bump the epoch and
// everything in between reuses the compiled pattern. Your own name and tag are
// in the key directly rather than needing a bump of their own.
let mentionEpoch = 0;
const bumpMentions = () => mentionEpoch++;
let mentionCache = { key: null, re: null, mine: null };

function mentionMatcher(realm) {
  const key = `${realm?.code || ""} ${mentionEpoch} ${realm?.members.size ?? 0} ${hub.friends.size} ${
    state.profile?.name || ""
  } ${state.account?.tag || ""}`;
  if (mentionCache.key === key) return mentionCache;
  const names = new Set(["everyone", "here"]);
  for (const member of (realm?.members || NO_MAP).values()) names.add(member.name);
  for (const f of hub.friends.values()) {
    names.add(f.name);
    if (f.tag) names.add(f.tag);
  }
  if (state.profile?.name) names.add(state.profile.name);
  if (state.account?.tag) names.add(state.account.tag);
  const mine = new Set(mentionNames().map((n) => n.toLowerCase()).concat(["everyone", "here"]));
  // Longest first so "@Keith the Guy" wins over "@Keith".
  const alts = [...names]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((n) => reEsc(esc(n)));
  let re = null;
  try {
    if (alts.length) re = new RegExp(`@(${alts.join("|")})`, "gi");
  } catch {
    re = null; // a pathological name broke the pattern; render it plain
  }
  mentionCache = { key, re, mine };
  return mentionCache;
}

// Runs on already-escaped text, so names are matched in their escaped form
// too. Only names we actually know light up — a stray @ is left alone. The
// realm is a parameter because "who is in this conversation" is a property of
// the message being rendered, not of whichever server you happen to be on.
function highlightMentions(t, realm = R()) {
  const { re, mine } = mentionMatcher(realm);
  if (!re) return t;
  return t.replace(re, (whole, name) => {
    const isMe = mine.has(name.toLowerCase());
    return `<span class="mention${isMe ? " me" : ""}">@${name}</span>`;
  });
}

/* =============================== rendering ============================== */

function renderAll() {
  renderServerRail();
  renderChannels();
  renderMembers();
  renderMe();
  renderDmList();
  renderHomeBadge();
  renderVoicePanel();
  renderTray(); // the tray belongs to the realm, so it follows the switch
  applyView();
}

/* ------------------------------ view switch ------------------------------ */
// Three views share one shell: "server" (channels + chat), "home" (DM list +
// friends), and "dm" (DM list + chat with one friend).

function applyView() {
  const app = $("app");
  app.classList.toggle("home-view", state.view === "home");
  app.classList.toggle("dm-view", state.view === "dm");
  $("channels").classList.toggle("hidden", state.view !== "server");
  $("dm-panel").classList.toggle("hidden", state.view === "server");
  $("friends-view").classList.toggle("hidden", state.view !== "home");
  $("chat-view").classList.toggle("hidden", state.view === "home");
  $("home-btn").classList.toggle("active", state.view !== "server");

  const isDm = state.view === "dm";
  $("btn-invite").classList.toggle("hidden", state.view !== "server");
  $("btn-gremlin").classList.toggle("hidden", state.view !== "server");
  $("btn-members").classList.toggle("hidden", state.view !== "server");
  $("member-count").classList.toggle("hidden", state.view !== "server");
  $("btn-call").classList.toggle("hidden", !isDm);
  $("btn-pins").classList.toggle("hidden", state.view === "home");
  $("btn-search").classList.toggle("hidden", state.view === "home");
  $("server-caret").classList.toggle("hidden", state.view !== "server");
  $("server-header").style.cursor = state.view === "server" ? "pointer" : "default";

  if (state.view === "server") {
    $("server-name").textContent = state.meta?.name || "Concord";
  } else {
    $("server-name").textContent = "Direct Messages";
  }
  renderVoicePanel();
  renderChatHeader();
}

function goHome() {
  state.view = "home";
  state.fvTab = hub.pendingCount() ? "pending" : "online";
  applyView();
  renderFriendsView();
  renderDmList();
}

// Switching what you're LOOKING at. Nothing here disconnects anything: every
// realm keeps its socket, so the server you just left keeps collecting
// messages and a call in progress carries on untouched.
function switchToRealm(code) {
  if (!code) return null;
  const realm = state.realms.get(code);
  if (!realm) return null;
  state.activeCode = code;
  realm.touched = Date.now();
  state.view = isDirect(realm) ? "dm" : "server";
  if (realm.kind === "guild") store.set("lastServer", code);
  realm.mentions = 0;
  applyView();
  renderAll();
  if (realm.activeChan) activateChannel(realm.activeChan);
  else renderMessages(true);
  return realm;
}

function goServer(code) {
  if (!code) return;
  const entry = state.servers.find((s) => s.code === code);
  const realm = openRealm(code, "guild", { kind: "reopen", code });
  if (entry && !realm.meta) realm.meta = { name: entry.name, icon: entry.icon };
  switchToRealm(code);
}

// Opening a DM gives it its own connection. It does NOT disturb the server you
// were in, and it does NOT touch a call in progress.
function openDm(uid) {
  const friend = hub.friends.get(uid);
  if (!friend) return;
  const code = hub.dmCodes.get(uid);
  if (code) openDmRealm(uid, code, friend);
  else hub.openDm(uid); // hub replies with dm-ready, which lands here again
}

function openDmRealm(uid, code, user) {
  const friend = { ...(hub.friends.get(uid) || {}), ...(user || {}), uid };
  hub.markDmRead(uid);
  const realm = openRealm(code, "dm", { kind: "dm", code, uid });
  realm.peer = friend;
  switchToRealm(code);
  renderDmList();
}

/* ------------------------------ group DMs -------------------------------- */
// A group is the same machinery as a 1:1 DM — the hub owns the membership and
// the secret code, the conversation is an ordinary ConcordServer — so group
// voice calls work for free too.

function openGroup(id) {
  const group = hub.groups.get(id);
  if (!group) return;
  if (group.code) openGroupRealm(group);
  else hub.openGroup(id); // hub replies with gdm-ready, which lands here again
}

function openGroupRealm(group) {
  hub.markDmRead(group.id);
  const realm = openRealm(group.code, "group", { kind: "dm", code: group.code, gdm: group.id });
  realm.group = group;
  realm.peer = null;
  switchToRealm(group.code);
  renderDmList();
}

// Both flavours of direct conversation behave the same nearly everywhere.
const isDirect = (realm) => realm?.kind === "dm" || realm?.kind === "group";

function openNewGroupModal(seedUid) {
  const friends = [...hub.friends.values()];
  if (friends.length < 1) {
    toast("You need at least one friend to start a group. Add someone first.", true);
    return;
  }
  showModal("group-modal");
  $("gdm-name").value = "";
  const list = $("gdm-friends");
  list.textContent = "";
  const chosen = new Set(seedUid ? [seedUid] : []);
  for (const f of friends) {
    const row = el("label", "gdm-pick");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = chosen.has(f.uid);
    box.onchange = () => {
      if (box.checked) chosen.add(f.uid);
      else chosen.delete(f.uid);
      $("gdm-count").textContent = `${chosen.size + 1} of 10`;
    };
    const av = el("span", "avatar small", f.avatar);
    av.style.background = f.color;
    row.append(box, av, el("span", "gdm-pick-name", f.name));
    list.appendChild(row);
  }
  $("gdm-count").textContent = `${chosen.size + 1} of 10`;
  $("gdm-create").onclick = () => {
    if (!chosen.size) {
      toast("Pick at least one friend.", true);
      return;
    }
    hub.createGroup($("gdm-name").value.trim(), [...chosen]);
    closeModals();
  };
}

function groupMenu(x, y, group) {
  ctxMenu(x, y, [
    { label: "Open", onClick: () => openGroup(group.id) },
    {
      label: "Rename Group",
      onClick: () =>
        promptModal("Group name", group.name || "", (v) => hub.renameGroup(group.id, v)),
    },
    { label: "Add Friend to Group", onClick: () => openAddToGroup(group) },
    {
      label: "Leave Group",
      danger: true,
      onClick: () =>
        confirmModal(
          `Leave "${groupTitle(group, hub.me?.uid)}"?`,
          "You'll stop getting messages from it. The others carry on without you.",
          () => hub.leaveGroup(group.id)
        ),
    },
  ]);
}

function openAddToGroup(group) {
  const inGroup = new Set(group.members.map((m) => m.uid));
  const candidates = [...hub.friends.values()].filter((f) => !inGroup.has(f.uid));
  if (!candidates.length) {
    toast("Everyone you know is already in there.", true);
    return;
  }
  ctxMenu(
    window.innerWidth / 2 - 110,
    140,
    candidates.slice(0, 12).map((f) => ({
      label: `${f.avatar} ${f.name}`,
      onClick: () => hub.addToGroup(group.id, f.uid),
    }))
  );
}

/* -------------------------------- DM list -------------------------------- */

function renderHomeBadge() {
  const n = hub.totalUnread() + hub.pendingCount();
  const badge = $("home-badge");
  badge.textContent = n > 99 ? "99+" : String(n);
  badge.classList.toggle("hidden", !n);
  const pend = hub.pendingCount();
  for (const id of ["dm-pending-badge", "fv-pending-badge"]) {
    const b = $(id);
    if (!b) continue;
    b.textContent = String(pend);
    b.classList.toggle("hidden", !pend);
  }
  updateTitle();
}

function presenceClass(f) {
  if (!f.online || f.presence === "invisible") return "offline";
  return PRESENCE_META[f.presence]?.dot || "online";
}

function renderDmList() {
  const wrap = $("dm-list");
  if (!wrap) return;
  wrap.textContent = "";
  const friends = [...hub.friends.values()].sort((a, b) => {
    const ua = hub.unread.get(a.uid) || 0;
    const ub = hub.unread.get(b.uid) || 0;
    if (ua !== ub) return ub - ua;
    const oa = a.online && a.presence !== "invisible" ? 0 : 1;
    const ob = b.online && b.presence !== "invisible" ? 0 : 1;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });
  // Groups sit above the 1:1 list, most-recently-noisy first.
  const groups = [...hub.groups.values()].sort(
    (a, b) => (hub.unread.get(b.id) || 0) - (hub.unread.get(a.id) || 0)
  );
  for (const g of groups) {
    const active = state.view === "dm" && R()?.group?.id === g.id;
    const row = el("div", "dm-row" + (active ? " active" : ""));
    const icon = el("div", "avatar small group", g.icon || "👥");
    row.appendChild(icon);
    const col = el("div", "dm-col");
    col.appendChild(el("span", "dm-name", groupTitle(g, hub.me?.uid)));
    col.appendChild(el("span", "dm-sub", `${g.members.length} members`));
    row.appendChild(col);
    const gUnread = hub.unread.get(g.id);
    if (gUnread) row.appendChild(el("span", "chan-badge", String(Math.min(gUnread, 99))));
    row.onclick = () => openGroup(g.id);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      groupMenu(e.clientX, e.clientY, g);
    };
    wrap.appendChild(row);
  }

  if (!friends.length && !groups.length) {
    const empty = el("div", "dm-empty", "No friends yet. Hit + to add someone by their tag.");
    wrap.appendChild(empty);
    return;
  }
  for (const f of friends) {
    const row = el("div", "dm-row" + (state.view === "dm" && state.dmPeer?.uid === f.uid ? " active" : ""));
    const wrapAv = el("div", "avatar-wrap small");
    const av = el("div", "avatar", f.avatar);
    av.style.background = f.color;
    wrapAv.appendChild(av);
    wrapAv.appendChild(el("span", "presence-dot " + presenceClass(f)));
    row.appendChild(wrapAv);
    row.appendChild(el("span", "dm-name", f.name));
    const dmCode = hub.dmCodes.get(f.uid);
    const dmRealm = dmCode ? state.realms.get(dmCode) : null;
    let typing = false;
    dmRealm?.typing.forEach((t) => {
      if (t.until > Date.now()) typing = true;
    });
    if (typing) row.appendChild(el("span", "dm-typing", "typing…"));
    const unread = hub.unread.get(f.uid);
    if (unread) row.appendChild(el("span", "chan-badge", String(Math.min(unread, 99))));
    row.onclick = () => openDm(f.uid);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      friendMenu(e.clientX, e.clientY, f);
    };
    wrap.appendChild(row);
  }
}

function friendMenu(x, y, f) {
  ctxMenu(x, y, [
    { label: "Message", onClick: () => openDm(f.uid) },
    { label: "👥 Start Group With…", onClick: () => openNewGroupModal(f.uid) },
    { label: "Poke 👉", onClick: () => hub.poke(f.uid) },
    { label: "Copy Tag", onClick: () => copyText("@" + f.tag, "Tag copied") },
    {
      label: "Remove Friend",
      danger: true,
      onClick: () =>
        confirmModal(`Remove ${f.name}?`, "Your DM history stays put, but you'll have to add each other again.", () =>
          hub.remove(f.uid)
        ),
    },
  ]);
}

/* ------------------------------ friends view ----------------------------- */

function renderFriendsView() {
  const body = $("fv-body");
  if (!body) return;
  document.querySelectorAll("#fv-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === state.fvTab);
  });
  body.textContent = "";

  if (state.fvTab === "add") {
    body.appendChild(renderAddFriend());
    return;
  }

  if (state.fvTab === "pending") {
    const incoming = [...hub.incoming.values()];
    const outgoing = [...hub.outgoing.values()];
    if (!incoming.length && !outgoing.length) {
      body.appendChild(emptyState("🕊️", "No pending requests", "Nobody wants anything from you. Peaceful."));
      return;
    }
    if (incoming.length) {
      body.appendChild(el("div", "fv-head", `Incoming — ${incoming.length}`));
      for (const u of incoming) body.appendChild(friendRow(u, "incoming"));
    }
    if (outgoing.length) {
      body.appendChild(el("div", "fv-head", `Sent — ${outgoing.length}`));
      for (const u of outgoing) body.appendChild(friendRow(u, "outgoing"));
    }
    return;
  }

  let friends = [...hub.friends.values()];
  if (state.fvTab === "online") friends = friends.filter((f) => f.online && f.presence !== "invisible");
  friends.sort((a, b) => a.name.localeCompare(b.name));

  if (!friends.length) {
    body.appendChild(
      state.fvTab === "online"
        ? emptyState("🌙", "Nobody's around", "Your friends are all offline. Or hiding.")
        : emptyState("👋", "No friends yet", "Click Add Friend and give someone your tag.")
    );
    return;
  }
  body.appendChild(el("div", "fv-head", `${state.fvTab === "online" ? "Online" : "All Friends"} — ${friends.length}`));
  for (const f of friends) body.appendChild(friendRow(f, "friend"));
}

function emptyState(emoji, title, sub) {
  const wrap = el("div", "fv-empty");
  wrap.appendChild(el("div", "fv-empty-emoji", emoji));
  wrap.appendChild(el("div", "fv-empty-title", title));
  wrap.appendChild(el("div", "fv-empty-sub", sub));
  return wrap;
}

function friendRow(f, mode) {
  const row = el("div", "friend-row");
  const wrapAv = el("div", "avatar-wrap");
  const av = el("div", "avatar", f.avatar);
  av.style.background = f.color;
  wrapAv.appendChild(av);
  wrapAv.appendChild(el("span", "presence-dot " + presenceClass(f)));
  row.appendChild(wrapAv);

  const col = el("div", "m-col");
  const name = el("div", "m-name", f.name);
  name.style.color = f.color;
  col.appendChild(name);
  const sub =
    mode === "incoming"
      ? "Wants to be your friend"
      : mode === "outgoing"
      ? "Request sent"
      : f.status || (f.online && f.presence !== "invisible" ? PRESENCE_META[f.presence]?.label || "Online" : "Offline");
  col.appendChild(el("div", "m-status", `@${f.tag} · ${sub}`));
  row.appendChild(col);

  const actions = el("div", "friend-actions");
  if (mode === "incoming") {
    const yes = el("button", "primary-btn tiny", "Accept");
    yes.onclick = () => hub.accept(f.uid);
    const no = el("button", "pill-btn tiny", "Ignore");
    no.onclick = () => hub.decline(f.uid);
    actions.append(yes, no);
  } else if (mode === "outgoing") {
    const cancel = el("button", "pill-btn tiny", "Cancel");
    cancel.onclick = () => hub.decline(f.uid);
    actions.appendChild(cancel);
  } else {
    const msg = el("button", "icon-btn", "💬");
    msg.title = "Message";
    msg.onclick = () => openDm(f.uid);
    const poke = el("button", "icon-btn", "👉");
    poke.title = "Poke";
    poke.onclick = () => hub.poke(f.uid);
    const more = el("button", "icon-btn", "⋯");
    more.title = "More";
    more.onclick = (e) => {
      e.stopPropagation(); // the document handler would close the menu otherwise
      friendMenu(e.clientX - 160, e.clientY, f);
    };
    actions.append(msg, poke, more);
  }
  row.appendChild(actions);
  return row;
}

function renderAddFriend() {
  const wrap = el("div", "add-friend");
  wrap.appendChild(el("h2", "", "Add a friend"));
  wrap.appendChild(
    el("p", "modal-sub", "Friend tags are how people find each other here. Ask for theirs, or send them yours.")
  );

  const row = el("div", "add-friend-row");
  const at = el("span", "tag-at", "@");
  const input = document.createElement("input");
  input.placeholder = "their-tag";
  input.maxLength = 25;
  input.autocomplete = "off";
  const btn = el("button", "primary-btn", "Send Request");
  const submit = () => {
    const tag = input.value.trim().replace(/^@/, "").toLowerCase();
    if (!tag) return;
    hub.addFriend(tag);
    input.value = "";
  };
  btn.onclick = submit;
  input.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
  row.append(at, input, btn);
  wrap.appendChild(row);

  const mine = el("div", "your-tag");
  mine.appendChild(el("span", "", "Your tag is "));
  const code = el("b", "", "@" + (hub.me?.tag || state.account?.tag || "…"));
  mine.appendChild(code);
  const copy = el("button", "pill-btn tiny", "Copy");
  copy.onclick = () => copyText("@" + (hub.me?.tag || ""), "Your tag is on the clipboard.");
  mine.appendChild(copy);
  const change = el("button", "pill-btn tiny", "Change");
  change.onclick = () =>
    promptModal("Pick a new tag", hub.me?.tag || "", (v) => hub.setTag(v.replace(/^@/, "").toLowerCase()));
  mine.appendChild(change);
  wrap.appendChild(mine);
  setTimeout(() => input.focus(), 0);
  return wrap;
}

function renderServerRail() {
  const list = $("server-list");
  list.textContent = "";
  for (const s of state.servers) {
    const active = s.code === state.activeCode && state.view === "server";
    const b = el("div", "server-bubble" + (active ? " active" : ""), s.icon);
    b.title = s.name;

    // Because every server stays connected, unread counts are real even for
    // the ones you aren't looking at.
    const realm = state.realms.get(s.code);
    let unread = 0;
    realm?.unread.forEach((v) => (unread += v));
    if (unread) {
      const badge = el("span", "badge", String(Math.min(unread, 99)));
      if (realm?.mentions) badge.classList.add("mention-badge");
      b.appendChild(badge);
      b.classList.add("has-unread");
    }
    if (state.voiceCode === s.code) b.classList.add("in-call");

    b.onclick = () => goServer(s.code);
    if (state.settings.muted?.[s.code]) b.classList.add("muted");
    b.oncontextmenu = (e) => {
      e.preventDefault();
      const isMuted = !!state.settings.muted?.[s.code];
      ctxMenu(e.clientX, e.clientY, [
        { label: "Mark As Read", onClick: () => markRealmRead(s.code) },
        {
          label: isMuted ? "🔔 Unmute Server" : "🔕 Mute Server",
          onClick: () => setServerMuted(s.code, !isMuted),
        },
        { label: "Copy Invite Code", onClick: () => copyText(s.code, "Invite code copied") },
        { label: "Leave Server", danger: true, onClick: () => confirmLeaveServer(s) },
      ]);
    };
    list.appendChild(b);
  }
}

// Muting is per server and purely local — it silences pings without telling
// anyone or leaving anything.
function setServerMuted(code, muted) {
  const all = { ...(state.settings.muted || {}) };
  if (muted) all[code] = true;
  else delete all[code];
  state.settings.muted = all;
  store.set("settings", state.settings);
  renderServerRail();
  const name = state.servers.find((s) => s.code === code)?.name || "Server";
  toast(muted ? `🔕 ${name} muted — still unread, just quiet.` : `🔔 ${name} unmuted.`);
}

function markRealmRead(code) {
  const realm = state.realms.get(code);
  if (!realm) return;
  realm.unread.clear();
  realm.firstUnread.clear();
  realm.mentions = 0;
  renderServerRail();
  if (code === state.activeCode) renderChannels();
  updateTitle();
}

const catKey = (code, cat) => `${code}/${cat}`;
const isCollapsed = (cat) => !!state.settings.collapsed?.[catKey(state.currentCode, cat)];

function setCollapsed(cat, on) {
  const all = { ...(state.settings.collapsed || {}) };
  const key = catKey(state.currentCode, cat);
  if (on) all[key] = true;
  else delete all[key];
  state.settings.collapsed = all;
  store.set("settings", state.settings);
  renderChannels();
}

// A folded category still has to show anything that wants you: hiding a
// channel that's pinging you is how you miss things.
function chanNeedsSeeing(c) {
  return c.id === state.activeChan || !!state.unread.get(c.id) || state.voiceChan === c.id;
}

function renderChannels() {
  const textWrap = $("text-channels");
  const voiceWrap = $("voice-channels");
  textWrap.textContent = "";
  voiceWrap.textContent = "";

  const threadsOf = new Map(); // parent chanId -> thread channels
  for (const c of state.channels) {
    if (c.type !== "thread") continue;
    const list = threadsOf.get(c.parent) || [];
    list.push(c);
    threadsOf.set(c.parent, list);
  }

  const wants = (c) => chanNeedsSeeing(c) || (threadsOf.get(c.id) || []).some(chanNeedsSeeing);

  // Uncategorised first, then one collapsible group per category, in the order
  // the categories first appear in the channel list.
  function paint(wrap, channels) {
    const loose = channels.filter((c) => !c.cat);
    for (const c of loose) appendChanRow(wrap, c, threadsOf, false);
    const cats = [];
    for (const c of channels) if (c.cat && !cats.includes(c.cat)) cats.push(c.cat);
    for (const cat of cats) {
      const mine = channels.filter((c) => c.cat === cat);
      const folded = isCollapsed(cat);
      const head = el("div", "cat-head" + (folded ? " folded" : ""));
      head.appendChild(el("span", "cat-caret", folded ? "▸" : "▾"));
      head.appendChild(el("span", "cat-name", cat));
      head.appendChild(el("span", "cat-count", String(mine.length)));
      head.onclick = () => setCollapsed(cat, !folded);
      wrap.appendChild(head);
      for (const c of mine) {
        if (folded && !wants(c)) continue;
        appendChanRow(wrap, c, threadsOf, folded);
      }
    }
  }

  paint(textWrap, state.channels.filter((c) => c.type === "text"));
  paint(voiceWrap, state.channels.filter((c) => c.type === "voice"));
}

// `folded` means the parent category is collapsed, so only threads that want
// attention come along for the ride.
function appendChanRow(wrap, c, threadsOf, folded) {
  const voiceChan = c.type === "voice";
  const row = el("div", "chan-row" + (voiceChan ? " voice" : ""));
  row.appendChild(el("span", "chan-icon", voiceChan ? "🔊" : "#"));
  row.appendChild(el("span", "chan-label", c.name));
  if (c.slow) {
    const slow = el("span", "chan-slow", "🐌");
    slow.title = `Slowmode — ${slowLabel(c.slow)}`;
    row.appendChild(slow);
  }
  if (c.id === state.activeChan) row.classList.add("active");
  const unread = state.unread.get(c.id);
  if (unread) row.appendChild(el("span", "chan-badge", String(Math.min(unread, 99))));
  // Clicking a voice channel joins its call, because that's what anyone
  // clicking it means. Once you're in, the same click opens the chat that
  // channel has always had; the 💬 gets you that chat without joining, since a
  // voice channel takes messages whether or not you're listening to it.
  // Joining deliberately does NOT drag your reading position into the call:
  // people join a room and carry on reading the channel they were in.
  const inThisCall = voiceChan && state.voiceCode === state.currentCode && state.voiceChan === c.id;
  row.title = voiceChan ? (inThisCall ? "Open this channel's chat" : "Join the call") : "";
  row.onclick = () => {
    if (!voiceChan || inThisCall) activateChannel(c.id);
    else joinVoice(c.id);
  };

  if (voiceChan) {
    const chat = el("button", "chan-chat", "💬");
    chat.title = "Open this channel's chat";
    chat.onclick = (e) => {
      e.stopPropagation();
      activateChannel(c.id);
    };
    row.appendChild(chat);
  }

  const gear = el("button", "chan-gear", "⚙");
  gear.title = "Channel settings";
  gear.onclick = (e) => {
    e.stopPropagation();
    channelMenu(e, c);
  };
  row.appendChild(gear);
  wrap.appendChild(row);

  for (const t of threadsOf.get(c.id) || []) {
    if (folded && !chanNeedsSeeing(t)) continue;
    wrap.appendChild(threadRow(t));
  }

  if (!voiceChan) return;
  const users = el("div", "voice-users");
  for (const member of state.members.values()) {
    if (member.voice?.chanId !== c.id) continue;
    const u = el("div", "voice-user");
    const av = el("span", "vu-avatar", member.avatar);
    av.style.background = member.color;
    av.dataset.vsid = member.sid;
    if (voice.isSpeaking(member.sid === state.me?.sid ? "me" : member.sid)) av.classList.add("speaking");
    u.appendChild(av);
    u.appendChild(el("span", "vu-name", member.name));
    const icons = el("span", "vu-icons");
    if (member.voice.muted) icons.append("🔇");
    if (member.voice.deafened) icons.append("🎧");
    if (member.voice.sharing) icons.append(member.voice.shareKind === "camera" ? "📹" : "🖥");
    u.appendChild(icons);
    // Volume controls only make sense for people you can actually hear,
    // i.e. when the call is in the realm you're looking at.
    if (
      member.sid !== state.me?.sid &&
      state.voiceCode === state.activeCode &&
      member.voice.chanId === state.voiceChan
    ) {
      u.oncontextmenu = (e) => {
        e.preventDefault();
        volumeMenu(e, member);
      };
      u.onclick = (e) => {
        e.stopPropagation();
        volumeMenu(e, member);
      };
    }
    users.appendChild(u);
  }
  if (users.childNodes.length) wrap.appendChild(users);
}

// A thread is a channel, so this row is the ordinary one minus the gear —
// renaming and deleting a thread is what its parent's menu is for.
function threadRow(t) {
  const row = el("div", "chan-row thread-row" + (t.id === state.activeChan ? " active" : ""));
  row.appendChild(el("span", "chan-icon", "💬"));
  row.appendChild(el("span", "chan-label", t.name));
  if (t.slow) row.appendChild(el("span", "chan-slow", "🐌"));
  const unread = state.unread.get(t.id);
  if (unread) row.appendChild(el("span", "chan-badge", String(Math.min(unread, 99))));
  row.onclick = () => activateChannel(t.id);
  const gear = el("button", "chan-gear", "⚙");
  gear.title = "Thread settings";
  gear.onclick = (e) => {
    e.stopPropagation();
    channelMenu(e, t);
  };
  row.appendChild(gear);
  return row;
}

const slowLabel = (seconds) =>
  SLOWMODE_CHOICES.find((s) => s.seconds === seconds)?.label || `${seconds} seconds`;

const chanTypeOf = (chanId) => state.channels.find((c) => c.id === chanId)?.type || "text";

function channelMenu(e, c) {
  const items = [
    {
      label: "Rename Channel",
      onClick: () =>
        promptModal(`Rename ${c.type === "text" ? "#" : ""}${c.name}`, c.name, (v) =>
          wsSend({ type: "update-channel", chanId: c.id, name: v })
        ),
    },
  ];
  if (c.type === "text") {
    items.push({
      label: "Edit Topic",
      onClick: () =>
        promptModal(`Topic for #${c.name}`, c.topic || "", (v) =>
          wsSend({ type: "update-channel", chanId: c.id, topic: v })
        ),
    });
  }
  if (c.type !== "thread") {
    items.push({
      label: "Move to Category…",
      onClick: () =>
        promptModal(
          `Category for ${c.name}`,
          c.cat || "",
          (v) => wsSend({ type: "update-channel", chanId: c.id, cat: v }),
          { allowEmpty: true } // clearing the box is how you take it back out
        ),
    });
  }
  items.push({
    label: "Set Slowmode…",
    // A tick later, because the click that picked this item is still on its way
    // to the document handler that closes menus — which would shut the second
    // one the moment it opened.
    onClick: () => setTimeout(() => openSlowmodePicker(e.clientX, e.clientY, c), 0),
  });
  items.push({
    label: "Delete Channel",
    danger: true,
    onClick: () =>
      confirmModal(`Delete ${c.type === "text" ? "#" : ""}${c.name}?`, "Messages in it are gone forever. Poof.", () =>
        wsSend({ type: "delete-channel", chanId: c.id })
      ),
  });
  ctxMenu(e.clientX, e.clientY, items);
}

function openSlowmodePicker(x, y, c) {
  ctxMenu(
    x,
    y,
    SLOWMODE_CHOICES.map((choice) => ({
      label: (c.slow || 0) === choice.seconds ? `✓ ${choice.label}` : choice.label,
      onClick: () => wsSend({ type: "update-channel", chanId: c.id, slow: choice.seconds }),
    }))
  );
}

/* ------------------------------- slowmode -------------------------------- */
// The server bounced a message and told us how long to wait. The text is still
// sitting in the composer, so all this does is hold the send until the clock
// runs out — syncComposer owns the box, this only feeds it a number.

const slowUntil = new Map(); // `${code}/${chanId}` -> when you may post again
let slowTicker = null;

function slowLeft(code, chanId) {
  const until = slowUntil.get(`${code}/${chanId}`) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

function startSlowTicker() {
  if (slowTicker) return;
  slowTicker = setInterval(() => {
    for (const [key, until] of slowUntil) if (until <= Date.now()) slowUntil.delete(key);
    syncComposer();
    if (!slowUntil.size) {
      clearInterval(slowTicker);
      slowTicker = null;
    }
  }, 250);
}

// Right-clicking anyone in a server: message them, add them, prank them, or
// set their volume if you're currently in a call with them. Offline people
// come from the roster and have no sid, so anything that needs a live socket
// is left out rather than offered and then quietly failing.
function memberMenu(e, member) {
  const isMe = member.sid ? member.sid === state.me?.sid : member.userId === realmUserId(R());
  if (isMe) {
    ctxMenu(e.clientX, e.clientY, [{ label: "Edit Profile", onClick: openSettings }]);
    return;
  }
  const friend = friendFor(member);
  const items = [
    {
      label: "View Profile",
      onClick: () => openProfile(e.clientX - 300, e.clientY - 40, member),
    },
  ];
  if (friend) {
    items.push({ label: "💬 Message", onClick: () => openDm(friend.uid) });
    items.push({ label: "👉 Poke", onClick: () => hub.poke(friend.uid) });
  } else if (member.tag) {
    items.push({ label: `Add Friend (@${member.tag})`, onClick: () => hub.addFriend(member.tag) });
  } else {
    items.push({ label: "No friend tag — ask them for it", onClick: () => {} });
  }
  if (member.sid) items.push({ label: "🃏 Prank", onClick: () => openGremlinModal(member.sid) });
  // The server checks ownership itself; this is only about not offering
  // buttons that would bounce.
  if (iAmOwner() && member.userId) {
    items.push({
      label: "👢 Kick",
      danger: true,
      onClick: () =>
        confirmModal(`Kick ${member.name}?`, "They can walk straight back in with the invite code.", () =>
          wsSend({ type: "kick", userId: member.userId })
        ),
    });
    items.push({
      label: "🔨 Ban",
      danger: true,
      onClick: () =>
        confirmModal(`Ban ${member.name}?`, "They stay out until you unban them from Banned People.", () =>
          wsSend({ type: "ban", userId: member.userId })
        ),
    });
  }
  const inCallTogether =
    member.sid && state.voiceCode === state.activeCode && member.voice && member.voice.chanId === state.voiceChan;
  if (inCallTogether) {
    items.push({ label: "🔊 Volume…", onClick: () => volumeMenu(e, member) });
  }
  ctxMenu(e.clientX, e.clientY, items);
}

const isOwnerOf = (realm, userId) => !!realm?.owner && !!userId && realm.owner === userId;
const iAmOwner = () => isOwnerOf(R(), realmUserId(R()));

function renderBans(list) {
  showModal("bans-modal");
  const out = $("bans-list");
  out.textContent = "";
  if (!list.length) {
    out.appendChild(emptyState("🕊️", "Nobody's banned", "A clean record. Long may it last."));
    return;
  }
  for (const row of list) {
    const line = el("div", "pin-row");
    line.appendChild(el("div", "avatar small", "🔨"));
    const col = el("div", "m-col");
    col.appendChild(el("div", "m-name", row.name || "(no name on file)"));
    col.appendChild(el("div", "m-status", `Banned ${agoText(row.at)}`));
    line.appendChild(col);
    const unban = el("button", "pill-btn tiny", "Unban");
    unban.onclick = () => wsSend({ type: "unban", userId: row.userId });
    line.appendChild(unban);
    out.appendChild(line);
  }
}

function volumeMenu(e, member) {
  const wrap = el("div", "volume-menu");
  wrap.style.padding = "8px 10px";
  const label = el("div", "", `${member.name} — volume ${voice.getUserVolume(member.sid)}%`);
  label.style.cssText = "font-size:12px;color:#949ba4;margin-bottom:6px";
  const range = document.createElement("input");
  range.type = "range";
  range.min = "0";
  range.max = "200";
  range.value = String(voice.getUserVolume(member.sid));
  range.oninput = () => {
    voice.setUserVolume(member.sid, +range.value);
    label.textContent = `${member.name} — volume ${range.value}%`;
  };
  wrap.appendChild(label);
  wrap.appendChild(range);
  ctxMenu(e.clientX, e.clientY, [{ custom: wrap }]);
}

// "just now" up to a date, which is as much precision as anybody wants about
// when someone was last around.
function agoText(ts) {
  const diff = Date.now() - (ts || 0);
  if (!ts || diff < 60_000) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
}

// A 200-person roster shouldn't cost 200 nodes every time somebody joins.
const OFFLINE_SHOWN = 100;

function renderMembers() {
  const wrap = $("member-list");
  wrap.textContent = "";

  // members is keyed by sid — one per socket — so two tabs are two entries and
  // one person. Dedupe by userId, preferring the session that's in voice,
  // because that's the one whose mute and channel are worth showing.
  const online = new Map(); // userId -> live member
  for (const member of state.members.values()) {
    const key = member.userId || member.sid;
    const seen = online.get(key);
    if (!seen || (!seen.voice && member.voice)) online.set(key, member);
  }
  const live = [...online.values()].sort((a, b) => a.name.localeCompare(b.name));
  const offline = [...state.roster.values()]
    .filter((entry) => !online.has(entry.userId))
    .sort((a, b) => (b.at || 0) - (a.at || 0));

  wrap.appendChild(el("div", "member-group-head", `Online — ${live.length}`));
  for (const member of live) wrap.appendChild(memberRow(member));

  if (offline.length) {
    wrap.appendChild(el("div", "member-group-head", `Offline — ${offline.length}`));
    for (const entry of offline.slice(0, OFFLINE_SHOWN)) wrap.appendChild(memberRow(entry, true));
    if (offline.length > OFFLINE_SHOWN) {
      wrap.appendChild(el("div", "member-more", `+ ${offline.length - OFFLINE_SHOWN} more`));
    }
  }

  const count = $("member-count");
  const total = live.length + offline.length;
  count.textContent = String(total);
  count.title = `${live.length} of ${total} online`;
  count.classList.toggle("hidden", state.view !== "server" || !total);
}

// `person` is either a live member (has a sid) or a roster row (has only a
// userId). Anything that needs a socket is gated on the sid actually existing
// rather than on a faked one.
function memberRow(person, offline = false) {
  const row = el("div", "member-row" + (offline ? " offline" : ""));
  const av = el("div", "avatar", person.avatar);
  av.style.background = person.color;
  if (person.sid) {
    av.dataset.vsid = person.sid;
    if (voice.isSpeaking(person.sid === state.me?.sid ? "me" : person.sid)) av.classList.add("speaking");
  }
  row.appendChild(av);
  const col = el("div", "m-col");
  const name = el("div", "m-name", person.name);
  name.style.color = person.color;
  if (isOwnerOf(R(), person.userId)) {
    const crown = el("span", "owner-crown", "👑");
    crown.title = "Server owner";
    name.appendChild(crown);
  }
  col.appendChild(name);
  const sub = offline
    ? agoText(person.at)
    : person.voice
    ? `🔊 ${state.channels.find((c) => c.id === person.voice.chanId)?.name || "voice"}`
    : person.status || "";
  if (sub) col.appendChild(el("div", "m-status", sub));
  row.appendChild(col);
  const icons = el("span", "vu-icons");
  if (person.voice?.muted) icons.append("🔇");
  if (person.voice?.deafened) icons.append("🎧");
  row.appendChild(icons);
  row.onclick = (e) => {
    e.stopPropagation(); // otherwise the document handler closes it instantly
    openProfile(e.clientX - 300, e.clientY - 40, person);
  };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    memberMenu(e, person);
  };
  return row;
}

function renderMe() {
  const av = $("me-avatar");
  av.textContent = state.profile.avatar;
  av.style.background = state.profile.color;
  if (state.me) av.dataset.vsid = state.me.sid;
  av.classList.toggle("speaking", voice.isSpeaking("me"));
  $("me-name").textContent = state.profile.name;
  const pres = PRESENCE_META[effectivePresence()] || PRESENCE_META.online;
  $("me-sub").textContent = state.profile.status || (hub.me?.tag ? "@" + hub.me.tag : pres.label);
  $("me-presence").className = "presence-dot " + pres.dot;
  $("me-presence").title = pres.label;
}

let composerHint = ""; // what renderChatHeader last decided the box should say

// Until a conversation's socket has handed us its channels there is nowhere
// for a message to go, and sendCurrentMessage would silently drop it. Lock the
// composer instead, so the state is visible rather than quietly lossy. An
// upload in flight locks it for the same reason.
function syncComposer() {
  const busy = !!R()?.uploader?.busy();
  const waitFor = state.activeChan ? slowLeft(state.currentCode, state.activeChan) : 0;
  const ready = !!state.activeChan && state.view !== "home" && !busy && !waitFor;
  const box = $("input");
  box.disabled = !ready;
  box.classList.toggle("waiting", !ready);
  if (busy) box.placeholder = "Uploading…";
  else if (waitFor) box.placeholder = `🐌 Slowmode — ${waitFor}s`;
  else if (ready) box.placeholder = composerHint;
  else if (state.view !== "home") box.placeholder = "Connecting…";
}

function renderChatHeader() {
  const realm = R();
  // Both of these belong to a server channel; a DM can never want either.
  $("chan-crumb").classList.add("hidden");
  $("chan-incall").classList.add("hidden");
  if (state.view === "dm" && realm?.kind === "group" && realm.group) {
    const group = hub.groups.get(realm.group.id) || realm.group;
    $("chan-hash").textContent = group.icon || "👥";
    $("chan-name").textContent = groupTitle(group, hub.me?.uid);
    const online = group.members.filter((m) => m.online && m.presence !== "invisible").length;
    $("chan-topic").textContent = `${group.members.length} members · ${online} online`;
    composerHint = `Message ${groupTitle(group, hub.me?.uid)}`;
    syncComposer();
    return;
  }
  if (state.view === "dm" && state.dmPeer) {
    const f = hub.friends.get(state.dmPeer.uid) || state.dmPeer;
    $("chan-hash").textContent = f.avatar || "💬";
    $("chan-name").textContent = f.name;
    $("chan-topic").textContent = f.online && f.presence !== "invisible"
      ? f.status || PRESENCE_META[f.presence]?.label || "Online"
      : "Offline";
    composerHint = `Message ${f.name}`;
    syncComposer();
    return;
  }
  const c = state.channels.find((x) => x.id === state.activeChan);
  $("chan-hash").textContent = c?.type === "thread" ? "💬" : c?.type === "voice" ? "🔊" : "#";
  $("chan-name").textContent = c ? c.name : "";

  // The breadcrumb is the only way back out of a thread that doesn't involve
  // hunting for the parent in the sidebar.
  const crumb = $("chan-crumb");
  const parent = c?.type === "thread" ? state.channels.find((x) => x.id === c.parent) : null;
  crumb.classList.toggle("hidden", !parent);
  if (parent) {
    crumb.textContent = `from #${parent.name}`;
    crumb.title = `Back to #${parent.name}`;
    crumb.onclick = () => activateChannel(parent.id);
  }

  const inThisCall = c?.type === "voice" && state.voiceCode === state.currentCode && state.voiceChan === c.id;
  $("chan-incall").classList.toggle("hidden", !inThisCall);

  const notes = [];
  if (c?.topic) notes.push(c.topic);
  if (c?.slow) notes.push(`🐌 Slowmode: ${slowLabel(c.slow)}`);
  $("chan-topic").textContent = notes.join(" · ");
  composerHint = c ? `Message ${c.type === "text" ? "#" : ""}${c.name}` : "Pick a channel";
  syncComposer();
}

/* ----------------------------- messages pane ---------------------------- */

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

const GROUP_WINDOW = 5 * 60 * 1000; // consecutive posts inside this share a header

// The message array only ever grows — history prepends, live messages append,
// nothing removes — and every full render rebuilds the pane from all of it. A
// tab left open in a busy channel therefore gets permanently slower. Once you
// are at the live edge the head is off-screen anyway, so drop it; the slack
// keeps the trim (and the rebuild that performs it) to once per hundred
// messages instead of once per message.
const MSG_KEEP = 200;
const MSG_TRIM_AT = 300;

// What the pane currently has painted, so appendMessage can tell whether adding
// one node would land where a full pass would have put it.
let painted = { code: null, chanId: null, anchor: undefined, author: null, ts: 0, day: "" };

function trimToLiveEdge(realm, chanId) {
  const list = realm.messages.get(chanId);
  if (!list || list.length <= MSG_TRIM_AT) return;
  let cut = list.length - MSG_KEEP;
  // Never cut past the "new messages" line — it is the one thing on screen
  // someone is using to find their place.
  const anchor = realm.firstUnread.get(chanId);
  if (anchor !== undefined) {
    const at = list.findIndex((x) => x.id === anchor);
    if (at >= 0 && at < cut) cut = at;
  }
  if (cut <= 0) return;
  list.splice(0, cut);
  realm.noMoreHistory.delete(chanId); // there is a head to fetch again now
}

// `prepended` says content went in ABOVE the viewport, which is the only case
// where scrollTop has to move to keep the same words under the eye. Applying
// that delta to an append instead drags the view down by the height of the new
// message — 582px for a 4000-character one — and a tall composer is enough to
// push you out of `nearBottom` and into that branch without scrolling at all.
function renderMessages(scrollToBottom = false, realm = R(), prepended = false) {
  const pane = $("messages");
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  const prevHeight = pane.scrollHeight;
  const prevTop = pane.scrollTop;
  const chanId = realm?.activeChan ?? null;
  // Only while they're at the bottom: trimming under someone who has scrolled
  // up to read would pull the ground out from under them.
  if (realm && (scrollToBottom || nearBottom)) trimToLiveEdge(realm, chanId);
  pane.textContent = "";

  const list = realm?.messages.get(chanId) || NO_ARR;
  let lastAuthor = null;
  let lastTs = 0;
  let lastDay = "";
  let group = null;

  const firstUnread = realm?.firstUnread.get(chanId);
  let markedUnread = false;

  for (const msg of list) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) {
      pane.appendChild(el("div", "day-divider", fmtDay(msg.ts)));
      lastDay = day;
      lastAuthor = null;
    }
    // The red "new messages" line, exactly where you stopped reading.
    if (!markedUnread && firstUnread !== undefined && msg.id === firstUnread) {
      pane.appendChild(el("div", "unread-divider", "NEW MESSAGES"));
      markedUnread = true;
      lastAuthor = null;
    }
    const sameGroup = lastAuthor === msg.author.userId && msg.ts - lastTs < GROUP_WINDOW && !msg.replyTo;
    if (!sameGroup) {
      group = buildMsgGroup(msg, realm);
      pane.appendChild(group);
    }
    lastAuthor = msg.author.userId;
    lastTs = msg.ts;
    group.querySelector(".mg-msgs").appendChild(buildMsgNode(msg, realm));
  }

  painted = { code: realm?.code ?? null, chanId, anchor: firstUnread, author: lastAuthor, ts: lastTs, day: lastDay };

  if (scrollToBottom || nearBottom) pane.scrollTop = pane.scrollHeight;
  else if (prepended) pane.scrollTop = prevTop + (pane.scrollHeight - prevHeight);
  else pane.scrollTop = prevTop;
}

// `msg` and `msg-ack` are the events that arrive in bulk and both only ever add
// to the tail, so they get one new node instead of several hundred rebuilt.
// Anything a full pass would decide differently — a new day, an unread line
// that hasn't been drawn yet, a trim that's due — hands back false and lets it
// rebuild. Reads layout once at the top and writes once at the bottom.
function appendMessage(realm, msg) {
  if (painted.code !== realm.code || painted.chanId !== msg.chanId) return false;
  if (painted.anchor !== realm.firstUnread.get(msg.chanId)) return false;
  if (new Date(msg.ts).toDateString() !== painted.day) return false;

  const pane = $("messages");
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  if (nearBottom && (realm.messages.get(msg.chanId)?.length || 0) > MSG_TRIM_AT) return false;

  const sameGroup = painted.author === msg.author.userId && msg.ts - painted.ts < GROUP_WINDOW && !msg.replyTo;
  let slot = sameGroup ? pane.lastElementChild?.querySelector(":scope > .mg-body > .mg-msgs") : null;
  if (sameGroup && !slot) return false; // pane isn't shaped the way we think
  if (!slot) {
    const group = buildMsgGroup(msg, realm);
    pane.appendChild(group);
    slot = group.querySelector(".mg-msgs");
  }
  slot.appendChild(buildMsgNode(msg, realm));
  painted.author = msg.author.userId;
  painted.ts = msg.ts;
  if (nearBottom) pane.scrollTop = pane.scrollHeight;
  return true;
}

// An ack swaps the optimistic copy for the server's: same words, same place,
// one node different. Rebuilding the pane for that costs as much again as the
// send did.
function swapMsgNode(realm, oldId, msg) {
  if (painted.code !== realm.code || painted.chanId !== msg.chanId) return false;
  const node = $("messages").querySelector(`.msg[data-id="${CSS.escape(oldId)}"]`);
  if (!node) return false;
  node.replaceWith(buildMsgNode(msg, realm));
  return true;
}

// The avatar + name + timestamp header a run of messages hangs off.
function buildMsgGroup(msg, realm = R()) {
  const group = el("div", "msg-group");
  const openAuthor = (e) => {
    e.stopPropagation();
    const known = [...(realm?.members || NO_MAP).values()].find((mm) => mm.userId === msg.author.userId);
    openProfile(e.clientX + 12, e.clientY - 40, known || msg.author);
  };
  const av = el("div", "mg-avatar", msg.author.avatar);
  av.style.background = msg.author.color;
  av.title = "View profile";
  av.onclick = openAuthor;
  group.appendChild(av);
  const body = el("div", "mg-body");
  const head = el("div", "mg-head");
  const name = el("span", "mg-name", msg.author.name);
  name.style.color = msg.author.color;
  name.title = "View profile";
  name.style.cursor = "pointer";
  name.onclick = openAuthor;
  head.appendChild(name);
  head.appendChild(el("span", "mg-time", fmtTime(msg.ts)));
  body.appendChild(head);
  body.appendChild(el("div", "mg-msgs"));
  group.appendChild(body);
  return group;
}

function buildMsgNode(msg, realm = R()) {
  const node = el("div", "msg" + (msg.pending ? " pending" : "") + (mentionsMe(msg, realm) ? " pinged" : ""));
  node.dataset.id = msg.id;
  if (msg.pinned) node.classList.add("is-pinned");

  if (msg.replyTo) {
    const r = el("div", "msg-reply", dropHalfPairs(`↩ ${msg.replyTo.name}: ${msg.replyTo.content}`));
    r.onclick = () => {
      const target = document.querySelector(`.msg[data-id="${msg.replyTo.id}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.style.background = "rgba(88,101,242,.2)";
        setTimeout(() => (target.style.background = ""), 1200);
      }
    };
    node.appendChild(r);
  }

  if (realm?.editingId === msg.id) {
    const editor = document.createElement("textarea");
    editor.className = "edit-box";
    editor.value = msg.content;
    editor.rows = 2;
    editor.onkeydown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const v = editor.value.trim();
        if (v && v !== msg.content) wsSend({ type: "edit", chanId: msg.chanId, msgId: msg.id, content: v });
        state.editingId = null;
        renderMessages();
      } else if (e.key === "Escape") {
        state.editingId = null;
        renderMessages();
      }
    };
    node.appendChild(editor);
    setTimeout(() => editor.focus(), 0);
    return node;
  }

  // Polls render as their own widget; the reactions underneath ARE the votes.
  const poll = parsePoll(msg.content);
  if (poll) {
    node.appendChild(buildPollNode(msg, poll));
    if (!msg.pending) node.appendChild(msgActions(msg, realm));
    return node;
  }

  const code = realm?.code || null;
  const content = el("div", "msg-content" + (isOnlyEmoji(msg.content, code, emojiReg) ? " ce-big" : ""));
  content.innerHTML = renderMarkdown(msg.content, code, realm);
  content.querySelectorAll(".spoiler").forEach((s) => {
    s.onclick = () => s.classList.add("revealed");
  });
  if (state.settings.embeds) attachEmbeds(content, msg);
  if (msg.edited) {
    const tag = el("span", "msg-edited", " (edited)");
    content.appendChild(tag);
  }
  node.appendChild(content);

  // Link previews are a setting because they're a guess about what you wanted.
  // An attachment is something a person deliberately sent, so it always shows.
  const atts = renderAttachments(msg.attachments, {
    spoilerRevealed: revealedAtts,
    onOpen: (att) => openLightbox(att, msg.attachments),
  });
  if (atts) node.appendChild(atts);

  // A thread hangs off the message that started it, which is the only place
  // you'd think to look for it.
  if (msg.threadId) {
    const thread = (realm?.channels || NO_ARR).find((c) => c.id === msg.threadId);
    const chip = el("button", "thread-chip", `💬 ${thread?.name || msg.threadName || "Thread"}`);
    chip.title = "Open this thread";
    chip.onclick = () => activateChannel(msg.threadId);
    node.appendChild(chip);
  }

  if (msg.reactions) {
    const row = el("div", "msg-reactions");
    const me = realmUserId(realm);
    for (const [emoji, users] of Object.entries(msg.reactions)) {
      const btn = el("button", "reaction" + (users.includes(me) ? " mine" : ""));
      const face = reactionLabel(emoji, code, emojiReg);
      const span = el("span", "reaction-face");
      span.innerHTML = face.html;
      btn.append(span, el("span", "reaction-count", String(users.length)));
      btn.title = users.length + " reaction" + (users.length > 1 ? "s" : "");
      btn.onclick = () => wsSend({ type: "react", chanId: msg.chanId, msgId: msg.id, emoji });
      row.appendChild(btn);
    }
    node.appendChild(row);
  }

  if (!msg.pending) node.appendChild(msgActions(msg, realm));
  return node;
}

// The hover toolbar on a message.
function msgActions(msg, realm = R()) {
  {
    const actions = el("div", "msg-actions");
    for (const q of QUICK_REACTS.slice(0, 3)) {
      const b = el("button", "", q);
      b.title = "React " + q;
      b.onclick = () => wsSend({ type: "react", chanId: msg.chanId, msgId: msg.id, emoji: q });
      actions.appendChild(b);
    }
    const more = el("button", "", "➕");
    more.title = "More reactions";
    more.onclick = (e) => {
      e.stopPropagation();
      openEmojiPicker({ mode: "react", msg });
    };
    actions.appendChild(more);
    const reply = el("button", "", "↩");
    reply.title = "Reply";
    reply.onclick = () => setReply(msg);
    actions.appendChild(reply);
    // Threads only hang off real channels, and the message needs a real id for
    // the server to find it.
    if (chanTypeOf(msg.chanId) !== "thread") {
      const thread = el("button", "", "💬");
      thread.title = msg.threadId ? "Open this thread" : "Start a thread";
      thread.onclick = () => {
        if (msg.threadId) return activateChannel(msg.threadId);
        promptModal("Name this thread", clip(msg.content, 40), (v) =>
          wsSend({ type: "create-thread", chanId: msg.chanId, msgId: msg.id, name: v })
        );
      };
      actions.appendChild(thread);
    }
    const save = el("button", "", "🔖");
    save.title = "Save this message";
    save.onclick = () => saveMessage(msg);
    actions.appendChild(save);
    const pin = el("button", "", "📌");
    pin.title = msg.pinned ? "Unpin" : "Pin";
    pin.onclick = () => wsSend({ type: msg.pinned ? "unpin" : "pin", chanId: msg.chanId, msgId: msg.id });
    actions.appendChild(pin);
    const copy = el("button", "", "📋");
    copy.title = "Copy text";
    copy.onclick = () => copyText(msg.content, "Message copied");
    actions.appendChild(copy);
    if (msg.author.userId === realmUserId(realm)) {
      actions.appendChild(el("span", "sep"));
      const edit = el("button", "", "✏");
      edit.title = "Edit";
      edit.onclick = () => {
        state.editingId = msg.id;
        renderMessages();
      };
      actions.appendChild(edit);
      const del = el("button", "", "🗑");
      del.title = "Delete";
      del.onclick = () =>
        confirmModal("Delete message?", "It'll be gone for everyone. Forever. Wow.", () =>
          wsSend({ type: "delete", chanId: msg.chanId, msgId: msg.id })
        );
      actions.appendChild(del);
    }
    return actions;
  }
}

/* -------------------------------- embeds --------------------------------- */
// Turns bare links into something worth looking at. Only the URL the person
// actually posted is loaded — nothing is fetched or resolved behind the
// scenes, so no link ever gets pinged just because it was mentioned.

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)(\?[^\s]*)?$/i;
const YT_RE = /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,20})/i;

function hrefPath(href) {
  try {
    return new URL(href, location.origin).pathname;
  } catch {
    return href;
  }
}

function attachEmbeds(content, msg) {
  const links = [...content.querySelectorAll("a[href]")].slice(0, 4);
  const seen = new Set();
  // Someone pasting the link to a file they attached shouldn't get the picture
  // twice — renderAttachments is already showing that key.
  const ours = new Set((msg?.attachments || []).map((a) => a.url));
  for (const a of links) {
    const href = a.getAttribute("href") || "";
    if (seen.has(href)) continue;
    seen.add(href);
    if (ours.has(href) || ours.has(hrefPath(href))) continue;

    if (IMAGE_RE.test(href)) {
      const wrap = el("div", "embed");
      const img = document.createElement("img");
      img.className = "embed-img";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.src = href;
      img.onerror = () => wrap.remove(); // dead or hotlink-blocked: say nothing
      img.onclick = () => window.open(href, "_blank", "noopener");
      wrap.appendChild(img);
      content.appendChild(wrap);
      continue;
    }

    const yt = href.match(YT_RE);
    if (yt) {
      const card = el("a", "embed embed-yt");
      card.href = href;
      card.target = "_blank";
      card.rel = "noreferrer noopener";
      const thumb = document.createElement("img");
      thumb.className = "embed-thumb";
      thumb.loading = "lazy";
      thumb.referrerPolicy = "no-referrer";
      thumb.alt = "";
      thumb.src = `https://i.ytimg.com/vi/${yt[1]}/mqdefault.jpg`;
      thumb.onerror = () => card.remove();
      card.appendChild(thumb);
      const play = el("span", "embed-play", "▶");
      card.appendChild(play);
      card.appendChild(el("span", "embed-label", "YouTube"));
      content.appendChild(card);
    }
  }
}

function renderTyping() {
  const now = Date.now();
  const names = [];
  state.typing.forEach((t, sid) => {
    if (t.until < now || t.chanId !== state.activeChan) state.typing.delete(sid);
    else names.push(t.name);
  });
  const bar = $("typing-bar");
  if (!names.length) {
    bar.innerHTML = "&nbsp;";
  } else if (names.length === 1) {
    bar.textContent = `${names[0]} is typing…`;
  } else if (names.length <= 3) {
    bar.textContent = `${names.join(", ")} are typing…`;
  } else {
    bar.textContent = "Several people are typing…";
  }
}
setInterval(renderTyping, 1500);

/* ------------------------------- channels ------------------------------- */

// One history request per channel at a time (the scroll handler fires every
// frame). The timeout releases the lock if the server ever drops the request,
// so a channel can't get permanently stuck without history.
function requestHistory(chanId, before) {
  const realm = R();
  if (realm) requestHistoryIn(realm, chanId, before);
}

function requestHistoryIn(realm, chanId, before) {
  if (realm.historyPending.has(chanId)) return;
  realm.historyPending.add(chanId);
  setTimeout(() => realm.historyPending.delete(chanId), 8000);
  const msg = { type: "history", chanId };
  if (before) msg.before = before;
  realm.send(msg);
}

function activateChannel(chanId) {
  const realm = R();
  if (!realm) return;
  // The "new messages" line survives while you're reading the channel, and
  // clears once you leave it — otherwise it vanishes before you can see it.
  if (realm.activeChan && realm.activeChan !== chanId) {
    realm.firstUnread.delete(realm.activeChan);
  }
  realm.activeChan = chanId;
  realm.unread.delete(chanId);
  if (!realm.unread.size) realm.mentions = 0;
  renderServerRail();
  if (realm.kind === "dm" && realm.peer) hub.markDmRead(realm.peer.uid);
  if (realm.kind === "group" && realm.group) hub.markDmRead(realm.group.id);
  updateTitle();
  clearReply();
  state.editingId = null;
  renderChannels();
  renderChatHeader();
  syncComposer();
  renderMessages(true);
  // Live messages may have created the cache entry — that is NOT history.
  if (!state.historyLoaded.has(chanId)) requestHistory(chanId);
  $("input").focus();
}

/* ------------------------------ reply state ------------------------------ */

function setReply(msg) {
  state.replyTo = { id: msg.id, name: msg.author.name, content: clip(msg.content, 120) };
  $("reply-label").textContent = `Replying to ${msg.author.name}`;
  $("reply-bar").classList.remove("hidden");
  $("input").focus();
}
function clearReply() {
  state.replyTo = null;
  $("reply-bar").classList.add("hidden");
}

/* =============================== voice ui =============================== */

// Joins in whichever realm you're currently viewing.
function joinVoice(chanId) {
  const realm = R();
  if (realm) joinVoiceIn(realm, chanId);
}

async function joinVoiceIn(realm, chanId) {
  if (state.voiceCode === realm.code && state.voiceChan === chanId) return;
  if (state.voiceCode) leaveVoice({ silent: true });
  try {
    await voice.join(chanId);
  } catch {
    return;
  }
  state.voiceCode = realm.code;
  state.voiceChan = chanId;
  realm.send({ type: "voice-join", chanId, muted: voice.muted, deafened: voice.deafened });
  renderVoicePanel();
  renderChannels();
  renderChatHeader();
  renderServerRail();
  startQualityMeter(voiceUiHooks);
}

function leaveVoice({ silent } = {}) {
  stopQualityMeter();
  if (!state.voiceCode) return;
  const realm = voiceRealm();
  state.voiceCode = null;
  state.voiceChan = null;
  voice.leave({ silent });
  realm?.send({ type: "voice-leave" });
  $("voice-status").classList.add("hidden");
  $("btn-share").classList.remove("on");
  $("btn-camera").classList.remove("on");
  $("btn-call").classList.remove("on");
  clearShareStage();
  renderChannels();
  renderMembers();
  renderChatHeader();
  renderServerRail();
}

// The call panel is global: it shows where the call is even when you've
// wandered off to another server, and clicking it takes you back.
function renderVoicePanel() {
  const realm = voiceRealm();
  if (!realm || !state.voiceChan) {
    $("voice-status").classList.add("hidden");
    return;
  }
  const chan = realm.channels.find((c) => c.id === state.voiceChan);
  const where =
    realm.kind === "dm"
      ? `Call with ${realm.peer?.name || "a friend"}`
      : `${chan?.name || "voice"} / ${realm.meta?.name || ""}`;
  const label = $("vs-channel");
  label.textContent = where;
  label.title = "Jump to the call";
  label.onclick = () => switchToRealm(realm.code);
  const elsewhere = realm.code !== state.activeCode;
  $("vs-quality").textContent = elsewhere ? "Voice Connected ↗" : "Voice Connected";
  $("voice-status").classList.remove("hidden");
  $("btn-call").classList.toggle("on", realm.code === state.activeCode);
}

function addShareTile(key, stream, label, mirror = false) {
  removeShareTile(key);
  const stage = $("share-stage");
  const tile = el("div", "share-tile" + (mirror ? " mirrored" : ""));
  tile.dataset.share = key;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (key === "me") video.muted = true;
  video.srcObject = stream;
  tile.appendChild(video);
  tile.appendChild(el("div", "share-label", label));
  // Click any tile to blow it up to fill the stage.
  tile.onclick = () => {
    const wasBig = tile.classList.contains("focused");
    stage.querySelectorAll(".share-tile").forEach((t) => t.classList.remove("focused"));
    stage.classList.toggle("has-focus", !wasBig);
    if (!wasBig) tile.classList.add("focused");
  };
  stage.appendChild(tile);
  stage.classList.remove("hidden");
}
function removeShareTile(key) {
  const tile = document.querySelector(`.share-tile[data-share="${key}"]`);
  if (tile) {
    const video = tile.querySelector("video");
    if (video) video.srcObject = null;
    tile.remove();
  }
  if (!$("share-stage").childNodes.length) $("share-stage").classList.add("hidden");
}
function clearShareStage() {
  const stage = $("share-stage");
  stage.querySelectorAll("video").forEach((v) => (v.srcObject = null));
  stage.textContent = "";
  stage.classList.add("hidden");
}

/* ================================ menus ================================= */

function ctxMenu(x, y, items) {
  const menu = $("ctx-menu");
  menu.textContent = "";
  for (const item of items) {
    if (item.custom) {
      menu.appendChild(item.custom);
      continue;
    }
    const b = el("button", item.danger ? "danger" : "", item.label);
    b.onclick = () => {
      hideCtxMenu();
      item.onClick();
    };
    menu.appendChild(b);
  }
  menu.classList.remove("hidden");
  menu.style.left = Math.min(x, window.innerWidth - 220) + "px";
  menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 8) + "px";
}
function hideCtxMenu() {
  $("ctx-menu").classList.add("hidden");
}
document.addEventListener("click", (e) => {
  if (!$("ctx-menu").contains(e.target)) hideCtxMenu();
  if (!$("server-menu").contains(e.target) && !$("server-header").contains(e.target)) {
    $("server-menu").classList.add("hidden");
  }
  if (!$("emoji-picker").contains(e.target) && e.target.id !== "btn-emoji") {
    $("emoji-picker").classList.add("hidden");
  }
});

/* ================================ modals ================================= */

function showModal(id) {
  $("modal-backdrop").classList.remove("hidden");
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  $(id).classList.remove("hidden");
}
function closeModals() {
  $("modal-backdrop").classList.add("hidden");
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
}
$("modal-backdrop").addEventListener("click", (e) => {
  if (e.target !== $("modal-backdrop")) return;
  if (!$("onboard-modal").classList.contains("hidden")) return; // profile is required
  if (!$("join-modal").classList.contains("hidden") && !state.servers.length) return;
  closeModals();
});
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModals));

function confirmModal(title, text, onYes) {
  $("confirm-title").textContent = title;
  $("confirm-text").textContent = text;
  showModal("confirm-modal");
  $("confirm-yes").onclick = () => {
    closeModals();
    onYes();
  };
  $("confirm-no").onclick = closeModals;
}

// Empty normally means "changed your mind", so it's swallowed. `allowEmpty` is
// for the fields where clearing the box is itself the edit.
function promptModal(title, value, onSave, { allowEmpty } = {}) {
  $("prompt-title").textContent = title;
  const input = $("prompt-input");
  input.value = value;
  showModal("prompt-modal");
  setTimeout(() => input.focus(), 0);
  const save = () => {
    const v = input.value.trim();
    closeModals();
    if (v || allowEmpty) onSave(v);
  };
  $("prompt-yes").onclick = save;
  input.onkeydown = (e) => {
    if (e.key === "Enter") save();
  };
  $("prompt-no").onclick = closeModals;
}

/* ------------------------------ onboarding ------------------------------ */

let obAvatar = AVATARS[0];
let obColor = COLORS[0];

function pickerRow(container, options, selected, onPick, isColor = false) {
  container.textContent = "";
  for (const opt of options) {
    const b = document.createElement("button");
    b.type = "button";
    if (isColor) {
      b.style.background = opt;
      b.className = "color-pick" + (opt === selected ? " selected" : "");
    } else {
      b.textContent = opt;
      b.className = opt === selected ? "selected" : "";
    }
    b.onclick = () => {
      onPick(opt);
      pickerRow(container, options, opt, onPick, isColor);
    };
    container.appendChild(b);
  }
}

function openOnboard() {
  hideSplash(); // nothing to load for a first-time visitor
  showModal("onboard-modal");
  pickerRow($("ob-avatars"), AVATARS, obAvatar, (v) => (obAvatar = v));
  pickerRow($("ob-colors"), COLORS, obColor, (v) => (obColor = v), true);
  setTimeout(() => $("ob-name").focus(), 0);
}

$("ob-done").onclick = finishOnboard;
$("ob-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") finishOnboard();
});
function finishOnboard() {
  const name = $("ob-name").value.trim();
  if (!name) {
    toast("You need a name! Any name. Even 'xX_Slayer_Xx'.", true);
    return;
  }
  state.profile = {
    userId: crypto.randomUUID(),
    name,
    color: obColor,
    avatar: obAvatar,
    status: "",
  };
  store.set("profile", state.profile);
  renderMe();
  closeModals();
  afterProfileReady();
}

/* ---------------------------- join / create ----------------------------- */

let jmIcon = SERVER_ICONS[0];

function openJoinModal() {
  showModal("join-modal");
  pickerRow($("jm-icons"), SERVER_ICONS, jmIcon, (v) => (jmIcon = v));
}

$("jm-create").onclick = async () => {
  const name = $("jm-create-name").value.trim() || `${state.profile.name}'s Hangout`;
  try {
    const res = await fetch("/api/new-code");
    const { code } = await res.json();
    closeModals();
    // Creating a server means going to it, even if we were on the Friends view.
    const realm = openRealm(code, "guild", { kind: "create", code, name, icon: jmIcon });
    realm.meta = { name, icon: jmIcon };
    state.activeCode = code;
    state.view = "server";
    renderAll();
  } catch {
    toast("Couldn't reach the server. Are you online?", true);
  }
};

$("jm-join").onclick = () => {
  const code = $("jm-code").value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) {
    toast("Invite codes look like XK4PQ2M9.", true);
    return;
  }
  closeModals();
  openRealm(code, "guild", { kind: "join", code });
  state.activeCode = code;
  state.view = "server";
  renderAll();
};
$("jm-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("jm-join").click();
});

$("add-server-btn").onclick = openJoinModal;

function confirmLeaveServer(s) {
  confirmModal(`Leave ${s.name}?`, "You can rejoin any time with the invite code.", () => {
    // Say so before the socket goes, or you linger in everyone else's list as
    // a permanently offline ghost.
    state.realms.get(s.code)?.send({ type: "leave-server" });
    state.servers = state.servers.filter((x) => x.code !== s.code);
    store.set("servers", state.servers);
    const wasActive = state.activeCode === s.code;
    closeRealm(s.code);
    if (wasActive) {
      state.activeCode = null;
      if (state.servers.length) {
        goServer(state.servers[0].code);
      } else {
        state.view = "home";
        renderAll();
        renderFriendsView();
        openJoinModal();
      }
    }
    renderServerRail();
  });
}

/* -------------------------------- invite -------------------------------- */

function openInviteModal() {
  const link = `${location.origin}/?join=${state.currentCode}`;
  $("invite-link").textContent = link;
  $("invite-code").textContent = state.currentCode;
  showModal("invite-modal");
  $("invite-copy").onclick = () => copyText(link, "Invite link copied — go paste it at your friends!");
}
function copyText(text, note) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast(note))
    .catch(() => toast("Couldn't copy — select it manually.", true));
}
$("btn-invite").onclick = openInviteModal;

/* ----------------------------- gremlin mode ------------------------------ */

function openGremlinModal(preselectSid) {
  const others = [...state.members.values()].filter((m) => m.sid !== state.me?.sid);
  if (!others.length) {
    toast("Nobody here to troll yet. Invite some victims first.", true);
    return;
  }
  showModal("gremlin-modal");

  const select = $("gm-target");
  select.textContent = "";
  const all = el("option", "", `☠️ EVERYONE (${others.length})`);
  all.value = "*";
  select.appendChild(all);
  for (const m of others) {
    const o = el("option", "", `${m.avatar} ${m.name}`);
    o.value = m.sid;
    select.appendChild(o);
  }
  if (preselectSid && others.some((m) => m.sid === preselectSid)) select.value = preselectSid;

  const grid = $("gm-pranks");
  grid.textContent = "";
  for (const p of PRANKS) {
    const card = el("button", "gm-card");
    card.type = "button";
    card.appendChild(el("span", "gm-emoji", p.emoji));
    card.appendChild(el("span", "gm-label", p.label));
    card.appendChild(el("span", "gm-blurb", p.blurb));
    card.onclick = () => {
      wsSend({ type: "prank", to: select.value, kind: p.kind });
      closeModals();
    };
    grid.appendChild(card);
  }
}
$("btn-gremlin").onclick = () => openGremlinModal();

/* ------------------------------- settings ------------------------------- */

function openSettings() {
  showModal("settings-modal");
  $("set-name").value = state.profile.name;
  $("set-status").value = state.profile.status || "";
  pickerRow($("set-avatars"), AVATARS, state.profile.avatar, (v) => (state.profile.avatar = v));
  pickerRow($("set-colors"), COLORS, state.profile.color, (v) => (state.profile.color = v), true);
  $("set-ptt").checked = state.settings.ptt;
  $("ptt-key-row").classList.toggle("hidden", !state.settings.ptt);
  $("set-ptt-key").textContent = state.settings.pttKey;
  $("set-sounds").checked = state.settings.sounds;
  $("set-notifs").checked = state.settings.notifs && typeof Notification !== "undefined" && Notification.permission === "granted";
  $("set-gremlin").checked = state.settings.gremlin;
  $("set-mascot").checked = state.settings.mascot;
  $("set-board").checked = state.settings.board;
  $("set-embeds").checked = state.settings.embeds !== false;
  $("set-tts").checked = !!state.settings.tts;
  $("set-autoidle").checked = state.settings.autoIdle !== false;
  $("set-theme").value = state.settings.theme || "midnight";
  $("set-turbo").checked = !!state.settings.turbo;
  renderLevel();
  $("set-tag").value = hub.me?.tag || state.account?.tag || "";
  $("set-presence").value = state.settings.presence || "online";
  for (const fn of settingsOpenHooks) fn();

  const fxSelect = $("set-fx");
  fxSelect.textContent = "";
  for (const fx of VOICE_FX) {
    const option = el("option", "", `${fx.emoji} ${fx.label}`);
    option.value = fx.id;
    if (fx.id === state.settings.fx) option.selected = true;
    fxSelect.appendChild(option);
  }
  $("set-fx-blurb").textContent = FX_BY_ID.get(state.settings.fx)?.blurb || "Custom pitch";
  $("set-fx-pitch").value = state.settings.fxPitch;
  $("set-fx-label").textContent = fmtSemis(state.settings.fxPitch);
  $("set-volume").value = state.settings.volume;
  $("set-vol-label").textContent = state.settings.volume + "%";
  renderEmojiSettings();
  populateMics();
}

/* ----------------------------- server emoji ------------------------------ */

let emojiFile = null; // the picked image, held until it has a name to go with it

function renderEmojiSettings() {
  const section = $("emoji-section");
  const inServer = state.view === "server" && !!state.currentCode;
  section.classList.toggle("hidden", !inServer);
  if (!inServer) return;
  const list = $("emoji-list");
  list.textContent = "";
  const mine = emojiReg.forCode(state.currentCode);
  if (!mine.length) {
    list.appendChild(el("div", "emoji-empty", "No emoji here yet. Add one — 256 KB, a–z 0–9 _ for the name."));
    return;
  }
  for (const e of mine) {
    const row = el("div", "emoji-row");
    const img = el("img", "emoji-row-img");
    img.src = e.url;
    img.alt = `:${e.name}:`;
    img.loading = "lazy";
    row.appendChild(img);
    row.appendChild(el("span", "emoji-row-name", `:${e.name}:`));
    const drop = el("button", "icon-btn", "✕");
    drop.title = "Remove";
    drop.onclick = () =>
      confirmModal(`Remove :${e.name}:?`, "Messages that used it go back to showing the plain text.", () =>
        wsSend({ type: "emoji-remove", name: e.name })
      );
    row.appendChild(drop);
    list.appendChild(row);
  }
}

$("emoji-pick").onclick = () => $("emoji-picker-file").click();
$("emoji-picker-file").onchange = (e) => {
  emojiFile = e.target.files?.[0] || null;
  e.target.value = "";
  if (emojiFile && emojiFile.size > EMOJI_MAX_BYTES) {
    toast("Emoji cap out at 256 KB. Shrink it first.", true);
    emojiFile = null;
  }
  $("emoji-file-name").textContent = emojiFile ? emojiFile.name : "No image picked";
};
$("emoji-add").onclick = async () => {
  const name = $("emoji-name").value.trim().toLowerCase();
  if (!emojiFile) {
    toast("Pick an image first.", true);
    return;
  }
  // Checked here as well as on the server, so a typo costs nothing.
  if (!nameOk(name)) {
    toast("Emoji names are 2–20 characters of a–z, 0–9 and _.", true);
    return;
  }
  const key = await uploadAsset(emojiFile);
  if (!key) return;
  wsSend({ type: "emoji-add", name, key });
  emojiFile = null;
  $("emoji-name").value = "";
  $("emoji-file-name").textContent = "No image picked";
};

async function populateMics() {
  const sel = $("set-mic");
  sel.textContent = "";
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    const def = el("option", "", "Default microphone");
    def.value = "";
    sel.appendChild(def);
    for (const m of mics) {
      const o = el("option", "", m.label || `Microphone ${sel.length}`);
      o.value = m.deviceId;
      if (m.deviceId === state.settings.micId) o.selected = true;
      sel.appendChild(o);
    }
  } catch {
    sel.appendChild(el("option", "", "Default microphone"));
  }
}

$("btn-settings").onclick = openSettings;
$("set-done").onclick = () => {
  state.profile.name = $("set-name").value.trim() || state.profile.name;
  state.profile.status = $("set-status").value.trim();
  store.set("profile", state.profile);
  const micChanged = state.settings.micId !== $("set-mic").value;
  state.settings.micId = $("set-mic").value;
  store.set("settings", state.settings);
  renderMe();
  pushProfile();
  if (micChanged) voice.setMicDevice();
  closeModals();
};
$("set-tag-save").onclick = () => {
  const tag = $("set-tag").value.trim().replace(/^@/, "").toLowerCase();
  if (tag) hub.setTag(tag);
};
$("set-presence").onchange = (e) => {
  state.settings.presence = e.target.value;
  store.set("settings", state.settings);
  renderMe();
  hub.pushProfile();
};
$("set-board").onchange = (e) => {
  state.settings.board = e.target.checked;
  store.set("settings", state.settings);
};
$("set-embeds").onchange = (e) => {
  state.settings.embeds = e.target.checked;
  store.set("settings", state.settings);
  renderMessages();
};
$("set-tts").onchange = (e) => {
  state.settings.tts = e.target.checked;
  store.set("settings", state.settings);
  if (e.target.checked) {
    if (typeof speechSynthesis === "undefined") {
      toast("This browser can't do speech synthesis.", true);
      e.target.checked = false;
      state.settings.tts = false;
      store.set("settings", state.settings);
      return;
    }
    speakMessage({ author: { name: "Concord" }, content: "Reading messages aloud." });
  } else if (typeof speechSynthesis !== "undefined") {
    speechSynthesis.cancel();
  }
};
$("set-autoidle").onchange = (e) => {
  state.settings.autoIdle = e.target.checked;
  store.set("settings", state.settings);
  if (!e.target.checked) noteActivity();
};

function setTheme(id) {
  const applied = applyTheme(id);
  state.settings.theme = applied;
  const seen = new Set(state.settings.seenThemes || []);
  seen.add(applied);
  state.settings.seenThemes = [...seen];
  store.set("settings", state.settings);
  const meta = THEMES.find((t) => t.id === applied);
  if (meta) toast(`${meta.emoji} Theme: ${meta.label}`);
  if (seen.size >= THEMES.length) unlock("themed");
  const select = $("set-theme");
  if (select) select.value = applied;
}

$("set-theme").onchange = (e) => setTheme(e.target.value);

$("set-turbo").onchange = (e) => {
  state.settings.turbo = e.target.checked;
  store.set("settings", state.settings);
  applyTurbo(e.target.checked);
  if (e.target.checked) {
    unlock("turbo");
    confetti(80);
    toast("⚡ TURBO MODE. There is no off-switch. (There is, it's right there.)");
  }
};
$("set-ptt").onchange = (e) => {
  state.settings.ptt = e.target.checked;
  store.set("settings", state.settings);
  $("ptt-key-row").classList.toggle("hidden", !state.settings.ptt);
  voice.pttChanged();
};
$("set-sounds").onchange = (e) => {
  state.settings.sounds = e.target.checked;
  store.set("settings", state.settings);
};
$("set-gremlin").onchange = (e) => {
  state.settings.gremlin = e.target.checked;
  store.set("settings", state.settings);
};
function launchMascot() {
  startMascot({
    sounds: () => state.settings.sounds,
    hits: state.settings.gorbHits,
    onHits(n) {
      state.settings.gorbHits = n;
      store.set("settings", state.settings);
      if (n >= 5) {
        toast("💤 Gorb is out cold. Revive him in Settings if you feel bad.");
        unlock("gorb-menace");
      }
    },
    onSquirt(on) {
      $("btn-squirt").classList.toggle("on", on);
    },
  });
}

$("btn-squirt").onclick = () => {
  if (!state.settings.mascot) {
    toast("Gorb is switched off in Settings — nothing to spray.", true);
    return;
  }
  const armed = setSquirt(!$("btn-squirt").classList.contains("on"));
  $("btn-squirt").classList.toggle("on", armed);
  if (armed) {
    toast(mascotDown() ? "💦 Squirt gun out. He's already down." : "💦 Squirt gun out. Click to spray. Esc to stop.");
  }
};

$("set-revive").onclick = () => {
  const wasDown = mascotDown();
  reviveMascot();
  toast("Gorb lives.");
  if (wasDown) unlock("gorb-friend");
};

const fmtSemis = (n) => (n > 0 ? `+${n}` : String(n));

// Applies live — mid-sentence, even. The rack is rebuilt behind the same
// outgoing track, so nothing renegotiates and nobody hears a gap.
function applyVoiceFx(id, pitch) {
  const preset = FX_BY_ID.get(id);
  const spec = preset ? preset.spec : {};
  const semis = typeof pitch === "number" ? pitch : spec.semis || 0;
  state.settings.fx = id;
  state.settings.fxPitch = semis;
  store.set("settings", state.settings);
  voice.setVoice(spec, semis);
  const changed = id !== "off" || semis !== 0;
  if (changed) unlock("voice-crack");
  if (id === "freds") unlock("asmr");
  if (preset) {
    const tried = new Set(state.settings.triedVoices || []);
    tried.add(id);
    state.settings.triedVoices = [...tried];
    store.set("settings", state.settings);
    if (tried.size >= VOICE_FX.length) unlock("full-rack");
  }
  $("btn-fx").classList.toggle("on", changed);
  $("btn-fx").title = `Voice changer: ${preset ? preset.label : fmtSemis(semis) + " semitones"}`;
  const blurb = $("set-fx-blurb");
  if (blurb) blurb.textContent = preset ? preset.blurb : "Custom pitch";
}

$("set-fx").onchange = (e) => {
  const preset = FX_BY_ID.get(e.target.value) || VOICE_FX[0];
  const semis = preset.spec.semis || 0;
  applyVoiceFx(preset.id, semis);
  $("set-fx-pitch").value = semis;
  $("set-fx-label").textContent = fmtSemis(semis);
};
// The slider nudges pitch while keeping the preset's character.
$("set-fx-pitch").oninput = (e) => {
  const pitch = +e.target.value;
  applyVoiceFx(state.settings.fx || "off", pitch);
  $("set-fx-label").textContent = fmtSemis(pitch);
};

// Quick cycle from the voice panel, for mid-call bits.
$("btn-fx").onclick = () => {
  const i = VOICE_FX.findIndex((f) => f.id === state.settings.fx);
  const next = VOICE_FX[(i + 1) % VOICE_FX.length];
  applyVoiceFx(next.id, next.spec.semis || 0);
  toast(`${next.emoji} Voice: ${next.label} — ${next.blurb}`);
};

$("set-mascot").onchange = (e) => {
  state.settings.mascot = e.target.checked;
  store.set("settings", state.settings);
  if (state.settings.mascot) launchMascot();
  else stopMascot();
};
$("set-notifs").onchange = async (e) => {
  if (e.target.checked) {
    if (typeof Notification === "undefined") {
      toast("This browser doesn't support notifications.", true);
      e.target.checked = false;
      return;
    }
    let perm = Notification.permission;
    if (perm !== "granted") perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications blocked — allow them in your browser settings.", true);
      e.target.checked = false;
      return;
    }
    state.settings.notifs = true;
    store.set("settings", state.settings);
    // Prove it works, so nobody has to wonder whether it's on.
    try {
      new Notification("Concord notifications are on 🔔", {
        body: "You'll get one of these for mentions and DMs.",
        icon: "/icon-192.png",
        tag: "concord-test",
      });
    } catch {}
    voice.playCue("mention");
    return;
  }
  state.settings.notifs = false;
  store.set("settings", state.settings);
};
$("set-volume").oninput = (e) => {
  state.settings.volume = +e.target.value;
  $("set-vol-label").textContent = state.settings.volume + "%";
  store.set("settings", state.settings);
  voice.volumeChanged();
};
$("set-ptt-key").onclick = () => {
  $("set-ptt-key").textContent = "Press a key…";
  const capture = (e) => {
    e.preventDefault();
    state.settings.pttKey = e.code;
    store.set("settings", state.settings);
    $("set-ptt-key").textContent = e.code;
    window.removeEventListener("keydown", capture, true);
  };
  window.addEventListener("keydown", capture, true);
};

/* ------------------------- server header / menu -------------------------- */

$("server-header").onclick = () => {
  $("server-bans").classList.toggle("hidden", !iAmOwner());
  $("server-menu").classList.toggle("hidden");
};
$("server-menu").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    $("server-menu").classList.add("hidden");
    const act = b.dataset.act;
    if (act === "invite") openInviteModal();
    if (act === "bans") wsSend({ type: "bans" }); // the reply opens the modal

    if (act === "leave") {
      const s = state.servers.find((x) => x.code === state.currentCode);
      if (s) confirmLeaveServer(s);
    }
    if (act === "rename") {
      promptModal("Server name", state.meta?.name || "", (v) => wsSend({ type: "update-server", name: v }));
    }
  };
});

/* ------------------------------- channels + ------------------------------ */

$("add-text-chan").onclick = () =>
  promptModal("New text channel name", "", (v) => wsSend({ type: "create-channel", name: v, chanType: "text" }));
$("add-voice-chan").onclick = () =>
  promptModal("New voice channel name", "", (v) => wsSend({ type: "create-channel", name: v, chanType: "voice" }));

/* ------------------------------- composer -------------------------------- */

const input = $("input");
function autoGrow(node) {
  node.style.height = "auto";
  node.style.height = Math.min(node.scrollHeight, 200) + "px";
}

// Only appears when you're actually near the 4000-character wall.
function updateCharCount() {
  const left = 4000 - input.value.length;
  const counter = $("char-count");
  counter.classList.toggle("hidden", left > 400);
  counter.classList.toggle("danger", left < 100);
  counter.textContent = String(left);
}
input.addEventListener("input", () => {
  autoGrow(input);
  updateAutocomplete();
  updateCharCount();
  const now = Date.now();
  if (input.value && now - state.lastTypingSent > 4000 && state.activeChan) {
    state.lastTypingSent = now;
    wsSend({ type: "typing", chanId: state.activeChan });
  }
});
input.addEventListener("blur", () => setTimeout(hideAutocomplete, 120));
input.addEventListener("keydown", (e) => {
  // The autocomplete popup owns the arrows, Tab, Enter and Escape while open.
  const ac = state.autocomplete;
  if (ac) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      ac.index = (ac.index + 1) % ac.items.length;
      return renderAutocomplete();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      ac.index = (ac.index - 1 + ac.items.length) % ac.items.length;
      return renderAutocomplete();
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      return applyAutocomplete();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      return hideAutocomplete();
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  } else if (e.key === "Escape") {
    clearReply();
  } else if (e.key === "ArrowUp" && !input.value) {
    // Up-arrow edits your last message, like the real thing.
    const list = state.messages.get(state.activeChan) || [];
    const own = [...list].reverse().find((x) => x.author.userId === myUserId() && !x.pending);
    if (own) {
      e.preventDefault();
      state.editingId = own.id;
      renderMessages();
    }
  }
});
$("reply-cancel").onclick = clearReply;

/* ------------------------------ attachments ------------------------------ */
// Three ways in — the 📎 button, a drop anywhere over the chat pane, and a
// paste — all landing in the active realm's uploader. The tray on screen is
// always that realm's, so switching servers swaps trays rather than losing one.

// Thumbnails outlive a repaint, so their object URLs are cached per staged
// item and revoked only once the item itself is gone.
const trayThumbs = new Map(); // item id -> object URL

function addFiles(files) {
  const realm = R();
  if (!realm || !files?.length) return;
  if (!realm.activeChan) {
    toast("Pick a channel first.", true);
    return;
  }
  realm.uploader.add(files);
  renderTray();
}

// Emoji and soundboard clips go up through the same ticket handshake as an
// attachment, so they borrow the realm's uploader — it's the thing listening on
// the socket the tickets come back on. The item is taken back out of the tray
// afterwards, because it was never going to be part of a message.
async function uploadAsset(file) {
  const realm = R();
  if (!realm) return null;
  const [item] = realm.uploader.add([file]);
  if (!item) return null;
  realm.flushing = true;
  renderTray();
  let key = null;
  try {
    const done = await realm.uploader.flush();
    key = done.find((d) => d.name === item.name && d.size === item.size)?.key || null;
  } catch {
    // the uploader has already said what went wrong
  }
  realm.flushing = false;
  realm.uploader.remove(item.id);
  renderTray();
  if (!key) toast("That upload didn't land. Give it another go.", true);
  return key;
}

function renderTray() {
  const tray = $("att-tray");
  const uploader = R()?.uploader;
  const items = uploader ? uploader.items() : [];
  const alive = new Set(items.map((it) => it.id));
  for (const [id, url] of trayThumbs) {
    if (alive.has(id)) continue;
    URL.revokeObjectURL(url);
    trayThumbs.delete(id);
  }

  tray.textContent = "";
  tray.classList.toggle("hidden", !items.length);
  for (const item of items) {
    const card = el("div", "att-card" + (item.state === "error" ? " error" : ""));

    if (isImage(item.mime)) {
      let url = trayThumbs.get(item.id);
      if (!url) {
        url = URL.createObjectURL(item.file);
        trayThumbs.set(item.id, url);
      }
      const img = el("img", "att-card-thumb");
      img.alt = "";
      img.src = url;
      card.appendChild(img);
    } else {
      card.appendChild(el("div", "att-card-icon", fileIcon(item.name, item.mime)));
    }

    const meta = el("div", "att-card-meta");
    meta.appendChild(el("div", "att-card-name", item.name));
    meta.appendChild(el("div", "att-card-size", item.error || humanSize(item.size)));
    card.appendChild(meta);

    const spoil = el("button", "att-card-spoil" + (item.spoiler ? " on" : ""), item.spoiler ? "🙈" : "👁");
    spoil.title = item.spoiler ? "Spoilered — click to show it plainly" : "Mark as a spoiler";
    spoil.onclick = () => {
      uploader.toggleSpoiler(item.id);
      renderTray();
    };
    const remove = el("button", "att-card-remove", "✕");
    remove.title = "Remove";
    remove.onclick = () => {
      uploader.remove(item.id);
      renderTray();
    };
    card.append(spoil, remove);

    if (item.state === "uploading") {
      const bar = el("div", "att-card-bar");
      const fill = el("div", "att-card-fill");
      fill.style.width = item.pct + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
    }
    tray.appendChild(card);
  }
  syncComposer();
}

$("btn-attach").onclick = () => $("file-picker").click();
$("file-picker").onchange = (e) => {
  addFiles(e.target.files);
  e.target.value = ""; // so picking the same file twice still fires
};

// dragleave fires every time the pointer crosses into a child element, so a
// naive handler strobes the overlay. Count enters against leaves instead.
let dragDepth = 0;
const dragHasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
function showDrop(on) {
  $("drop-overlay").classList.toggle("hidden", !on);
}
$("chat-view").addEventListener("dragenter", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) showDrop(true);
});
$("chat-view").addEventListener("dragover", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
$("chat-view").addEventListener("dragleave", (e) => {
  if (!dragHasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    showDrop(false);
  }
});
$("chat-view").addEventListener("drop", (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  showDrop(false);
  addFiles(e.dataTransfer.files);
});

// How screenshots actually get shared. A text paste is left to the browser —
// but maxlength drops the tail without a word, and the counter only appears
// with 400 characters to go, so a wall of text loses its ending invisibly. Say
// so, after the fact, because that's the only point at which the real figure is
// known (the browser normalises line endings as it inserts).
input.addEventListener("paste", (e) => {
  const files = e.clipboardData?.files;
  if (files?.length) {
    e.preventDefault();
    addFiles(files);
    return;
  }
  const pasted = (e.clipboardData?.getData("text") || "").replace(/\r\n/g, "\n");
  if (!pasted) return;
  const kept = input.value.length - (input.selectionEnd - input.selectionStart);
  setTimeout(() => {
    const dropped = pasted.length - (input.value.length - kept);
    if (dropped > 0) toast(`Paste was ${dropped.toLocaleString()} characters too long — the end was cut off.`, true);
  }, 0);
});

// Revealed spoilers are remembered per attachment key, so a repaint (a new
// message, a reaction) doesn't hide something you already chose to look at.
const revealedAtts = new Set();

/* ----------------------------- emoji picker ------------------------------ */

let emojiMode = { mode: "input" };

function pickEmoji(value, picker) {
  if (emojiMode.mode === "react") {
    wsSend({ type: "react", chanId: emojiMode.msg.chanId, msgId: emojiMode.msg.id, emoji: value });
    picker.classList.add("hidden");
  } else {
    insertAtCursor(input, value);
    input.focus();
  }
}

function openEmojiPicker(mode) {
  emojiMode = mode || { mode: "input" };
  const picker = $("emoji-picker");
  if (!picker.querySelector(".emoji-btn")) {
    for (const emoji of EMOJIS) {
      const b = el("button", "emoji-btn", emoji);
      b.onclick = () => pickEmoji(emoji, picker);
      picker.appendChild(b);
    }
  }
  // The unicode buttons are the same forever; the server's own emoji are not,
  // so that row is rebuilt every time the picker opens.
  picker.querySelectorAll(".ce-picker, .ce-picker-head").forEach((n) => n.remove());
  const row = emojiPickerRow(emojiReg.forCode(state.currentCode), (e) => pickEmoji(`:${e.name}:`, picker));
  if (row) {
    picker.prepend(row);
    picker.prepend(el("div", "ce-picker-head", "This server"));
  }
  picker.classList.toggle("hidden");
}
function insertAtCursor(node, text) {
  const start = node.selectionStart ?? node.value.length;
  node.value = node.value.slice(0, start) + text + node.value.slice(node.selectionEnd ?? start);
  node.selectionStart = node.selectionEnd = start + text.length;
  autoGrow(node);
}
$("btn-emoji").onclick = (e) => {
  e.stopPropagation();
  openEmojiPicker({ mode: "input" });
};

/* --------------------------- history on scroll --------------------------- */

$("messages").addEventListener("scroll", () => {
  const pane = $("messages");
  const behind = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
  $("jump-present").classList.toggle("hidden", behind < 200);
  if (
    pane.scrollTop < 40 &&
    state.activeChan &&
    !state.noMoreHistory.has(state.activeChan) &&
    !state.historyPending.has(state.activeChan) // scroll fires per-frame; one request at a time
  ) {
    const list = state.messages.get(state.activeChan) || [];
    const oldest = list.find((x) => !x.pending);
    if (oldest) requestHistory(state.activeChan, oldest.id);
  }
});

/* ----------------------------- voice buttons ----------------------------- */

$("btn-mute").onclick = () => {
  voice.setMuted(!voice.muted);
  $("btn-mute").classList.toggle("on", voice.muted);
  $("btn-mute").title = voice.muted ? "Unmute" : "Mute";
};
$("btn-deafen").onclick = () => {
  voice.setDeafened(!voice.deafened);
  $("btn-deafen").classList.toggle("on", voice.deafened);
  $("btn-mute").classList.toggle("on", voice.muted || voice.deafened);
  $("btn-deafen").title = voice.deafened ? "Undeafen" : "Deafen";
};
$("btn-hangup").onclick = () => leaveVoice();
$("btn-share").onclick = async () => {
  if (voice.shareStream) {
    const wasCamera = voice.shareKind === "camera";
    voice.stopShare();
    if (!wasCamera) return; // toggling the screen off is all they asked for
  }
  await voice.startShare();
  if (voice.shareStream) {
    $("btn-share").classList.add("on");
    $("btn-camera").classList.remove("on");
    addShareTile("me", voice.shareStream, "Your screen");
    unlock("presenting");
  }
};

// One outgoing video track per person, so camera and screen take turns.
$("btn-camera").onclick = async () => {
  if (voice.shareStream) {
    const wasCamera = voice.shareKind === "camera";
    voice.stopShare();
    if (wasCamera) return;
  }
  await voice.startCamera();
  if (voice.shareStream) {
    $("btn-camera").classList.add("on");
    $("btn-share").classList.remove("on");
    addShareTile("me", voice.shareStream, "You", true);
    unlock("on-air");
  }
};
$("jump-present").onclick = () => {
  const realm = R();
  if (realm) realm.firstUnread.delete(realm.activeChan);
  renderMessages(true);
  $("jump-present").classList.add("hidden");
};

$("btn-members").onclick = () => $("app").classList.toggle("members-hidden");

// A DM's "call" is just joining the DM's voice channel.
$("btn-call").onclick = () => {
  const chan = state.channels.find((c) => c.type === "voice");
  if (!chan) return;
  if (state.voiceCode === state.activeCode && state.voiceChan === chan.id) leaveVoice();
  else joinVoice(chan.id);
};

/* ========================== home / friends wiring ========================= */

$("home-btn").onclick = goHome;
$("dm-friends-btn").onclick = goHome;
$("dm-saved-btn").onclick = openSaved;
$("dm-add-btn").onclick = () => {
  goHome();
  state.fvTab = "add";
  renderFriendsView();
};
$("dm-group-btn").onclick = () => openNewGroupModal();
document.querySelectorAll("#fv-tabs button").forEach((b) => {
  b.onclick = () => {
    state.fvTab = b.dataset.tab;
    renderFriendsView();
  };
});

/* ============================== auto-idle ================================ */
// Flip to Idle after a while with no input, and straight back on the first
// sign of life. Your *chosen* presence is never overwritten — if you picked
// DND or Invisible, that's what you stay.

const IDLE_AFTER_MS = 6 * 60 * 1000;
let lastActivity = Date.now();
let autoIdle = false;

function noteActivity() {
  lastActivity = Date.now();
  if (autoIdle) {
    autoIdle = false;
    hub.pushProfile();
    renderMe();
  }
}
for (const ev of ["mousedown", "keydown", "mousemove", "wheel", "touchstart", "focus"]) {
  window.addEventListener(ev, noteActivity, { passive: true });
}
setInterval(() => {
  if (!state.settings.autoIdle || autoIdle) return;
  if (state.settings.presence !== "online") return; // respect DND / Invisible
  if (Date.now() - lastActivity < IDLE_AFTER_MS) return;
  autoIdle = true;
  hub.pushProfile();
  renderMe();
}, 30000);

/* =========================== keyboard shortcuts ========================== */

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSwitcher();
  } else if (mod && e.key.toLowerCase() === "f" && state.view !== "home") {
    e.preventDefault();
    openSearch();
  } else if (e.shiftKey && e.key === "Escape") {
    // Shift+Esc: declare bankruptcy on this server's unread.
    e.preventDefault();
    if (state.activeCode) markRealmRead(state.activeCode);
  } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    // Alt+Up/Down walks the text channels, like the real thing.
    const chans = state.channels.filter((c) => c.type === "text");
    if (chans.length > 1 && state.view === "server") {
      e.preventDefault();
      const i = chans.findIndex((c) => c.id === state.activeChan);
      const next = (i + (e.key === "ArrowDown" ? 1 : -1) + chans.length) % chans.length;
      activateChannel(chans[next].id);
    }
  } else if (e.key === "Escape") {
    hideProfile();
    $("soundboard").classList.add("hidden");
    if (!$("modal-backdrop").classList.contains("hidden")) {
      const blocking =
        !$("onboard-modal").classList.contains("hidden") ||
        (!$("join-modal").classList.contains("hidden") && !state.servers.length);
      if (!blocking) closeModals();
    }
  }
});

// Clicking away closes the floating bits.
document.addEventListener("click", (e) => {
  const pop = $("profile-pop");
  if (!pop.classList.contains("hidden") && !pop.contains(e.target)) hideProfile();
  const board = $("soundboard");
  if (!board.classList.contains("hidden") && !board.contains(e.target) && e.target.id !== "btn-soundboard") {
    board.classList.add("hidden");
  }
});

/* ================================ pins =================================== */

$("btn-pins").onclick = () => {
  if (!state.activeChan) return;
  $("pins-list").textContent = "Loading…";
  $("pins-sub").textContent =
    state.view === "dm" ? "The greatest hits of this conversation." : "The greatest hits of this channel.";
  showModal("pins-modal");
  wsSend({ type: "pins", chanId: state.activeChan });
};

function renderPins(messages) {
  const list = $("pins-list");
  list.textContent = "";
  if (!messages.length) {
    list.appendChild(emptyState("📌", "Nothing pinned yet", "Hover any message and hit 📌 to immortalise it."));
    return;
  }
  for (const msg of messages) {
    const row = el("div", "pin-row");
    const av = el("div", "avatar small", msg.author.avatar);
    av.style.background = msg.author.color;
    row.appendChild(av);
    const col = el("div", "m-col");
    const head = el("div", "pin-head");
    const name = el("span", "mg-name", msg.author.name);
    name.style.color = msg.author.color;
    head.append(name, el("span", "mg-time", fmtTime(msg.ts)));
    col.appendChild(head);
    const body = el("div", "msg-content");
    body.innerHTML = renderMarkdown(msg.content, state.currentCode);
    body.querySelectorAll(".spoiler").forEach((s) => (s.onclick = () => s.classList.add("revealed")));
    col.appendChild(body);
    row.appendChild(col);
    const jump = el("button", "pill-btn tiny", "Jump");
    jump.onclick = () => {
      closeModals();
      jumpToMessage(msg.id);
    };
    const unpin = el("button", "icon-btn", "✕");
    unpin.title = "Unpin";
    unpin.onclick = () => {
      wsSend({ type: "unpin", chanId: msg.chanId, msgId: msg.id });
      row.remove();
    };
    const acts = el("div", "friend-actions");
    acts.append(jump, unpin);
    row.appendChild(acts);
    list.appendChild(row);
  }
}

/* ============================ saved messages ============================== */
// Bookmarks live in localStorage and nowhere else — the server has no idea any
// of this exists, which is the point.

function saveMessage(msg) {
  const code = state.currentCode;
  if (!code) return;
  const kept = (state.settings.saved || []).filter(
    (s) => !(s.code === code && s.chanId === msg.chanId && s.msgId === msg.id)
  );
  kept.unshift({
    code,
    chanId: msg.chanId,
    msgId: msg.id,
    preview: clip(`${msg.author.name}: ${msg.content}`, 120),
    ts: Date.now(),
  });
  state.settings.saved = kept.slice(0, SAVED_CAP);
  store.set("settings", state.settings);
  toast("🔖 Saved. Find it under 🔖 Saved in your DM list.");
}

function openSaved() {
  showModal("saved-modal");
  const list = $("saved-list");
  list.textContent = "";
  const saved = state.settings.saved || [];
  $("saved-sub").textContent = saved.length
    ? `${saved.length} kept, newest first. Stored on this device only.`
    : "Nothing kept yet.";
  if (!saved.length) {
    list.appendChild(emptyState("🔖", "No saved messages", "Hover any message and hit 🔖 to keep it here."));
    return;
  }
  for (const item of saved) {
    const row = el("div", "pin-row");
    row.appendChild(el("div", "avatar small", "🔖"));
    const col = el("div", "m-col");
    const where = state.servers.find((s) => s.code === item.code)?.name || item.code;
    col.appendChild(el("div", "pin-head", `${where} · ${agoText(item.ts)}`));
    col.appendChild(el("div", "m-status", item.preview));
    row.appendChild(col);
    const acts = el("div", "friend-actions");
    const jump = el("button", "pill-btn tiny", "Jump");
    jump.onclick = () => {
      closeModals();
      jumpToSaved(item);
    };
    const drop = el("button", "icon-btn", "✕");
    drop.title = "Forget this one";
    drop.onclick = () => {
      state.settings.saved = (state.settings.saved || []).filter((s) => s !== item);
      store.set("settings", state.settings);
      openSaved();
    };
    acts.append(jump, drop);
    row.appendChild(acts);
    list.appendChild(row);
  }
}

// The server only keeps the last 300 messages per channel, so a bookmark can
// outlive the thing it points at. Say so rather than scrolling nowhere.
function jumpToSaved(item) {
  const realm = state.realms.get(item.code);
  if (!realm) {
    toast("You're not in that server any more.", true);
    return;
  }
  switchToRealm(item.code);
  if (!realm.channels.some((c) => c.id === item.chanId)) {
    toast("That channel is gone.", true);
    return;
  }
  activateChannel(item.chanId);
  setTimeout(() => {
    if (document.querySelector(`.msg[data-id="${item.msgId}"]`)) jumpToMessage(item.msgId);
    else toast("That one has aged out of the server's 300-message memory. Only the preview is left.", true);
  }, 400);
}

function jumpToMessage(id) {
  const target = document.querySelector(`.msg[data-id="${id}"]`);
  if (!target) {
    toast("That message is further up than we've loaded — scroll up a bit.", true);
    return;
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), 1600);
}

/* =============================== search ================================== */

$("btn-search").onclick = () => openSearch();
function openSearch() {
  if (!state.activeChan) return;
  showModal("search-modal");
  $("search-results").textContent = "";
  const input = $("search-input");
  input.value = "";
  setTimeout(() => input.focus(), 0);
}

let searchTimer = null;
function runSearch() {
  const q = $("search-input").value.trim();
  if (q.length < 2) {
    $("search-results").textContent = "";
    return;
  }
  const everywhere = $("search-all").checked;
  wsSend({ type: "search", q, chanId: everywhere ? "" : state.activeChan });
}
$("search-input").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 220);
});
$("search-all").addEventListener("change", runSearch);

function renderSearchResults(m) {
  const out = $("search-results");
  out.textContent = "";
  if (!m.hits.length) {
    out.appendChild(emptyState("🔍", "No matches", `Nothing here says "${m.q}".`));
    return;
  }
  out.appendChild(
    el("div", "fv-head", `${m.hits.length}${m.truncated ? "+" : ""} result${m.hits.length === 1 ? "" : "s"}`)
  );
  for (const msg of m.hits) {
    const row = el("div", "pin-row");
    const av = el("div", "avatar small", msg.author.avatar);
    av.style.background = msg.author.color;
    row.appendChild(av);
    const col = el("div", "m-col");
    const head = el("div", "pin-head");
    const name = el("span", "mg-name", msg.author.name);
    name.style.color = msg.author.color;
    head.append(name, el("span", "mg-time", `#${msg.chanName} · ${fmtTime(msg.ts)}`));
    col.appendChild(head);
    const body = el("div", "msg-content");
    body.innerHTML = renderMarkdown(msg.content, state.currentCode);
    col.appendChild(body);
    row.appendChild(col);
    const jump = el("button", "pill-btn tiny", "Jump");
    jump.onclick = () => {
      closeModals();
      if (msg.chanId !== state.activeChan) activateChannel(msg.chanId);
      setTimeout(() => jumpToMessage(msg.id), 300);
    };
    row.appendChild(jump);
    out.appendChild(row);
  }
}

/* =========================== quick switcher =============================== */

function openSwitcher() {
  showModal("switch-modal");
  const input = $("switch-input");
  input.value = "";
  state.switchIndex = 0;
  renderSwitcher();
  setTimeout(() => input.focus(), 0);
}

function switcherCandidates(q) {
  const items = [];
  for (const s of state.servers) {
    const realm = state.realms.get(s.code);
    let unread = 0;
    realm?.unread.forEach((v) => (unread += v));
    items.push({
      icon: s.icon,
      label: s.name,
      sub: unread ? `Server · ${unread} unread` : "Server",
      unread,
      act: () => goServer(s.code),
    });
  }
  if (state.view === "server") {
    for (const c of state.channels) {
      items.push({
        icon: c.type === "text" ? "#" : "🔊",
        label: c.name,
        sub: state.meta?.name || "Channel",
        act: () => (c.type === "text" ? activateChannel(c.id) : joinVoice(c.id)),
      });
    }
  }
  for (const f of hub.friends.values()) {
    const unread = hub.unread.get(f.uid) || 0;
    items.push({
      icon: f.avatar,
      label: f.name,
      sub: unread ? `@${f.tag} · ${unread} unread` : `@${f.tag} · Direct Message`,
      unread,
      act: () => openDm(f.uid),
    });
  }
  items.push({ icon: "👥", label: "Friends", sub: "Home", act: goHome });
  const needle = q.trim().toLowerCase();
  // With nothing typed, put whatever needs your attention at the top.
  const byUnread = (a, b) => (b.unread || 0) - (a.unread || 0);
  if (!needle) return items.sort(byUnread).slice(0, 12);
  return items
    .filter((i) => (i.label + " " + i.sub).toLowerCase().includes(needle))
    .sort(byUnread)
    .slice(0, 12);
}

function renderSwitcher() {
  const out = $("switch-results");
  out.textContent = "";
  state.switchItems = switcherCandidates($("switch-input").value);
  if (!state.switchItems.length) {
    out.appendChild(el("div", "switch-empty", "Nothing matches that."));
    return;
  }
  state.switchIndex = Math.max(0, Math.min(state.switchIndex, state.switchItems.length - 1));
  state.switchItems.forEach((item, i) => {
    const row = el("div", "switch-row" + (i === state.switchIndex ? " active" : ""));
    row.appendChild(el("span", "switch-icon", item.icon));
    row.appendChild(el("span", "switch-label", item.label));
    row.appendChild(el("span", "switch-sub", item.sub));
    row.onclick = () => {
      closeModals();
      item.act();
    };
    out.appendChild(row);
  });
}

$("switch-input").addEventListener("input", () => {
  state.switchIndex = 0;
  renderSwitcher();
});
$("switch-input").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    state.switchIndex++;
    renderSwitcher();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    state.switchIndex--;
    renderSwitcher();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const item = state.switchItems[state.switchIndex];
    if (item) {
      closeModals();
      item.act();
    }
  }
});

/* ============================ profile popout ============================== */

// Given anyone we can see (a server member, a message author, a friend),
// find the matching friend record if there is one.
function friendFor(person) {
  if (!person) return null;
  if (person.uid && hub.friends.has(person.uid)) return hub.friends.get(person.uid);
  if (person.tag) {
    for (const f of hub.friends.values()) if (f.tag === person.tag) return f;
  }
  return null;
}

function openProfile(x, y, person) {
  const pop = $("profile-pop");
  pop.textContent = "";
  // Server members carry a friend tag, not a uid — so match on whichever we
  // have. This is what makes "click someone in a server, then DM them" work.
  const friend = friendFor(person);
  const uid = person.uid || friend?.uid || null;

  const banner = el("div", "pp-banner");
  banner.style.background = person.color;
  pop.appendChild(banner);
  const av = el("div", "pp-avatar", person.avatar);
  av.style.background = person.color;
  pop.appendChild(av);

  const body = el("div", "pp-body");
  const name = el("div", "pp-name", person.name);
  name.style.color = person.color;
  if (isOwnerOf(R(), person.userId)) {
    const crown = el("span", "owner-crown", "👑");
    crown.title = "Server owner";
    name.appendChild(crown);
  }
  body.appendChild(name);
  if (person.tag) body.appendChild(el("div", "pp-tag", "@" + person.tag));
  if (person.status) body.appendChild(el("div", "pp-status", person.status));
  if (person.voice) {
    const chan = state.channels.find((c) => c.id === person.voice.chanId);
    body.appendChild(el("div", "pp-status", `🔊 In ${chan?.name || "voice"}`));
  }
  // A roster row has no sid because nobody's holding a socket for them.
  if (!person.sid && person.at) body.appendChild(el("div", "pp-status", `Last seen ${agoText(person.at)}`));

  const acts = el("div", "pp-actions");
  const isMe = person.sid
    ? person.sid === state.me?.sid
    : person.userId
    ? person.userId === realmUserId(R())
    : uid && uid === hub.me?.uid;
  if (!isMe) {
    if (friend) {
      const msg = el("button", "primary-btn tiny", "Message");
      msg.onclick = () => {
        hideProfile();
        openDm(friend.uid);
      };
      const poke = el("button", "pill-btn tiny", "Poke 👉");
      poke.onclick = () => hub.poke(friend.uid);
      acts.append(msg, poke);
    } else if (person.tag) {
      const add = el("button", "primary-btn tiny", "Add Friend");
      add.onclick = () => {
        hub.addFriend(person.tag);
        hideProfile();
      };
      acts.appendChild(add);
    } else {
      const hint = el("div", "pp-hint", "Ask them for their friend tag to add them.");
      body.appendChild(hint);
    }
    if (person.sid && person.sid !== state.me?.sid) {
      const prank = el("button", "pill-btn tiny", "Prank 🃏");
      prank.onclick = () => {
        hideProfile();
        openGremlinModal(person.sid);
      };
      acts.appendChild(prank);
    }
  } else {
    const edit = el("button", "pill-btn tiny", "Edit Profile");
    edit.onclick = () => {
      hideProfile();
      openSettings();
    };
    acts.appendChild(edit);
  }
  body.appendChild(acts);

  // A note about someone is for you. It is stored on this machine and there is
  // no wire format for it at all.
  const noteKey = person.userId || uid;
  if (noteKey && !isMe) {
    body.appendChild(el("div", "pp-note-label", "Private note — stays on this device"));
    const note = document.createElement("textarea");
    note.className = "pp-note";
    note.rows = 2;
    note.maxLength = 280;
    note.placeholder = "Who is this again?";
    note.value = state.settings.notes?.[noteKey] || "";
    note.onchange = () => {
      const notes = { ...(state.settings.notes || {}) };
      if (note.value.trim()) notes[noteKey] = note.value.trim();
      else delete notes[noteKey];
      state.settings.notes = notes;
      store.set("settings", state.settings);
    };
    body.appendChild(note);
  }
  pop.appendChild(body);

  pop.classList.remove("hidden");
  const w = pop.offsetWidth || 260;
  const h = pop.offsetHeight || 240;
  pop.style.left = Math.max(8, Math.min(x, window.innerWidth - w - 8)) + "px";
  pop.style.top = Math.max(8, Math.min(y, window.innerHeight - h - 8)) + "px";
}
function hideProfile() {
  $("profile-pop").classList.add("hidden");
}

/* ============================== soundboard ================================ */

// A clip that someone uploaded is a file, so there's nothing to synthesize —
// it just gets played.
function playClip(url) {
  try {
    const audio = new Audio(url);
    audio.volume = Math.min(1, (state.settings.volume || 100) / 100);
    audio.play().catch(() => {});
  } catch {}
}

// Custom clips belong to a server, and the sound goes wherever the call is.
const customSound = (id) => (voiceRealm() || R())?.sounds?.find((s) => s.id === id) || null;

function fireSound(id) {
  const custom = customSound(id);
  if (!custom && !SOUNDBOARD.some((s) => s.id === id)) return;
  if (custom) playClip(custom.url);
  else playSound(id, (state.settings.volume || 100) / 100);
  unlock("noisy");
  if (bumpStat("sounds") >= 50) unlock("dj");
  // Goes to the call, wherever the call is — not to whatever you're reading.
  if (state.voiceCode) voiceRealm()?.send({ type: "sound", sound: id });
  else toast("Nobody heard that — join a voice channel first.", true);
}

function renderSoundboard() {
  const board = $("soundboard");
  board.textContent = "";
  const head = el("div", "sb-head", "🎵 Soundboard");
  board.appendChild(head);
  const grid = el("div", "sb-grid");
  for (const s of SOUNDBOARD) {
    const b = el("button", "sb-btn");
    b.appendChild(el("span", "sb-emoji", s.emoji));
    b.appendChild(el("span", "sb-label", s.label));
    b.onclick = () => fireSound(s.id);
    grid.appendChild(b);
  }
  for (const s of (voiceRealm() || R())?.sounds || []) {
    const b = el("button", "sb-btn sb-custom");
    b.appendChild(el("span", "sb-emoji", "📼"));
    b.appendChild(el("span", "sb-label", s.name));
    b.title = `${s.name} — uploaded to this server`;
    b.onclick = () => fireSound(s.id);
    b.oncontextmenu = (ev) => {
      ev.preventDefault();
      ctxMenu(ev.clientX, ev.clientY, [
        {
          label: "Delete Clip",
          danger: true,
          onClick: () =>
            confirmModal(`Delete "${s.name}"?`, "It goes for everyone on this server.", () =>
              wsSend({ type: "sound-remove", id: s.id })
            ),
        },
      ]);
    };
    grid.appendChild(b);
  }
  board.appendChild(grid);
  const add = el("button", "pill-btn sb-add", "＋ Upload a clip");
  add.onclick = () => $("sound-picker").click();
  board.appendChild(add);
  board.appendChild(el("div", "sb-foot", "Everyone in your voice channel hears it. Use responsibly. Or don't."));
}

$("sound-picker").onchange = (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > SOUND_MAX_BYTES) {
    toast("Clips cap out at 512 KB. Trim it down.", true);
    return;
  }
  promptModal("Name this clip", file.name.replace(/\.[^.]+$/, "").slice(0, 24), async (name) => {
    const key = await uploadAsset(file);
    if (key) wsSend({ type: "sound-add", name, key });
  });
};

$("btn-soundboard").onclick = (e) => {
  e.stopPropagation();
  renderSoundboard();
  $("soundboard").classList.toggle("hidden");
};

/* ============================= autocomplete =============================== */
// One popup, three modes: @mentions, /commands, and :emoji:.

function hideAutocomplete() {
  state.autocomplete = null;
  $("autocomplete").classList.add("hidden");
}

function autocompleteCandidates() {
  const node = $("input");
  const upto = node.value.slice(0, node.selectionStart ?? node.value.length);

  const slash = upto.match(/^\/(\w*)$/);
  if (slash) {
    const q = slash[1].toLowerCase();
    const items = SLASH.filter((c) => c.name.startsWith(q)).map((c) => ({
      icon: "/",
      label: c.name,
      sub: c.help,
      insert: `/${c.name} `,
      from: 0,
    }));
    return items.length ? { kind: "slash", items } : null;
  }

  const at = upto.match(/(^|\s)@([\w.\- ]{0,24})$/);
  if (at) {
    const q = at[2].toLowerCase();
    const from = upto.length - at[2].length - 1;
    const seen = new Set();
    const items = [];
    const push = (name, icon, sub) => {
      const key = name.toLowerCase();
      if (seen.has(key) || !key.includes(q)) return;
      seen.add(key);
      items.push({ icon, label: name, sub, insert: `@${name} `, from });
    };
    for (const member of state.members.values()) {
      if (member.sid !== state.me?.sid) push(member.name, member.avatar, "in this server");
    }
    for (const f of hub.friends.values()) push(f.name, f.avatar, "@" + f.tag);
    if (state.view === "server") {
      push("everyone", "📣", "notify the whole channel");
      push("here", "👋", "notify whoever's around");
    }
    return items.length ? { kind: "mention", items: items.slice(0, 8) } : null;
  }

  const colon = upto.match(/(^|\s):([a-z0-9_+-]{2,})$/i);
  if (colon) {
    const q = colon[2].toLowerCase();
    const from = upto.length - colon[2].length - 1;
    // Custom emoji rank above the built-ins — somebody here went to the
    // trouble of uploading them, so they're the likelier target.
    const items = emojiCandidates(q, state.currentCode, emojiReg, EMOJI_NAMES).map((e) =>
      e.url
        ? { icon: "", img: e.url, label: `:${e.name}:`, sub: "this server", insert: `:${e.name}: `, from }
        : { icon: e.char, label: `:${e.name}:`, sub: "", insert: e.char + " ", from }
    );
    return items.length ? { kind: "emoji", items } : null;
  }
  return null;
}

function updateAutocomplete() {
  const found = autocompleteCandidates();
  if (!found) return hideAutocomplete();
  const prevIndex = state.autocomplete?.index || 0;
  state.autocomplete = { ...found, index: Math.min(prevIndex, found.items.length - 1) };
  renderAutocomplete();
}

function renderAutocomplete() {
  const pop = $("autocomplete");
  const ac = state.autocomplete;
  if (!ac) return hideAutocomplete();
  pop.textContent = "";
  const title = { mention: "MEMBERS", slash: "COMMANDS", emoji: "EMOJI" }[ac.kind];
  pop.appendChild(el("div", "ac-head", title));
  ac.items.forEach((item, i) => {
    const row = el("div", "ac-row" + (i === ac.index ? " active" : ""));
    if (item.img) {
      const img = el("img", "ac-emoji");
      img.src = item.img;
      img.alt = item.label;
      row.appendChild(img);
    } else {
      row.appendChild(el("span", "ac-icon", item.icon));
    }
    row.appendChild(el("span", "ac-label", item.label));
    if (item.sub) row.appendChild(el("span", "ac-sub", item.sub));
    row.onmousedown = (e) => {
      e.preventDefault();
      applyAutocomplete(i);
    };
    pop.appendChild(row);
  });
  pop.classList.remove("hidden");
}

function applyAutocomplete(index) {
  const ac = state.autocomplete;
  if (!ac) return;
  const item = ac.items[index ?? ac.index];
  if (!item) return;
  const node = $("input");
  const caret = node.selectionStart ?? node.value.length;
  node.value = node.value.slice(0, item.from) + item.insert + node.value.slice(caret);
  const pos = item.from + item.insert.length;
  node.selectionStart = node.selectionEnd = pos;
  hideAutocomplete();
  autoGrow(node);
  node.focus();
}

// A small name->emoji table for :shortcode: completion.
const EMOJI_NAMES = [
  ["joy", "😂"], ["sob", "😭"], ["skull", "💀"], ["fire", "🔥"], ["heart", "❤️"],
  ["thumbsup", "👍"], ["thumbsdown", "👎"], ["clap", "👏"], ["pray", "🙏"], ["eyes", "👀"],
  ["thinking", "🤔"], ["sunglasses", "😎"], ["party", "🥳"], ["tada", "🎉"], ["rocket", "🚀"],
  ["ghost", "👻"], ["robot", "🤖"], ["alien", "👽"], ["clown", "🤡"], ["poop", "💩"],
  ["pizza", "🍕"], ["beer", "🍺"], ["coffee", "☕"], ["cat", "🐱"], ["dog", "🐶"],
  ["fox", "🦊"], ["frog", "🐸"], ["duck", "🦆"], ["shark", "🦈"], ["unicorn", "🦄"],
  ["moon", "🌙"], ["star", "⭐"], ["zap", "⚡"], ["boom", "💥"], ["sparkles", "✨"],
  ["check", "✅"], ["x", "❌"], ["warning", "⚠️"], ["question", "❓"], ["100", "💯"],
  ["sleeping", "💤"], ["wave", "👋"], ["muscle", "💪"], ["brain", "🧠"], ["trophy", "🏆"],
];

/* ========================= progress & achievements ======================= */
// All of this lives in localStorage and is never transmitted. It exists to be
// a small pleasant thing for you, not a leaderboard.

function bumpStat(key, by = 1) {
  const stats = { ...(state.settings.stats || {}) };
  stats[key] = (stats[key] || 0) + by;
  state.settings.stats = stats;
  store.set("settings", state.settings);
  return stats[key];
}

function statOf(key) {
  return state.settings.stats?.[key] || 0;
}

function addXp(amount) {
  const before = levelFromXp(state.settings.xp || 0).level;
  state.settings.xp = (state.settings.xp || 0) + amount;
  store.set("settings", state.settings);
  const after = levelFromXp(state.settings.xp).level;
  if (after > before) {
    toast(`⬆️ Level ${after}!`);
    if (state.settings.turbo) confetti(70);
    if (state.settings.sounds) playSound("applause", 0.5);
    if (after >= 10) unlock("level-10");
    if (after >= 25) unlock("level-25");
  }
  renderLevel();
}

function unlock(id) {
  const ach = ACH_BY_ID.get(id);
  if (!ach) return;
  const have = state.settings.achievements || [];
  if (have.includes(id)) return;
  state.settings.achievements = [...have, id];
  store.set("settings", state.settings);
  achievementToast(ach, $("toasts"));
  if (state.settings.sounds) playSound("wow", 0.5);
  if (state.settings.turbo) confetti(50);
  addXp(25);
}

function renderLevel() {
  const badge = $("level-badge");
  if (!badge) return;
  const { level, into, need } = levelFromXp(state.settings.xp || 0);
  badge.textContent = String(level);
  $("level-text").textContent = `${into} / ${need} XP to level ${level + 1}`;
  $("xp-fill").style.width = Math.min(100, (into / need) * 100) + "%";
}

function openAchievements() {
  showModal("achievements-modal");
  const have = new Set(state.settings.achievements || []);
  $("ach-sub").textContent = `${have.size} of ${ACHIEVEMENTS.length} unlocked. Entirely pointless. Collect them anyway.`;
  const list = $("ach-list");
  list.textContent = "";
  for (const a of ACHIEVEMENTS) {
    const got = have.has(a.id);
    const row = el("div", "friend-row" + (got ? "" : " locked"));
    row.style.opacity = got ? "1" : "0.45";
    const icon = el("div", "avatar", got ? a.emoji : "🔒");
    icon.style.background = got ? "var(--blurple)" : "var(--bg-rail)";
    row.appendChild(icon);
    const col = el("div", "m-col");
    col.appendChild(el("div", "m-name", a.name));
    col.appendChild(el("div", "m-status", a.desc));
    row.appendChild(col);
    list.appendChild(row);
  }
}
$("set-achievements").onclick = openAchievements;

/* ================================= polls ================================= */
// A poll is an ordinary message with a recognisable shape, and voting is just
// the reactions that already exist. No new storage, no new server code, and
// the votes survive exactly as long as the message does.

const POLL_EMOJI = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];
const POLL_MARK = "📊 **Poll:** ";

function buildPollMessage(raw) {
  const parts = raw.split("|").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) {
    toast("Polls look like: /poll Pizza tonight? | Yes | Absolutely", true);
    return null;
  }
  const [question, ...options] = parts;
  const picks = options.slice(0, POLL_EMOJI.length);
  const lines = picks.map((o, i) => `${POLL_EMOJI[i]} ${o}`);
  return `${POLL_MARK}${question}\n${lines.join("\n")}`;
}

function parsePoll(content) {
  if (!content.startsWith(POLL_MARK)) return null;
  const [head, ...rest] = content.split("\n");
  const question = head.slice(POLL_MARK.length).trim();
  const options = [];
  for (const line of rest) {
    const i = POLL_EMOJI.findIndex((e) => line.startsWith(e));
    if (i >= 0) options.push({ emoji: POLL_EMOJI[i], text: line.slice(POLL_EMOJI[i].length).trim() });
  }
  return options.length >= 2 ? { question, options } : null;
}

function buildPollNode(msg, poll) {
  const wrap = el("div", "poll");
  wrap.appendChild(el("div", "poll-q", poll.question));
  const reactions = msg.reactions || {};
  const total = poll.options.reduce((n, o) => n + (reactions[o.emoji]?.length || 0), 0);
  const me = myUserId();
  for (const opt of poll.options) {
    const voters = reactions[opt.emoji] || [];
    const mine = voters.includes(me);
    const btn = el("button", "poll-opt" + (mine ? " mine" : ""));
    const fill = el("div", "poll-fill");
    fill.style.width = total ? `${(voters.length / total) * 100}%` : "0%";
    btn.appendChild(fill);
    btn.appendChild(el("span", "poll-emoji", opt.emoji));
    btn.appendChild(el("span", "poll-text", opt.text));
    btn.appendChild(el("span", "poll-count", String(voters.length)));
    btn.onclick = () => {
      // One vote each: clear whatever else you'd picked first.
      for (const other of poll.options) {
        if (other.emoji === opt.emoji) continue;
        if ((reactions[other.emoji] || []).includes(me)) {
          wsSend({ type: "react", chanId: msg.chanId, msgId: msg.id, emoji: other.emoji });
        }
      }
      wsSend({ type: "react", chanId: msg.chanId, msgId: msg.id, emoji: opt.emoji });
    };
    wrap.appendChild(btn);
  }
  wrap.appendChild(el("div", "poll-foot", total === 1 ? "1 vote" : `${total} votes`));
  return wrap;
}

/* ============================ focus / unload ============================= */

window.addEventListener("focus", () => {
  const realm = R();
  if (realm?.activeChan && state.view !== "home") {
    realm.unread.delete(realm.activeChan);
    if (!realm.unread.size) realm.mentions = 0;
    updateTitle();
    renderChannels();
    renderServerRail();
  }
});
window.addEventListener("beforeunload", () => {
  for (const realm of state.realms.values()) {
    if (realm.ws) {
      realm.ws.onclose = null;
      try {
        realm.ws.close();
      } catch {}
    }
  }
});

/* ================================= boot ================================== */

function afterProfileReady() {
  $("app").classList.remove("hidden");
  renderMe();
  hub.connect(); // friends + DMs stay live regardless of which server we're in
  ensureNotificationPermission();
  if (state.settings.mascot) launchMascot();

  const params = new URLSearchParams(location.search);
  const joinCode = (params.get("join") || "").toUpperCase();
  const last = store.get("lastServer", null);

  // Connect to every server up front, not just the one you're looking at.
  // That is what makes cross-server unread badges real and what lets a call
  // in one server survive you reading another.
  for (const s of state.servers) {
    const realm = openRealm(s.code, "guild", { kind: "reopen", code: s.code });
    if (!realm.meta) realm.meta = { name: s.name, icon: s.icon };
  }

  if (joinCode && /^[A-Z0-9]{4,12}$/.test(joinCode)) {
    history.replaceState(null, "", location.pathname);
    splashSay("joining the server…");
    openRealm(joinCode, "guild", { kind: "join", code: joinCode });
    state.activeCode = joinCode;
    state.view = "server";
    renderAll();
    return;
  }

  const target = state.servers.find((s) => s.code === last) || state.servers[0];
  if (target) {
    state.activeCode = target.code;
    state.view = "server";
    splashSay(`connecting to ${target.name || target.code}…`);
    renderAll();
  } else {
    state.view = "home";
    renderAll();
    renderFriendsView();
    hideSplash();
    openJoinModal();
  }
}

if (state.profile) {
  afterProfileReady();
} else {
  openOnboard();
}
renderServerRail();
updateTitle();

installPrankStyles();
applyTheme(state.settings.theme || "midnight");
applyTurbo(state.settings.turbo);
renderLevel();
applyVoiceFx(state.settings.fx, state.settings.fxPitch); // restore the saved voice

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

// Handle for the browser tests (and for poking at things in the console).
// Everything here is client-side state the user already owns.
window.__concord = { state, hub, voice, R, voiceRealm, switchToRealm, openDm, openGroup };
