// Concord client — state, WebSocket protocol, and all UI.
import { VoiceEngine } from "./voice.js";
import { PRANKS, runPrank, installPrankStyles } from "./prank.js";
import { startMascot, stopMascot, setSquirt, reviveMascot, mascotDown } from "./mascot.js";
import { HubConnection } from "./hub.js";
import { SOUNDBOARD, playSound } from "./sounds.js";

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
  { name: "help", args: "", help: "List every command", run: () => {
      toast("Commands: " + SLASH.map((c) => "/" + c.name).join(", "));
      return null;
    } },
];

// Voice changer presets, in semitones of pitch shift.
const VOICE_FX = [
  { id: "off", label: "Off — your actual voice", emoji: "🎙️", semis: 0 },
  { id: "fem", label: "Feminine", emoji: "💁‍♀️", semis: 5 },
  { id: "anime", label: "Anime girl", emoji: "🌸", semis: 8 },
  { id: "chipmunk", label: "Chipmunk", emoji: "🐿️", semis: 12 },
  { id: "deep", label: "Deeper", emoji: "🗿", semis: -5 },
  { id: "demon", label: "Demon", emoji: "👹", semis: -9 },
];

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
    },
    store.get("settings", {})
  ),
  servers: store.get("servers", []), // [{code, name, icon}]
  view: "server", // server | home | dm
  realmKind: "guild", // what the main socket is currently pointed at
  dmPeer: null, // {uid, name, avatar, color, ...} when realmKind === "dm"
  fvTab: "online",
  currentCode: null,
  ws: null,
  wsState: "idle", // idle | connecting | open
  gotWelcome: false,
  reconnectDelay: 1000,
  reconnectTimer: null,
  pingTimer: null,
  intent: null, // {kind:'create'|'join', code, name?, icon?} while connecting
  me: null,
  meta: null,
  channels: [],
  members: new Map(), // sid -> member
  messages: new Map(), // chanId -> msg[]
  historyLoaded: new Set(), // chanIds whose initial history arrived
  historyPending: new Set(), // chanIds with an in-flight history request
  noMoreHistory: new Set(),
  resume: null, // {code, voiceChan, activeChan} across an unplanned reconnect
  failCount: 0,
  activeChan: null,
  unread: new Map(), // chanId -> count
  typing: new Map(), // sid -> {name, chanId, until}
  lastTypingSent: 0,
  replyTo: null, // {id, name}
  editingId: null,
  voiceChan: null,
  pendingByNonce: new Map(),
  autocomplete: null, // {kind:'mention'|'slash'|'emoji', items, index, from}
  switchIndex: 0,
  switchItems: [],
};

/* ============================== dom helpers ============================= */

const $ = (id) => document.getElementById(id);
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
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

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ============================ voice engine ============================== */

const voice = new VoiceEngine({
  mySid: () => state.me?.sid || "",
  send: wsSend,
  onSpeaking(sid, speaking) {
    const key = sid === "me" ? state.me?.sid : sid;
    document.querySelectorAll(`[data-vsid="${key}"]`).forEach((n) => n.classList.toggle("speaking", speaking));
  },
  onShareStart(sid, stream) {
    addShareTile(sid, stream, state.members.get(sid)?.name || "Someone");
  },
  onShareEnd(sid) {
    removeShareTile(sid);
  },
  onLocalShareEnd() {
    removeShareTile("me");
    $("btn-share").classList.remove("on");
  },
  onError: (t) => toast(t, true),
  settings: () => state.settings,
  inMyChannel: (sid) => !!state.voiceChan && state.members.get(sid)?.voice?.chanId === state.voiceChan,
});

/* ================================= hub ================================== */

