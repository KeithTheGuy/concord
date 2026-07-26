// Concord client — state, WebSocket protocol, and all UI.
import { VoiceEngine } from "./voice.js";
import { PRANKS, runPrank, installPrankStyles } from "./prank.js";

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
  settings: Object.assign(
    { micId: "", ptt: false, pttKey: "ControlLeft", sounds: true, volume: 100, notifs: false, gremlin: true },
    store.get("settings", {})
  ),
  servers: store.get("servers", []), // [{code, name, icon}]
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
  }
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    state.wsState = "open";
    wsSend({
      type: "hello",
      userId: state.profile.userId,
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
      state.meta = m.meta;
      state.channels = m.channels;
      state.members = new Map(m.members.map((mm) => [mm.sid, mm]));
      startPing();

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

function notifyIfNeeded(msg) {
  const mine = msg.author.userId === state.profile.userId;
  if (mine) return;
  // "Inactive" = other channel, tab hidden, OR window visible but not
  // focused (second monitor while gaming — the whole point of notifications).
  const inactive = msg.chanId !== state.activeChan || document.hidden || !document.hasFocus();
  if (inactive) {
    if (msg.chanId !== state.activeChan) {
      state.unread.set(msg.chanId, (state.unread.get(msg.chanId) || 0) + 1);
      renderChannels();
    }
    if (state.settings.sounds) voice.playCue("ping");
    updateTitle();
    desktopNotify(msg);
  }
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
  const n = totalUnread();
  document.title = (n ? `(${n}) ` : "") + "Concord";
}

function sendCurrentMessage() {
  const input = $("input");
  const content = input.value.trim();
  if (!content || !state.activeChan) return;
  const nonce = "n" + Math.random().toString(36).slice(2);
  const optimistic = {
    id: "pending-" + nonce,
    chanId: state.activeChan,
    author: { userId: state.profile.userId, name: state.profile.name, color: state.profile.color, avatar: state.profile.avatar },
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
  state.lastTypingSent = 0; // sending ends "typing"; next keystroke signals fresh
  input.value = "";
  autoGrow(input);
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
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => codeBlocks[+i]);
  return t;
}

/* =============================== rendering ============================== */

function renderAll() {
  renderServerRail();
  $("server-name").textContent = state.meta?.name || "Concord";
  renderChannels();
  renderMembers();
  renderMe();
}

function renderServerRail() {
  const list = $("server-list");
  list.textContent = "";
  for (const s of state.servers) {
    const b = el("div", "server-bubble" + (s.code === state.currentCode ? " active" : ""), s.icon);
    b.title = s.name;
    b.onclick = () => {
      if (s.code !== state.currentCode) connect(s.code, { kind: "reopen", code: s.code });
    };
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
  $("me-sub").textContent = state.profile.status || "online";
}

function renderChatHeader() {
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
  const node = el("div", "msg" + (msg.pending ? " pending" : ""));
  node.dataset.id = msg.id;

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
  if (msg.edited) {
    const tag = el("span", "msg-edited", " (edited)");
    content.appendChild(tag);
  }
  node.appendChild(content);

  if (msg.reactions) {
    const row = el("div", "msg-reactions");
    for (const [emoji, users] of Object.entries(msg.reactions)) {
      const btn = el("button", "reaction" + (users.includes(state.profile.userId) ? " mine" : ""));
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
    if (msg.author.userId === state.profile.userId) {
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

function activateChannel(chanId) {
  state.activeChan = chanId;
  state.unread.delete(chanId);
  updateTitle();
  clearReply();
  state.editingId = null;
  renderChannels();
  renderChatHeader();
  renderMessages(true);
  // Live messages may have created the cache entry — that is NOT history.
  if (!state.historyLoaded.has(chanId) && !state.historyPending.has(chanId)) {
    state.historyPending.add(chanId);
    wsSend({ type: "history", chanId });
  }
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
  $("vs-channel").textContent = `${chan?.name || "voice"} / ${state.meta?.name || ""}`;
  $("voice-status").classList.remove("hidden");
  renderChannels();
}

function leaveVoice({ silent } = {}) {
  if (!state.voiceChan) return;
  state.voiceChan = null;
  voice.leave({ silent });
  wsSend({ type: "voice-leave" });
  $("voice-status").classList.add("hidden");
  $("btn-share").classList.remove("on");
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

function openGremlinModal() {
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
$("btn-gremlin").onclick = openGremlinModal;

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
  wsSend({
    type: "set-profile",
    name: state.profile.name,
    color: state.profile.color,
    avatar: state.profile.avatar,
    status: state.profile.status,
  });
  if (micChanged) voice.setMicDevice();
  closeModals();
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
  const now = Date.now();
  if (input.value && now - state.lastTypingSent > 4000 && state.activeChan) {
    state.lastTypingSent = now;
    wsSend({ type: "typing", chanId: state.activeChan });
  }
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrentMessage();
  } else if (e.key === "Escape") {
    clearReply();
  } else if (e.key === "ArrowUp" && !input.value) {
    // Up-arrow edits your last message, like the real thing.
    const list = state.messages.get(state.activeChan) || [];
    const own = [...list].reverse().find((x) => x.author.userId === state.profile.userId && !x.pending);
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
    if (oldest) {
      state.historyPending.add(state.activeChan);
      wsSend({ type: "history", chanId: state.activeChan, before: oldest.id });
    }
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
  const params = new URLSearchParams(location.search);
  const joinCode = (params.get("join") || "").toUpperCase();
  if (joinCode && /^[A-Z0-9]{4,12}$/.test(joinCode)) {
    history.replaceState(null, "", location.pathname);
    connect(joinCode, { kind: "join", code: joinCode });
    return;
  }
  const last = store.get("lastServer", null);
  const target = state.servers.find((s) => s.code === last) || state.servers[0];
  if (target) {
    connect(target.code, { kind: "reopen", code: target.code });
  } else {
    renderAll();
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

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
