// Concord — Discord-knockoff chat/voice backend.
// One ConcordServer Durable Object per "server" (guild). It owns channels,
// message history, live presence, voice-channel state, and relays WebRTC
// signaling between peers. Static client comes from the [assets] binding.

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const MSG_CAP = 300; // messages kept per channel
const HISTORY_PAGE = 60;
const MAX_REACTION_KEYS = 20; // distinct emoji per message

// Everything a client can spam goes through the rate limiter. `rtc` is
// exempt (ICE candidates legitimately burst) and `hello` runs once.
const RATE_LIMITED = new Set([
  "msg", "react", "edit", "delete", "typing", "history", "set-profile",
  "create-channel", "update-channel", "delete-channel", "update-server",
  "voice-join", "voice-leave", "voice-state",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("server") || "").toUpperCase();
      if (!CODE_RE.test(code)) {
        return new Response("bad server code", { status: 400 });
      }
      const stub = env.SERVERS.get(env.SERVERS.idFromName(code));
      return stub.fetch(request);
    }

    if (url.pathname === "/api/new-code") {
      return Response.json({ code: newServerCode() });
    }

    return env.ASSETS.fetch(request);
  },
};

// Unambiguous alphabet: no 0/O/1/I/L.
function newServerCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let code = "";
  for (const b of bytes) code += alphabet[b % alphabet.length];
  return code;
}

const msgKey = (chanId, seq) => `msg:${chanId}:${String(seq).padStart(8, "0")}`;