const hub = new HubConnection({
  savedAccount: () => state.account,
  profile: () => state.profile || { name: "Wumpus", avatar: "🙂", color: COLORS[0], status: "" },
  presence: () => state.settings.presence || "online",
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
    renderHomeBadge();
    if (state.view === "home") renderFriendsView();
  },
  onChange() {
    renderHomeBadge();
    renderDmList();
    if (state.view === "home") renderFriendsView();
  },
  onRequest(user) {
    toast(`👋 ${user.name} (@${user.tag}) wants to be your friend.`);
    if (state.settings.sounds) voice.playCue("ping");
  },
  onFriendRemoved(uid, known) {
    if (known) toast(`${known.name} is no longer on your friends list.`);
    // If you were reading their DM, there's nothing to read any more.
    if (state.view === "dm" && state.dmPeer?.uid === uid) goHome();
  },
  onDmReady(uid, code, user) {
    openDmRealm(uid, code, user);
  },
  onDmNudge(uid, name, preview) {
    if (state.view === "dm" && state.dmPeer?.uid === uid) {
      hub.markDmRead(uid); // we're literally looking at it
      return;
    }
    if (state.settings.sounds) voice.playCue("ping");
    updateTitle();
    if (state.settings.notifs && typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const n = new Notification(`${name} — direct message`, {
          body: preview || "(no preview)",
          icon: "/icon-192.png",
          tag: "concord-dm-" + uid,
        });
        n.onclick = () => {
          window.focus();
          openDm(uid);
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

function pushProfile() {
  hub.pushProfile();
  wsSend({
    type: "set-profile",
    name: state.profile.name,
    color: state.profile.color,
    avatar: state.profile.avatar,
    status: state.profile.status,
  });
}

/* ============================== websocket =============================== */

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function connect(code, intent) {
  disconnect();
  if (intent?.kind !== "reconnect") state.resume = null;
  state.currentCode = code;
  state.intent = intent || { kind: "reopen", code };
  state.wsState = "connecting";
  state.gotWelcome = false;

  let url = `${location.origin.replace(/^http/, "ws")}/ws?server=${encodeURIComponent(code)}`;
  if (intent?.kind === "create") {
    url += `&create=1&name=${encodeURIComponent(intent.name)}&icon=${encodeURIComponent(intent.icon)}`;
  } else if (state.realmKind === "dm") {
    // The DM's Durable Object is created lazily the first time either friend
    // opens it; create=1 is a no-op once it exists.
    url += `&create=1&kind=dm&name=${encodeURIComponent("DM")}&icon=${encodeURIComponent("💬")}`;
  }
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.wsState = "open";
    wsSend({
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
    handleServerMessage(m);
  };
  ws.onclose = () => {
    if (ws !== state.ws) return;
    const hadWelcome = state.gotWelcome;
    state.wsState = "idle";
    stopPing();
    if (!hadWelcome) {
      // Join/create failed (bad code, or server rejected us).
      if (state.intent?.kind === "join") {
        toast("Couldn't join — double-check the invite code.", true);
        state.servers = state.servers.filter((s) => s.code !== code);
        store.set("servers", state.servers);
        state.currentCode = null;
        renderServerRail();
        if (!state.servers.length) openJoinModal();
        return;
      }
      // Repeated failures on a saved server: stop hammering, let the user retry.
      state.failCount++;
      if (state.failCount >= 5) {
        state.failCount = 0;
        state.currentCode = null;
        toast(`Can't reach server ${code} right now — click it in the rail to retry.`, true);
        return;
      }
    } else {
      state.failCount = 0;
      // Remember where we were so the reconnect puts us right back.
      state.resume = { code, voiceChan: state.voiceChan, activeChan: state.activeChan };
    }
    if (state.voiceChan) leaveVoice({ silent: true });
    if (state.currentCode === code) scheduleReconnect(code);
  };
}

function disconnect() {
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  stopPing();
  if (state.ws) {
    const old = state.ws;
    state.ws = null;
    try {
      old.onclose = null;
      old.close();
    } catch {}
  }
  if (state.voiceChan) leaveVoice({ silent: true });
  state.members.clear();
  state.messages.clear();
  state.historyLoaded.clear();
  state.historyPending.clear();
  state.noMoreHistory.clear();
  state.unread.clear();
  state.typing.clear();
  state.me = null;
  state.meta = null;
  state.channels = [];
  state.activeChan = null;
  state.gotWelcome = false;
}

function scheduleReconnect(code) {
  toast("Connection lost — reconnecting…", true);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectDelay = Math.min(state.reconnectDelay * 1.6, 10000);
    if (state.currentCode === code) connect(code, { kind: "reconnect", code });
  }, state.reconnectDelay);
}

function startPing() {
  stopPing();
  state.pingTimer = setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send('{"type":"ping"}');
  }, 30000);
}
function stopPing() {
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pingTimer = null;
}

/* ========================== server msg handling ========================= */

function handleServerMessage(m) {
  switch (m.type) {
    case "pong":
      break;

    case "welcome": {
      state.gotWelcome = true;
      state.reconnectDelay = 1000;
      state.me = m.you;
      rememberIdentity(state.currentCode, m.you.userId, m.token);
      state.meta = m.meta;
      state.channels = m.channels;
      state.members = new Map(m.members.map((mm) => [mm.sid, mm]));
      startPing();

      // A DM is a ConcordServer too, but it never belongs in the server rail.
      if (state.realmKind === "dm") {
        state.intent = null;
        const resumeDm = state.resume && state.resume.code === state.currentCode ? state.resume : null;
        state.resume = null;
        renderAll();
        const chan = state.channels.find((c) => c.type === "text");
        if (chan) activateChannel(chan.id);
        if (resumeDm?.voiceChan && state.channels.some((c) => c.id === resumeDm.voiceChan && c.type === "voice")) {
          joinVoice(resumeDm.voiceChan);
        }
        break;
      }

      // Persist / refresh this server in the rail.
      const existing = state.servers.find((s) => s.code === state.currentCode);
      if (existing) {
        existing.name = m.meta.name;
        existing.icon = m.meta.icon;
      } else {
        state.servers.push({ code: state.currentCode, name: m.meta.name, icon: m.meta.icon });
      }
      store.set("servers", state.servers);
      store.set("lastServer", state.currentCode);

      if (state.intent?.kind === "create") {
        toast(`Server "${m.meta.name}" created! Hit Invite to get your friends in.`);
        openInviteModal();
      } else if (state.intent?.kind === "join") {
        toast(`Joined ${m.meta.name}!`);
      }
      state.intent = null;

      const resume = state.resume && state.resume.code === state.currentCode ? state.resume : null;
      state.resume = null;
      renderAll();
      const firstText = state.channels.find((c) => c.type === "text");
      const target =
        resume && state.channels.some((c) => c.id === resume.activeChan && c.type === "text")
          ? resume.activeChan
          : firstText?.id;
      if (target) activateChannel(target);
      if (resume?.voiceChan && state.channels.some((c) => c.id === resume.voiceChan && c.type === "voice")) {
        joinVoice(resume.voiceChan); // rejoin the call we were dropped from
      }
      break;
    }

    case "member-join": {
      state.members.set(m.member.sid, m.member);
      renderMembers();
      renderChannels();
      break;
    }

    case "member-leave": {
      const member = state.members.get(m.sid);
      state.members.delete(m.sid);
      state.typing.delete(m.sid);
      if (member?.voice?.chanId && member.voice.chanId === state.voiceChan) {
        voice.peerLeft(m.sid);
        voice.playCue("leave");
      }
      renderMembers();
      renderChannels();
      renderTyping();
      break;
    }

    case "member-update": {
      const prev = state.members.get(m.member.sid);
      state.members.set(m.member.sid, m.member);
      if (m.member.sid !== state.me?.sid && state.voiceChan) {
        const was = prev?.voice?.chanId === state.voiceChan;
        const is = m.member.voice?.chanId === state.voiceChan;
        if (was && !is) {
          voice.peerLeft(m.member.sid);
          voice.playCue("leave");
        } else if (!was && is) {
          voice.playCue("join"); // they'll initiate the WebRTC offer to us
        }
      }
      renderMembers();
      renderChannels();
      break;
    }

    case "msg": {
      pushMessage(m.msg);
      notifyIfNeeded(m.msg);
      break;
    }

    case "msg-ack": {
      const pending = state.pendingByNonce.get(m.nonce);
      state.pendingByNonce.delete(m.nonce);
      const list = state.messages.get(m.msg.chanId) || [];
      if (pending) {
        const i = list.indexOf(pending);
        if (i >= 0) list[i] = m.msg;
        else list.push(m.msg);
      } else {
        list.push(m.msg);
      }
      state.messages.set(m.msg.chanId, list);
      if (m.msg.chanId === state.activeChan) renderMessages();
      break;
    }

    case "history": {
      state.historyPending.delete(m.chanId);
      const existing = state.messages.get(m.chanId) || [];
      if (m.before) {
        if (!m.messages.length) state.noMoreHistory.add(m.chanId);
        const known = new Set(existing.map((x) => x.id));
        state.messages.set(m.chanId, [...m.messages.filter((x) => !known.has(x.id)), ...existing]);
      } else {
        // Initial load — keep optimistic pendings and any live messages that
        // raced in before this response (deduped by id).
        const known = new Set(m.messages.map((x) => x.id));
        const extras = existing.filter((x) => x.pending || !known.has(x.id));
        state.messages.set(m.chanId, [...m.messages, ...extras]);
        state.historyLoaded.add(m.chanId);
        if (m.messages.length < 60) state.noMoreHistory.add(m.chanId);
      }
      if (m.chanId === state.activeChan) renderMessages(!m.before);
      break;
    }

    case "msg-edit": {
      const list = state.messages.get(m.msg.chanId) || [];
      const i = list.findIndex((x) => x.id === m.msg.id);
      if (i >= 0) list[i] = m.msg;
      if (m.msg.chanId === state.activeChan) renderMessages();
      break;
    }

    case "msg-delete": {
      const list = state.messages.get(m.chanId) || [];
      state.messages.set(m.chanId, list.filter((x) => x.id !== m.msgId));
      if (m.chanId === state.activeChan) renderMessages();
      break;
    }

    case "msg-react": {
      const list = state.messages.get(m.chanId) || [];
      const msg = list.find((x) => x.id === m.msgId);
      if (msg) {
        if (Object.keys(m.reactions).length) msg.reactions = m.reactions;
        else delete msg.reactions;
        if (m.chanId === state.activeChan) renderMessages();
      }
      break;
    }

    case "typing": {
      if (m.chanId !== state.activeChan) break;
      state.typing.set(m.sid, { name: m.name, chanId: m.chanId, until: Date.now() + 6000 });
      renderTyping();
      break;
    }

    case "channel-create": {
      state.channels.push(m.channel);
      renderChannels();
      toast(`Channel ${m.channel.type === "text" ? "#" : "🔊 "}${m.channel.name} created`);
      break;
    }

    case "channel-update": {
      const i = state.channels.findIndex((c) => c.id === m.channel.id);
      if (i >= 0) state.channels[i] = m.channel;
      renderChannels();
      if (m.channel.id === state.activeChan) renderChatHeader();
      break;
    }

    case "channel-delete": {
      state.channels = state.channels.filter((c) => c.id !== m.chanId);
      state.messages.delete(m.chanId);
      state.historyLoaded.delete(m.chanId);
      state.historyPending.delete(m.chanId);
      state.noMoreHistory.delete(m.chanId);
      if (state.voiceChan === m.chanId) leaveVoice();
      if (state.activeChan === m.chanId) {
        const first = state.channels.find((c) => c.type === "text");
        if (first) activateChannel(first.id);
      }
      renderChannels();
      break;
    }

    case "server-meta": {
      state.meta = m.meta;
      const entry = state.servers.find((s) => s.code === state.currentCode);
      if (entry) {
        entry.name = m.meta.name;
        entry.icon = m.meta.icon;
        store.set("servers", state.servers);
      }
      $("server-name").textContent = m.meta.name;
      renderServerRail();
      break;
    }

    case "msg-pin": {
      const list = state.messages.get(m.chanId) || [];
      const msg = list.find((x) => x.id === m.msgId);
      if (msg) {
        if (m.pinned) msg.pinned = true;
        else delete msg.pinned;
        if (m.chanId === state.activeChan) renderMessages();
      }
      if (m.chanId === state.activeChan) {
        toast(m.pinned ? `📌 ${m.by} pinned a message.` : `${m.by} unpinned a message.`);
      }
      break;
    }

    case "pins": {
      renderPins(m.messages);
      break;
    }

    case "search-results": {
      renderSearchResults(m);
      break;
    }

    case "sound": {
      if (!state.settings.board) break;
      if (m.sid === state.me?.sid) break; // we already played it locally
      playSound(m.sound, (state.settings.volume || 100) / 100);
      const clip = SOUNDBOARD.find((s) => s.id === m.sound);
      if (clip) toast(`${clip.emoji} ${m.name} played ${clip.label}`);
      break;
    }

    case "voice-peers": {
      voice.connectToPeers(m.peers);
      break;
    }

    case "rtc": {
      voice.handleRtc(m.from, m.data);
      break;
    }

    case "rtc-gone": {
      voice.peerLeft(m.sid);
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
      toast(m.error, true);
      break;
    }
  }
}

/* ============================== messaging =============================== */

function pushMessage(msg) {
  const list = state.messages.get(msg.chanId) || [];
  if (list.some((x) => x.id === msg.id)) return;
  list.push(msg);
  state.messages.set(msg.chanId, list);
  state.typing.forEach((t, sid) => {
    if (state.members.get(sid)?.userId === msg.author.userId) state.typing.delete(sid);
  });
  if (msg.chanId === state.activeChan) {
    renderMessages();
    renderTyping();
  }
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

function mentionsMe(msg) {
  if (msg.author.userId === myUserId()) return false;
  const text = msg.content.toLowerCase();
  if (text.includes("@everyone") || text.includes("@here")) return true;
  return mentionNames().some((n) => n && text.includes("@" + n.toLowerCase()));
}

function notifyIfNeeded(msg) {
  const mine = msg.author.userId === myUserId();
  if (mine) return;
  const pinged = mentionsMe(msg);
  // "Inactive" = other channel, tab hidden, OR window visible but not
  // focused (second monitor while gaming — the whole point of notifications).
  const inactive = msg.chanId !== state.activeChan || document.hidden || !document.hasFocus();
  // A direct mention always pings, even in the channel you're staring at —
  // that's the entire point of being @'d.
  if (inactive || pinged) {
    if (msg.chanId !== state.activeChan) {
      state.unread.set(msg.chanId, (state.unread.get(msg.chanId) || 0) + 1);
      renderChannels();
    }
    if (state.settings.sounds) voice.playCue("ping");
    updateTitle();
    if (inactive) desktopNotify(msg);
    if (pinged && !document.hidden) flashMention();
  }
}

function flashMention() {
  document.body.classList.add("mentioned");
  setTimeout(() => document.body.classList.remove("mentioned"), 900);
}

function desktopNotify(msg) {
  if (!state.settings.notifs) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const chan = state.channels.find((c) => c.id === msg.chanId);
  try {
    const n = new Notification(`${msg.author.name} • #${chan?.name || "?"} — ${state.meta?.name || "Concord"}`, {
      body: msg.content.slice(0, 140),
      icon: "/icon-192.png",
      tag: "concord-" + msg.chanId, // coalesce per channel
    });
    n.onclick = () => {
      window.focus();
      activateChannel(msg.chanId);
      n.close();
    };
  } catch {
    // some platforms throw on constructor; nothing to do
  }
}

function totalUnread() {
  let n = 0;
  state.unread.forEach((v) => (n += v));
  return n;
}
function updateTitle() {
  const n = totalUnread() + hub.totalUnread() + hub.pendingCount();
  document.title = (n ? `(${n}) ` : "") + "Concord";
}

function sendCurrentMessage() {
  const input = $("input");
  let content = input.value.trim();
  if (!content || !state.activeChan) return;

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

  const nonce = "n" + Math.random().toString(36).slice(2);
  const optimistic = {
    id: "pending-" + nonce,
    chanId: state.activeChan,
    author: { userId: myUserId(), name: state.profile.name, color: state.profile.color, avatar: state.profile.avatar },
    content,
    ts: Date.now(),
    pending: true,
  };
  if (state.replyTo) optimistic.replyTo = { id: state.replyTo.id, name: state.replyTo.name, content: state.replyTo.content };
  state.pendingByNonce.set(nonce, optimistic);
  const list = state.messages.get(state.activeChan) || [];
  list.push(optimistic);
  state.messages.set(state.activeChan, list);

  wsSend({ type: "msg", chanId: state.activeChan, content, nonce, replyTo: state.replyTo?.id });
  // The other half of a DM isn't connected to its Durable Object unless they
  // have it open, so the hub is what lights up their sidebar.
  if (state.realmKind === "dm" && state.dmPeer) {
    hub.nudgeDm(state.dmPeer.uid, content.slice(0, 120));
  }
  state.lastTypingSent = 0; // sending ends "typing"; next keystroke signals fresh
  input.value = "";
  autoGrow(input);
  hideAutocomplete();
  clearReply();
  renderMessages();
}

/* ============================ markdown-lite ============================= */

function renderMarkdown(text) {
  const codeBlocks = [];
  // U+0000 can never appear in user content (the server strips control
  // chars), so it's a collision-free sentinel for protected fragments.
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
    codeBlocks.push(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`);
    return placeholder(codeBlocks.length - 1);
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  t = t.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  t = t.replace(/\|\|([\s\S]+?)\|\|/g, '<span class="spoiler" title="Click to reveal">$1</span>');
  t = highlightMentions(t);
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
  return t;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Runs on already-escaped text, so names are matched in their escaped form
// too. Only names we actually know light up — a stray @ is left alone.
function highlightMentions(t) {
  const names = new Set(["everyone", "here"]);
  for (const member of state.members.values()) names.add(member.name);
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
  if (!alts.length) return t;
  let re;
  try {
    re = new RegExp(`@(${alts.join("|")})`, "gi");
  } catch {
    return t; // a pathological name broke the pattern; render it plain
  }
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
  renderChatHeader();
}

function goHome() {
  state.view = "home";
  state.fvTab = hub.pendingCount() ? "pending" : "online";
  applyView();
  renderFriendsView();
  renderDmList();
}

function goServer(code) {
  state.view = "server";
  if (code && (state.currentCode !== code || state.realmKind !== "guild")) {
    state.realmKind = "guild";
    state.dmPeer = null;
    connect(code, { kind: "reopen", code });
  }
  applyView();
}

// Opening a DM points the main socket at the DM's Durable Object. That's what
// makes DM voice calls work with zero extra machinery — but it does mean
// stepping away from whichever server you were in.
function openDm(uid) {
  const friend = hub.friends.get(uid);
  if (!friend) return;
  state.view = "dm";
  applyView();
  const code = hub.dmCodes.get(uid);
  if (code) openDmRealm(uid, code, friend);
  else hub.openDm(uid); // hub replies with dm-ready, which lands here again
}

function openDmRealm(uid, code, user) {
  const friend = { ...(hub.friends.get(uid) || {}), ...(user || {}), uid };
  state.view = "dm";
  hub.markDmRead(uid);
  if (state.currentCode === code && state.realmKind === "dm") {
    state.dmPeer = friend;
    applyView();
    renderDmList();
    return;
  }
  state.realmKind = "dm";
  state.dmPeer = friend;
  connect(code, { kind: "dm", code, uid });
  applyView();
  renderDmList();
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
  if (!friends.length) {
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
    const b = el("div", "server-bubble" + (s.code === state.currentCode ? " active" : ""), s.icon);
    b.title = s.name;
    b.onclick = () => goServer(s.code);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { label: "Copy Invite Code", onClick: () => copyText(s.code, "Invite code copied") },
        { label: "Leave Server", danger: true, onClick: () => confirmLeaveServer(s) },
      ]);
    };
    list.appendChild(b);
  }
}

function renderChannels() {
  const textWrap = $("text-channels");
  const voiceWrap = $("voice-channels");
  textWrap.textContent = "";
  voiceWrap.textContent = "";

  for (const c of state.channels) {
    const row = el("div", "chan-row" + (c.type === "voice" ? " voice" : ""));
    row.appendChild(el("span", "chan-icon", c.type === "text" ? "#" : "🔊"));
    row.appendChild(el("span", "chan-label", c.name));

    if (c.type === "text") {
      if (c.id === state.activeChan) row.classList.add("active");
      const unread = state.unread.get(c.id);
      if (unread) row.appendChild(el("span", "chan-badge", String(Math.min(unread, 99))));
      row.onclick = () => activateChannel(c.id);
    } else {
      row.onclick = () => joinVoice(c.id);
    }

    const gear = el("button", "chan-gear", "⚙");
    gear.title = "Channel settings";
    gear.onclick = (e) => {
      e.stopPropagation();
      channelMenu(e, c);
    };
    row.appendChild(gear);

    if (c.type === "text") {
      textWrap.appendChild(row);
    } else {
      voiceWrap.appendChild(row);
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
        if (member.voice.sharing) icons.append("🖥");
        u.appendChild(icons);
        if (member.sid !== state.me?.sid && member.voice.chanId === state.voiceChan) {
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
      if (users.childNodes.length) voiceWrap.appendChild(users);
    }
  }
}

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

function renderMembers() {
  const wrap = $("member-list");
  wrap.textContent = "";
  const members = [...state.members.values()].sort((a, b) => a.name.localeCompare(b.name));
  wrap.appendChild(el("div", "member-group-head", `Online — ${members.length}`));
  for (const member of members) {
    const row = el("div", "member-row");
    const av = el("div", "avatar", member.avatar);
    av.style.background = member.color;
    av.dataset.vsid = member.sid;
    if (voice.isSpeaking(member.sid === state.me?.sid ? "me" : member.sid)) av.classList.add("speaking");
    row.appendChild(av);
    const col = el("div", "m-col");
    const name = el("div", "m-name", member.name);
    name.style.color = member.color;
    col.appendChild(name);
    const sub = member.voice
      ? `🔊 ${state.channels.find((c) => c.id === member.voice.chanId)?.name || "voice"}`
      : member.status || "";
    if (sub) col.appendChild(el("div", "m-status", sub));
    row.appendChild(col);
    const icons = el("span", "vu-icons");
    if (member.voice?.muted) icons.append("🔇");
    if (member.voice?.deafened) icons.append("🎧");
    row.appendChild(icons);
    row.onclick = (e) => {
      e.stopPropagation(); // otherwise the document handler closes it instantly
      openProfile(e.clientX - 300, e.clientY - 40, member);
    };
    if (member.sid !== state.me?.sid && member.voice && member.voice.chanId === state.voiceChan) {
      row.oncontextmenu = (e) => {
        e.preventDefault();
        volumeMenu(e, member);
      };
    }
    wrap.appendChild(row);
  }
}

function renderMe() {
  const av = $("me-avatar");
  av.textContent = state.profile.avatar;
  av.style.background = state.profile.color;
  if (state.me) av.dataset.vsid = state.me.sid;
  av.classList.toggle("speaking", voice.isSpeaking("me"));
  $("me-name").textContent = state.profile.name;
  const pres = PRESENCE_META[state.settings.presence] || PRESENCE_META.online;
  $("me-sub").textContent = state.profile.status || (hub.me?.tag ? "@" + hub.me.tag : pres.label);
  $("me-presence").className = "presence-dot " + pres.dot;
  $("me-presence").title = pres.label;
}

function renderChatHeader() {
  if (state.view === "dm" && state.dmPeer) {
    const f = hub.friends.get(state.dmPeer.uid) || state.dmPeer;
    $("chan-hash").textContent = f.avatar || "💬";
    $("chan-name").textContent = f.name;
    $("chan-topic").textContent = f.online && f.presence !== "invisible"
      ? f.status || PRESENCE_META[f.presence]?.label || "Online"
      : "Offline";
    $("input").placeholder = `Message ${f.name}`;
    return;
  }
  $("chan-hash").textContent = "#";
  const c = state.channels.find((x) => x.id === state.activeChan);
  $("chan-name").textContent = c ? c.name : "";
  $("chan-topic").textContent = c?.topic || "";
  $("input").placeholder = c ? `Message #${c.name}` : "Pick a channel";
}

/* ----------------------------- messages pane ---------------------------- */

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function fmtDay(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}

function renderMessages(scrollToBottom = false) {
  const pane = $("messages");
  const nearBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 80;
  const prevHeight = pane.scrollHeight;
  const prevTop = pane.scrollTop;
  pane.textContent = "";

  const list = state.messages.get(state.activeChan) || [];
  let lastAuthor = null;
  let lastTs = 0;
  let lastDay = "";
  let group = null;

  for (const msg of list) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) {
      pane.appendChild(el("div", "day-divider", fmtDay(msg.ts)));
      lastDay = day;
      lastAuthor = null;
    }
    const sameGroup = lastAuthor === msg.author.userId && msg.ts - lastTs < 5 * 60 * 1000 && !msg.replyTo;
    if (!sameGroup) {
      group = el("div", "msg-group");
      const av = el("div", "mg-avatar", msg.author.avatar);
      av.style.background = msg.author.color;
      av.title = "View profile";
      av.onclick = (e) => {
        e.stopPropagation();
        const known = [...state.members.values()].find((mm) => mm.userId === msg.author.userId);
        openProfile(e.clientX + 12, e.clientY - 40, known || msg.author);
      };
      group.appendChild(av);
      const body = el("div", "mg-body");
      const head = el("div", "mg-head");
      const name = el("span", "mg-name", msg.author.name);
      name.style.color = msg.author.color;
      head.appendChild(name);
      head.appendChild(el("span", "mg-time", fmtTime(msg.ts)));
      body.appendChild(head);
      body.appendChild(el("div", "mg-msgs"));
      group.appendChild(body);
      pane.appendChild(group);
    }
    lastAuthor = msg.author.userId;
    lastTs = msg.ts;
    group.querySelector(".mg-msgs").appendChild(buildMsgNode(msg));
  }

  if (scrollToBottom || nearBottom) {
    pane.scrollTop = pane.scrollHeight;
  } else {
    // Preserve position (e.g. after prepending history).
    pane.scrollTop = prevTop + (pane.scrollHeight - prevHeight);
  }
}

function buildMsgNode(msg) {
  const node = el("div", "msg" + (msg.pending ? " pending" : "") + (mentionsMe(msg) ? " pinged" : ""));
  node.dataset.id = msg.id;
  if (msg.pinned) node.classList.add("is-pinned");

  if (msg.replyTo) {
    const r = el("div", "msg-reply", `↩ ${msg.replyTo.name}: ${msg.replyTo.content}`);
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

  if (state.editingId === msg.id) {
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

  const content = el("div", "msg-content");
  content.innerHTML = renderMarkdown(msg.content);
  content.querySelectorAll(".spoiler").forEach((s) => {
    s.onclick = () => s.classList.add("revealed");
  });
  if (msg.edited) {
    const tag = el("span", "msg-edited", " (edited)");
    content.appendChild(tag);
  }
  node.appendChild(content);

  if (msg.reactions) {
    const row = el("div", "msg-reactions");
    for (const [emoji, users] of Object.entries(msg.reactions)) {
      const btn = el("button", "reaction" + (users.includes(myUserId()) ? " mine" : ""));
      btn.textContent = `${emoji} ${users.length}`;
      btn.title = users.length + " reaction" + (users.length > 1 ? "s" : "");
      btn.onclick = () => wsSend({ type: "react", chanId: msg.chanId, msgId: msg.id, emoji });
      row.appendChild(btn);
    }
    node.appendChild(row);
  }

  if (!msg.pending) {
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
    const pin = el("button", "", "📌");
    pin.title = msg.pinned ? "Unpin" : "Pin to channel";
    pin.onclick = () => wsSend({ type: msg.pinned ? "unpin" : "pin", chanId: msg.chanId, msgId: msg.id });
    actions.appendChild(pin);
    if (msg.author.userId === myUserId()) {
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
    node.appendChild(actions);
  }
  return node;
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
  if (state.historyPending.has(chanId)) return;
  state.historyPending.add(chanId);
  setTimeout(() => state.historyPending.delete(chanId), 8000);
  const msg = { type: "history", chanId };
  if (before) msg.before = before;
  wsSend(msg);
}

function activateChannel(chanId) {
  state.activeChan = chanId;
  state.unread.delete(chanId);
  if (state.realmKind === "dm" && state.dmPeer) hub.markDmRead(state.dmPeer.uid);
  updateTitle();
  clearReply();
  state.editingId = null;
  renderChannels();
  renderChatHeader();
  renderMessages(true);
  // Live messages may have created the cache entry — that is NOT history.
  if (!state.historyLoaded.has(chanId)) requestHistory(chanId);
  $("input").focus();
}

/* ------------------------------ reply state ------------------------------ */

function setReply(msg) {
  state.replyTo = { id: msg.id, name: msg.author.name, content: msg.content.slice(0, 120) };
  $("reply-label").textContent = `Replying to ${msg.author.name}`;
  $("reply-bar").classList.remove("hidden");
  $("input").focus();
}
function clearReply() {
  state.replyTo = null;
  $("reply-bar").classList.add("hidden");
}

/* =============================== voice ui =============================== */

async function joinVoice(chanId) {
  if (state.voiceChan === chanId) return;
  if (state.voiceChan) leaveVoice({ silent: true });
  try {
    await voice.join(chanId);
  } catch {
    return;
  }
  state.voiceChan = chanId;
  wsSend({ type: "voice-join", chanId, muted: voice.muted, deafened: voice.deafened });
  const chan = state.channels.find((c) => c.id === chanId);
  $("vs-channel").textContent =
    state.realmKind === "dm"
      ? `Call with ${state.dmPeer?.name || "a friend"}`
      : `${chan?.name || "voice"} / ${state.meta?.name || ""}`;
  $("voice-status").classList.remove("hidden");
  $("btn-call").classList.toggle("on", true);
  renderChannels();
}

function leaveVoice({ silent } = {}) {
  if (!state.voiceChan) return;
  state.voiceChan = null;
  voice.leave({ silent });
  wsSend({ type: "voice-leave" });
  $("voice-status").classList.add("hidden");
  $("btn-share").classList.remove("on");
  $("btn-call").classList.remove("on");
  clearShareStage();
  renderChannels();
  renderMembers();
}

function addShareTile(key, stream, label) {
  removeShareTile(key);
  const stage = $("share-stage");
  const tile = el("div", "share-tile");
  tile.dataset.share = key;
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  if (key === "me") video.muted = true;
  video.srcObject = stream;
  tile.appendChild(video);
  tile.appendChild(el("div", "share-label", label));
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

function promptModal(title, value, onSave) {
  $("prompt-title").textContent = title;
  const input = $("prompt-input");
  input.value = value;
  showModal("prompt-modal");
  setTimeout(() => input.focus(), 0);
  const save = () => {
    const v = input.value.trim();
    closeModals();
    if (v) onSave(v);
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
    state.view = "server";
    state.realmKind = "guild";
    state.dmPeer = null;
    applyView();
    connect(code, { kind: "create", code, name, icon: jmIcon });
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
  state.view = "server";
  state.realmKind = "guild";
  state.dmPeer = null;
  applyView();
  connect(code, { kind: "join", code });
};
$("jm-code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("jm-join").click();
});

$("add-server-btn").onclick = openJoinModal;

function confirmLeaveServer(s) {
  confirmModal(`Leave ${s.name}?`, "You can rejoin any time with the invite code.", () => {
    state.servers = state.servers.filter((x) => x.code !== s.code);
    store.set("servers", state.servers);
    if (state.currentCode === s.code) {
      disconnect();
      state.currentCode = null;
      if (state.servers.length) {
        connect(state.servers[0].code, { kind: "reopen", code: state.servers[0].code });
      } else {
        renderAll();
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
  $("set-tag").value = hub.me?.tag || state.account?.tag || "";
  $("set-presence").value = state.settings.presence || "online";

  const fxSelect = $("set-fx");
  fxSelect.textContent = "";
  for (const fx of VOICE_FX) {
    const option = el("option", "", `${fx.emoji} ${fx.label}`);
    option.value = fx.id;
    if (fx.id === state.settings.fx) option.selected = true;
    fxSelect.appendChild(option);
  }
  $("set-fx-pitch").value = state.settings.fxPitch;
  $("set-fx-label").textContent = fmtSemis(state.settings.fxPitch);
  $("set-volume").value = state.settings.volume;
  $("set-vol-label").textContent = state.settings.volume + "%";
  populateMics();
}

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
      if (n >= 5) toast("💤 Gorb is out cold. Revive him in Settings if you feel bad.");
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
  reviveMascot();
  toast("Gorb lives.");
};

const fmtSemis = (n) => (n > 0 ? `+${n}` : String(n));

// Applies live — mid-sentence, even — because the shifter always sits in the
// outgoing path and only its pitch parameter moves.
function applyVoiceFx(id, pitch) {
  state.settings.fx = id;
  state.settings.fxPitch = pitch;
  store.set("settings", state.settings);
  voice.setEffect(pitch);
  const preset = VOICE_FX.find((f) => f.id === id);
  $("btn-fx").classList.toggle("on", pitch !== 0);
  $("btn-fx").title = `Voice changer: ${preset ? preset.label : fmtSemis(pitch) + " semitones"}`;
}

$("set-fx").onchange = (e) => {
  const preset = VOICE_FX.find((f) => f.id === e.target.value) || VOICE_FX[0];
  applyVoiceFx(preset.id, preset.semis);
  $("set-fx-pitch").value = preset.semis;
  $("set-fx-label").textContent = fmtSemis(preset.semis);
};
$("set-fx-pitch").oninput = (e) => {
  const pitch = +e.target.value;
  const match = VOICE_FX.find((f) => f.semis === pitch);
  applyVoiceFx(match ? match.id : "custom", pitch);
  $("set-fx-label").textContent = fmtSemis(pitch);
  if (match) $("set-fx").value = match.id;
};

// Quick cycle from the voice panel, for mid-call bits.
$("btn-fx").onclick = () => {
  const i = VOICE_FX.findIndex((f) => f.id === state.settings.fx);
  const next = VOICE_FX[(i + 1) % VOICE_FX.length];
  applyVoiceFx(next.id, next.semis);
  toast(`${next.emoji} Voice: ${next.label}`);
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
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      toast("Notifications blocked — allow them in your browser settings.", true);
      e.target.checked = false;
      return;
    }
  }
  state.settings.notifs = e.target.checked;
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

$("server-header").onclick = () => $("server-menu").classList.toggle("hidden");
$("server-menu").querySelectorAll("button").forEach((b) => {
  b.onclick = () => {
    $("server-menu").classList.add("hidden");
    const act = b.dataset.act;
    if (act === "invite") openInviteModal();
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
input.addEventListener("input", () => {
  autoGrow(input);
  updateAutocomplete();
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

/* ----------------------------- emoji picker ------------------------------ */

let emojiMode = { mode: "input" };
function openEmojiPicker(mode) {
  emojiMode = mode || { mode: "input" };
  const picker = $("emoji-picker");
  if (!picker.childNodes.length) {
    for (const emoji of EMOJIS) {
      const b = el("button", "emoji-btn", emoji);
      b.onclick = () => {
        if (emojiMode.mode === "react") {
          wsSend({ type: "react", chanId: emojiMode.msg.chanId, msgId: emojiMode.msg.id, emoji });
          picker.classList.add("hidden");
        } else {
          insertAtCursor(input, emoji);
          input.focus();
        }
      };
      picker.appendChild(b);
    }
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
    voice.stopShare();
  } else {
    await voice.startShare();
    if (voice.shareStream) {
      $("btn-share").classList.add("on");
      addShareTile("me", voice.shareStream, "Your screen");
    }
  }
};
$("btn-members").onclick = () => $("app").classList.toggle("members-hidden");

// A DM's "call" is just joining the DM's voice channel.
$("btn-call").onclick = () => {
  const chan = state.channels.find((c) => c.type === "voice");
  if (!chan) return;
  if (state.voiceChan === chan.id) leaveVoice();
  else joinVoice(chan.id);
};

/* ========================== home / friends wiring ========================= */

$("home-btn").onclick = goHome;
$("dm-friends-btn").onclick = goHome;
$("dm-add-btn").onclick = () => {
  goHome();
  state.fvTab = "add";
  renderFriendsView();
};
document.querySelectorAll("#fv-tabs button").forEach((b) => {
  b.onclick = () => {
    state.fvTab = b.dataset.tab;
    renderFriendsView();
  };
});

/* =========================== keyboard shortcuts ========================== */

window.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSwitcher();
  } else if (mod && e.key.toLowerCase() === "f" && state.view !== "home") {
    e.preventDefault();
    openSearch();
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
    body.innerHTML = renderMarkdown(msg.content);
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
    body.innerHTML = renderMarkdown(msg.content);
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
    items.push({ icon: s.icon, label: s.name, sub: "Server", act: () => goServer(s.code) });
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
    items.push({ icon: f.avatar, label: f.name, sub: `@${f.tag} · Direct Message`, act: () => openDm(f.uid) });
  }
  items.push({ icon: "👥", label: "Friends", sub: "Home", act: goHome });
  const needle = q.trim().toLowerCase();
  if (!needle) return items.slice(0, 12);
  return items
    .filter((i) => (i.label + " " + i.sub).toLowerCase().includes(needle))
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

function openProfile(x, y, person) {
  const pop = $("profile-pop");
  pop.textContent = "";
  const uid = person.uid || null;
  const friend = uid ? hub.friends.get(uid) : null;

  const banner = el("div", "pp-banner");
  banner.style.background = person.color;
  pop.appendChild(banner);
  const av = el("div", "pp-avatar", person.avatar);
  av.style.background = person.color;
  pop.appendChild(av);

  const body = el("div", "pp-body");
  const name = el("div", "pp-name", person.name);
  name.style.color = person.color;
  body.appendChild(name);
  if (person.tag) body.appendChild(el("div", "pp-tag", "@" + person.tag));
  if (person.status) body.appendChild(el("div", "pp-status", person.status));
  if (person.voice) {
    const chan = state.channels.find((c) => c.id === person.voice.chanId);
    body.appendChild(el("div", "pp-status", `🔊 In ${chan?.name || "voice"}`));
  }

  const acts = el("div", "pp-actions");
  const isMe = person.sid ? person.sid === state.me?.sid : uid && uid === hub.me?.uid;
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

function fireSound(id) {
  if (!SOUNDBOARD.some((s) => s.id === id)) return;
  playSound(id, (state.settings.volume || 100) / 100);
  if (state.voiceChan) wsSend({ type: "sound", sound: id });
  else toast("Nobody heard that — join a voice channel first.", true);
}

function renderSoundboard() {
  const board = $("soundboard");
  if (board.childNodes.length) return;
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
  board.appendChild(grid);
  board.appendChild(el("div", "sb-foot", "Everyone in your voice channel hears it. Use responsibly. Or don't."));
}

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
    const items = EMOJI_NAMES.filter(([name]) => name.includes(q))
      .slice(0, 8)
      .map(([name, emoji]) => ({ icon: emoji, label: `:${name}:`, sub: "", insert: emoji + " ", from }));
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
    row.appendChild(el("span", "ac-icon", item.icon));
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

/* ============================ focus / unload ============================= */

window.addEventListener("focus", () => {
  if (state.activeChan) {
    state.unread.delete(state.activeChan);
    updateTitle();
    renderChannels();
  }
});
window.addEventListener("beforeunload", () => {
  if (state.ws) {
    state.ws.onclose = null;
    state.ws.close();
  }
});

/* ================================= boot ================================== */

function afterProfileReady() {
  $("app").classList.remove("hidden");
  renderMe();
  hub.connect(); // friends + DMs stay live regardless of which server we're in
  if (state.settings.mascot) launchMascot();
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get("join") || "").toUpperCase();
  if (joinCode && /^[A-Z0-9]{4,12}$/.test(joinCode)) {
    history.replaceState(null, "", location.pathname);
    state.view = "server";
    connect(joinCode, { kind: "join", code: joinCode });
    return;
  }
  const last = store.get("lastServer", null);
  const target = state.servers.find((s) => s.code === last) || state.servers[0];
  if (target) {
    state.view = "server";
    connect(target.code, { kind: "reopen", code: target.code });
  } else {
    state.view = "home";
    renderAll();
    renderFriendsView();
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
applyVoiceFx(state.settings.fx, state.settings.fxPitch); // restore the saved voice

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