export class ConcordServer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> session object
    this.rate = new Map(); // sid -> {count, windowStart}
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
    // Rebuild the session map after a hibernation wake-up.
    for (const ws of this.state.getWebSockets()) {
      const session = ws.deserializeAttachment();
      if (session) this.sessions.set(ws, session);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/ws" || request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    let meta = await this.state.storage.get("meta");
    if (!meta) {
      if (url.searchParams.get("create") !== "1") {
        return new Response("no such server", { status: 404 });
      }
      meta = {
        name: cleanText(url.searchParams.get("name"), 40) || "New Server",
        icon: cleanText(url.searchParams.get("icon"), 8) || "🎮",
        createdAt: Date.now(),
      };
      const channels = [
        { id: "c1", type: "text", name: "general", topic: "Talk about whatever" },
        { id: "c2", type: "text", name: "random", topic: "Off topic" },
        { id: "c3", type: "voice", name: "General" },
        { id: "c4", type: "voice", name: "Gaming" },
      ];
      await this.state.storage.put({ meta, channels, nextChanId: 5 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = { sid: crypto.randomUUID().slice(0, 8), joined: false };
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  session(ws) {
    let s = this.sessions.get(ws);
    if (!s) {
      s = ws.deserializeAttachment() || { sid: crypto.randomUUID().slice(0, 8), joined: false };
      this.sessions.set(ws, s);
    }
    return s;
  }

  saveSession(ws, s) {
    ws.serializeAttachment(s);
    this.sessions.set(ws, s);
  }

  members() {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.joined) out.push(publicMember(s));
    }
    return out;
  }

  broadcast(payload, exceptWs = null) {
    const raw = JSON.stringify(payload);
    for (const [ws, s] of this.sessions) {
      if (!s.joined || ws === exceptWs) continue;
      try {
        ws.send(raw);
      } catch {
        // socket already dying; close handler will clean up
      }
    }
  }

  sendTo(sid, payload) {
    const raw = JSON.stringify(payload);
    for (const [ws, s] of this.sessions) {
      if (s.sid !== sid || !s.joined) continue;
      try {
        ws.send(raw);
        return true;
      } catch {
        return false; // dying socket — let the sender get rtc-gone
      }
    }
    return false;
  }

  overRate(sid) {
    const now = Date.now();
    let r = this.rate.get(sid);
    if (!r || now - r.windowStart > 5000) {
      r = { count: 0, windowStart: now };
      this.rate.set(sid, r);
    }
    r.count++;
    return r.count > 30; // 30 messages per 5s is plenty for humans
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 32_000) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const s = this.session(ws);

    try {
      await this.dispatch(ws, s, m);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: "error", error: String(err?.message || err) }));
      } catch {}
    }
  }

  async dispatch(ws, s, m) {
    const storage = this.state.storage;
    if (RATE_LIMITED.has(m.type) && this.overRate(s.sid)) return;

    switch (m.type) {
      case "hello": {
        s.userId = cleanText(m.userId, 40) || crypto.randomUUID();
        s.name = cleanText(m.name, 32) || "Wumpus";
        s.color = cleanColor(m.color);
        s.avatar = cleanText(m.avatar, 8) || "🙂";
        s.status = cleanText(m.status, 60);
        s.voice = null;
        s.joined = true;
        this.saveSession(ws, s);

        const [meta, channels] = await Promise.all([
          storage.get("meta"),
          storage.get("channels"),
        ]);
        ws.send(
          JSON.stringify({
            type: "welcome",
            you: publicMember(s),
            meta,
            channels,
            members: this.members(),
          })
        );
        this.broadcast({ type: "member-join", member: publicMember(s) }, ws);
        break;
      }

      case "set-profile": {
        if (!s.joined) return;
        if (m.name !== undefined) s.name = cleanText(m.name, 32) || s.name;
        if (m.color !== undefined) s.color = cleanColor(m.color);
        if (m.avatar !== undefined) s.avatar = cleanText(m.avatar, 8) || s.avatar;
        if (m.status !== undefined) s.status = cleanText(m.status, 60);
        this.saveSession(ws, s);
        this.broadcast({ type: "member-update", member: publicMember(s) });
        break;
      }

      case "msg": {
        if (!s.joined) return;
        const content = cleanText(m.content, 4000);
        if (!content) return;
        const chanId = String(m.chanId || "");
        const channels = (await storage.get("channels")) || [];
        if (!channels.some((c) => c.id === chanId && c.type === "text")) return;

        const seqKey = `chanseq:${chanId}`;
        const seq = ((await storage.get(seqKey)) || 0) + 1;
        const msg = {
          id: seq,
          chanId,
          author: { userId: s.userId, name: s.name, color: s.color, avatar: s.avatar },
          content,
          ts: Date.now(),
        };
        if (m.replyTo) {
          const parent = await storage.get(msgKey(chanId, Number(m.replyTo)));
          if (parent) {
            msg.replyTo = {
              id: parent.id,
              name: parent.author.name,
              content: parent.content.slice(0, 120),
            };
          }
        }
        const writes = { [seqKey]: seq, [msgKey(chanId, seq)]: msg };
        await storage.put(writes);
        if (seq > MSG_CAP) await storage.delete(msgKey(chanId, seq - MSG_CAP));
        this.broadcast({ type: "msg", msg }, ws);
        // The author instead gets an ack carrying the nonce so their
        // optimistic bubble resolves (other tabs of the author still get msg).
        ws.send(JSON.stringify({ type: "msg-ack", nonce: m.nonce, msg }));
        break;
      }

      case "history": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const opts = {
          prefix: `msg:${chanId}:`,
          reverse: true,
          limit: HISTORY_PAGE,
        };
        if (m.before) opts.end = msgKey(chanId, Number(m.before));
        const map = await storage.list(opts);
        const messages = [...map.values()].reverse();
        ws.send(JSON.stringify({ type: "history", chanId, messages, before: m.before || null }));
        break;
      }

      case "edit": {
        if (!s.joined) return;
        const key = msgKey(String(m.chanId || ""), Number(m.msgId));
        const msg = await storage.get(key);
        if (!msg || msg.author.userId !== s.userId) return;
        const content = cleanText(m.content, 4000);
        if (!content) return;
        msg.content = content;
        msg.edited = Date.now();
        await storage.put(key, msg);
        this.broadcast({ type: "msg-edit", msg });
        break;
      }

      case "delete": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const key = msgKey(chanId, Number(m.msgId));
        const msg = await storage.get(key);
        if (!msg || msg.author.userId !== s.userId) return;
        await storage.delete(key);
        this.broadcast({ type: "msg-delete", chanId, msgId: msg.id });
        break;
      }

      case "react": {
        if (!s.joined) return;
        const emoji = cleanText(m.emoji, 8);
        if (!emoji) return;
        const key = msgKey(String(m.chanId || ""), Number(m.msgId));
        const msg = await storage.get(key);
        if (!msg) return;
        msg.reactions = msg.reactions || {};
        if (!msg.reactions[emoji] && Object.keys(msg.reactions).length >= MAX_REACTION_KEYS) return;
        const users = msg.reactions[emoji] || [];
        const i = users.indexOf(s.userId);
        if (i >= 0) users.splice(i, 1);
        else if (users.length < 50) users.push(s.userId);
        if (users.length) msg.reactions[emoji] = users;
        else delete msg.reactions[emoji];
        if (!Object.keys(msg.reactions).length) delete msg.reactions;
        await storage.put(key, msg);
        this.broadcast({ type: "msg-react", chanId: msg.chanId, msgId: msg.id, reactions: msg.reactions || {} });
        break;
      }

      case "typing": {
        if (!s.joined) return;
        this.broadcast(
          { type: "typing", chanId: String(m.chanId || ""), sid: s.sid, name: s.name },
          ws
        );
        break;
      }

      case "create-channel": {
        if (!s.joined) return;
        const name = cleanChannelName(m.name);
        const type = m.chanType === "voice" ? "voice" : "text";
        if (!name) return;
        const channels = (await storage.get("channels")) || [];
        if (channels.length >= 50) return;
        const nextChanId = ((await storage.get("nextChanId")) || 100) + 1;
        const chan = { id: `c${nextChanId}`, type, name };
        if (type === "text") chan.topic = cleanText(m.topic, 100);
        channels.push(chan);
        await storage.put({ channels, nextChanId });
        this.broadcast({ type: "channel-create", channel: chan });
        break;
      }

      case "update-channel": {
        if (!s.joined) return;
        const channels = (await storage.get("channels")) || [];
        const chan = channels.find((c) => c.id === m.chanId);
        if (!chan) return;
        if (m.name !== undefined) chan.name = cleanChannelName(m.name) || chan.name;
        if (m.topic !== undefined && chan.type === "text") chan.topic = cleanText(m.topic, 100);
        await storage.put("channels", channels);
        this.broadcast({ type: "channel-update", channel: chan });
        break;
      }

      case "delete-channel": {
        if (!s.joined) return;
        let channels = (await storage.get("channels")) || [];
        const chan = channels.find((c) => c.id === m.chanId);
        if (!chan) return;
        if (channels.filter((c) => c.type === chan.type).length <= 1) return; // keep at least one of each
        channels = channels.filter((c) => c.id !== m.chanId);
        await storage.put("channels", channels);
        // Purge that channel's stored messages.
        const keys = await storage.list({ prefix: `msg:${m.chanId}:` });
        await storage.delete([...keys.keys(), `chanseq:${m.chanId}`]);
        this.broadcast({ type: "channel-delete", chanId: m.chanId });
        break;
      }

      case "update-server": {
        if (!s.joined) return;
        const meta = await storage.get("meta");
        if (m.name !== undefined) meta.name = cleanText(m.name, 40) || meta.name;
        if (m.icon !== undefined) meta.icon = cleanText(m.icon, 8) || meta.icon;
        await storage.put("meta", meta);
        this.broadcast({ type: "server-meta", meta });
        break;
      }

      case "voice-join": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const channels = (await storage.get("channels")) || [];
        if (!channels.some((c) => c.id === chanId && c.type === "voice")) return;
        s.voice = { chanId, muted: !!m.muted, deafened: !!m.deafened, sharing: false };
        this.saveSession(ws, s);
        // Tell the joiner who is already in the room; the joiner initiates offers.
        const peers = [];
        for (const other of this.sessions.values()) {
          if (other.joined && other.sid !== s.sid && other.voice?.chanId === chanId) {
            peers.push(other.sid);
          }
        }
        ws.send(JSON.stringify({ type: "voice-peers", chanId, peers }));
        this.broadcast({ type: "member-update", member: publicMember(s) });
        break;
      }

      case "voice-leave": {
        if (!s.joined || !s.voice) return;
        s.voice = null;
        this.saveSession(ws, s);
        this.broadcast({ type: "member-update", member: publicMember(s) });
        break;
      }

      case "voice-state": {
        if (!s.joined || !s.voice) return;
        if (m.muted !== undefined) s.voice.muted = !!m.muted;
        if (m.deafened !== undefined) s.voice.deafened = !!m.deafened;
        if (m.sharing !== undefined) s.voice.sharing = !!m.sharing;
        this.saveSession(ws, s);
        this.broadcast({ type: "member-update", member: publicMember(s) });
        break;
      }

      case "rtc": {
        if (!s.joined || !s.voice) return;
        const to = String(m.to || "");
        let target = null;
        for (const other of this.sessions.values()) {
          if (other.sid === to && other.joined) {
            target = other;
            break;
          }
        }
        // Voice channels are separate rooms — only relay within the same one.
        const sameRoom = target && target.voice?.chanId === s.voice.chanId;
        const delivered = sameRoom && this.sendTo(to, { type: "rtc", from: s.sid, data: m.data });
        if (!delivered) {
          ws.send(JSON.stringify({ type: "rtc-gone", sid: to }));
        }
        break;
      }
    }
  }

  async webSocketClose(ws) {
    this.dropSession(ws);
  }

  async webSocketError(ws) {
    this.dropSession(ws);
  }

  dropSession(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (s) this.rate.delete(s.sid);
    if (s?.joined) {
      this.broadcast({ type: "member-leave", sid: s.sid });
    }
    try {
      ws.close(1011, "session dropped");
    } catch {}
  }
}

function publicMember(s) {
  return {
    sid: s.sid,
    userId: s.userId,
    name: s.name,
    color: s.color,
    avatar: s.avatar,
    status: s.status || "",
    voice: s.voice || null,
  };
}

function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max).trim();
}

function cleanChannelName(v) {
  if (typeof v !== "string") return "";
  return v
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .slice(0, 32);
}

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
function cleanColor(v) {
  return typeof v === "string" && COLOR_RE.test(v) ? v.toLowerCase() : "#5865f2";
}
