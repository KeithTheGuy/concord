// Concord — Discord-knockoff chat/voice backend.
// One ConcordServer Durable Object per "server" (guild). It owns channels,
// message history, live presence, voice-channel state, and relays WebRTC
// signaling between peers. Static client comes from the [assets] binding.
//
// A single ConcordHub Durable Object (see bottom) owns the *global* layer that
// can't live inside one server: accounts, friend tags, the friend graph, and
// the secret code for each DM. A DM is just a ConcordServer whose code only
// the two friends know, which is what makes DM voice calls free.

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const MSG_CAP = 300; // messages kept per channel
const HISTORY_PAGE = 60;
const MAX_REACTION_KEYS = 20; // distinct emoji per message
const MAX_PINS = 50;
const SEARCH_SCAN = 1200; // messages examined per search
const SEARCH_HITS = 40;
const SOUNDS = new Set([
  "airhorn", "bruh", "vine", "sad", "yeet", "rimshot", "bonk", "quack",
  "wow", "fart", "applause", "windows",
]);
const PRANK_COOLDOWN_MS = 15_000; // per pranker, keeps Gremlin Mode funny not fatal
// Per-VICTIM floor. The sender's cooldown can always be dodged by minting a
// new identity (nothing stops a client opening sockets), so the only bound an
// attacker cannot rotate is one keyed on the person receiving the prank.
const PRANK_VICTIM_FLOOR_MS = 5_000;
const AUTH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // forget dormant identities
const AUTH_CAP = 300; // ceiling on stored identities per server
const AUTH_SWEEP_EVERY = 25; // new identities between sweeps
const PRANK_KINDS = new Set([
  "earthquake", "upsidedown", "vaporwave", "emojirain", "fakekick", "airhorn",
  "drunk", "butterfingers", "cursedcursor", "bluescreen", "tiny", "spin",
  "colemode",
]);

// Everything a client can spam goes through the rate limiter. `rtc` is
// exempt (ICE candidates legitimately burst) and `hello` runs once.
const RATE_LIMITED = new Set([
  "msg", "react", "edit", "delete", "typing", "history", "set-profile",
  "create-channel", "update-channel", "delete-channel", "update-server",
  "voice-join", "voice-leave", "voice-state", "prank", "hello",
  "pin", "unpin", "pins", "search", "sound",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      // The hub is a singleton; everything else is one DO per server code.
      if (url.searchParams.get("hub") === "1") {
        return env.HUB.get(env.HUB.idFromName("hub")).fetch(request);
      }
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
    this.prankAt = new Map(); // userId -> last prank sent (survives reconnects)
    this.prankedAt = new Map(); // userId -> last prank received
    this.soundAt = new Map(); // userId -> last soundboard clip
    this.authWrites = 0;
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
      const isDm = url.searchParams.get("kind") === "dm";
      meta = {
        name: cleanText(url.searchParams.get("name"), 40) || "New Server",
        icon: cleanText(url.searchParams.get("icon"), 8) || "🎮",
        kind: isDm ? "dm" : "guild",
        createdAt: Date.now(),
      };
      // A DM is a one-room server: one text channel and one voice channel so
      // "call" is the same code path as joining voice anywhere else.
      const channels = isDm
        ? [
            { id: "c1", type: "text", name: "direct", topic: "" },
            { id: "c2", type: "voice", name: "Call" },
          ]
        : [
            { id: "c1", type: "text", name: "general", topic: "Talk about whatever" },
            { id: "c2", type: "text", name: "random", topic: "Off topic" },
            { id: "c3", type: "voice", name: "General" },
            { id: "c4", type: "voice", name: "Gaming" },
          ];
      await this.state.storage.put({ meta, channels, nextChanId: channels.length + 1 });
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

  prunePranks(now) {
    for (const [userId, at] of this.prankAt) {
      if (now - at > PRANK_COOLDOWN_MS) this.prankAt.delete(userId);
    }
    for (const [key, at] of this.prankedAt) {
      if (now - at > PRANK_VICTIM_FLOOR_MS) this.prankedAt.delete(key);
    }
    for (const [key, at] of this.soundAt) {
      if (now - at > 10_000) this.soundAt.delete(key);
    }
  }

  victimKey(session) {
    return session.userId || session.sid;
  }

  victimShielded(session, now) {
    return now - (this.prankedAt.get(this.victimKey(session)) || 0) < PRANK_VICTIM_FLOOR_MS;
  }

  // Identities are stored per server and never expire on their own, so sweep
  // dormant ones. Anyone currently connected is always kept.
  async sweepAuth(now) {
    const rows = await this.state.storage.list({ prefix: "auth:" });
    const live = new Set();
    for (const s of this.sessions.values()) {
      if (s.userId) live.add(`auth:${s.userId}`);
    }
    const entries = [];
    for (const [key, value] of rows) {
      if (live.has(key)) continue;
      entries.push([key, typeof value === "string" ? 0 : value?.at || 0]);
    }
    const doomed = entries.filter(([, at]) => now - at > AUTH_TTL_MS).map(([k]) => k);
    const remaining = entries.length - doomed.length;
    if (remaining > AUTH_CAP) {
      const dead = new Set(doomed);
      const rest = entries.filter(([k]) => !dead.has(k)).sort((a, b) => a[1] - b[1]);
      for (const [key] of rest.slice(0, remaining - AUTH_CAP)) doomed.push(key);
    }
    if (doomed.length) await this.state.storage.delete(doomed);
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
        // Identity is claimed exactly once per connection. Without this a
        // client could re-hello on a live socket to assume another member's
        // userId (their messages, their prank cooldown) at will.
        if (s.joined) return;

        // A userId is owned by whoever first claimed it here, proven by a
        // server-issued token. Present the wrong token and you get a fresh
        // identity instead of someone else's.
        const claimed = cleanText(m.userId, 40);
        const presented = cleanText(m.token, 64);
        const tokenOf = (row) => (typeof row === "string" ? row : row?.token);
        let userId = claimed;
        if (userId) {
          const owner = tokenOf(await storage.get(`auth:${userId}`));
          if (owner && owner !== presented) userId = "";
        }
        if (!userId) userId = crypto.randomUUID();
        let token = tokenOf(await storage.get(`auth:${userId}`));
        const isNewIdentity = !token;
        if (isNewIdentity) token = crypto.randomUUID();
        // `at` doubles as last-seen so dormant identities can be swept.
        await storage.put(`auth:${userId}`, { token, at: Date.now() });
        if (isNewIdentity && ++this.authWrites % AUTH_SWEEP_EVERY === 0) {
          await this.sweepAuth(Date.now());
        }

        s.userId = userId;
        s.token = token;
        s.name = cleanText(m.name, 32) || "Wumpus";
        s.color = cleanColor(m.color);
        s.avatar = cleanText(m.avatar, 8) || "🙂";
        s.status = cleanText(m.status, 60);
        // Self-reported hub tag, shown in the member list so you can add
        // someone as a friend without asking them to type it out. The hub
        // still validates the real owner when the request is actually sent.
        s.tag = cleanText(m.tag, 20).toLowerCase();
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
            token: s.token, // proves this userId is ours on future connects
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
        if (msg.pinned) {
          const idxKey = `pins:${chanId}`;
          const ids = ((await storage.get(idxKey)) || []).filter((id) => id !== msg.id);
          await storage.put(idxKey, ids);
        }
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

      // Pins live on the message itself (so history carries the flag) and in a
      // per-channel index (so the pin list doesn't have to scan the channel).
      case "pin":
      case "unpin": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const key = msgKey(chanId, Number(m.msgId));
        const msg = await storage.get(key);
        if (!msg) return;
        const idxKey = `pins:${chanId}`;
        const ids = (await storage.get(idxKey)) || [];
        const at = ids.indexOf(msg.id);
        if (m.type === "pin") {
          if (at >= 0) return;
          if (ids.length >= MAX_PINS) {
            ws.send(JSON.stringify({ type: "error", error: `Only ${MAX_PINS} pins per channel. Unpin something.` }));
            return;
          }
          ids.push(msg.id);
          msg.pinned = true;
        } else {
          if (at < 0) return;
          ids.splice(at, 1);
          delete msg.pinned;
        }
        await storage.put({ [key]: msg, [idxKey]: ids });
        this.broadcast({ type: "msg-pin", chanId, msgId: msg.id, pinned: m.type === "pin", by: s.name });
        break;
      }

      case "pins": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const ids = (await storage.get(`pins:${chanId}`)) || [];
        const rows = await Promise.all(ids.map((id) => storage.get(msgKey(chanId, id))));
        const messages = rows.filter(Boolean);
        // Pinned messages age out of the 300-message window; drop the stragglers.
        if (messages.length !== ids.length) {
          await storage.put(`pins:${chanId}`, messages.map((x) => x.id));
        }
        ws.send(JSON.stringify({ type: "pins", chanId, messages }));
        break;
      }

      case "search": {
        if (!s.joined) return;
        const q = cleanText(m.q, 100).toLowerCase();
        if (q.length < 2) return;
        const scope = String(m.chanId || "");
        const channels = (await storage.get("channels")) || [];
        const targets = scope
          ? channels.filter((c) => c.id === scope && c.type === "text")
          : channels.filter((c) => c.type === "text");
        const hits = [];
        let scanned = 0;
        for (const c of targets) {
          if (hits.length >= SEARCH_HITS || scanned >= SEARCH_SCAN) break;
          const rows = await storage.list({ prefix: `msg:${c.id}:`, reverse: true, limit: SEARCH_SCAN - scanned });
          for (const msg of rows.values()) {
            scanned++;
            if (msg.content.toLowerCase().includes(q)) {
              hits.push({ ...msg, chanName: c.name });
              if (hits.length >= SEARCH_HITS) break;
            }
          }
        }
        ws.send(JSON.stringify({ type: "search-results", q: m.q, chanId: scope, hits, truncated: hits.length >= SEARCH_HITS }));
        break;
      }

      // Soundboard: everyone in the sender's voice channel hears it. Voice is
      // peer-to-peer, so the clip itself is synthesized locally — this only
      // relays *which* sound to play, and only to people in the same room.
      case "sound": {
        if (!s.joined || !s.voice) return;
        const sound = cleanText(m.sound, 20);
        if (!SOUNDS.has(sound)) return;
        const now = Date.now();
        const last = this.soundAt.get(s.userId) || 0;
        if (now - last < 2000) return; // one clip per 2s per person
        this.soundAt.set(s.userId, now);
        for (const [sock, other] of this.sessions) {
          if (!other.joined || other.voice?.chanId !== s.voice.chanId) continue;
          try {
            sock.send(JSON.stringify({ type: "sound", sound, name: s.name, sid: s.sid }));
          } catch {}
        }
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
        await storage.delete([...keys.keys(), `chanseq:${m.chanId}`, `pins:${m.chanId}`]);
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
        s.voice = { chanId, muted: !!m.muted, deafened: !!m.deafened, sharing: false, shareKind: null };
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
        // "screen" or "camera" — one outgoing video track each, so this tells
        // the other clients how to label the tile.
        if (m.shareKind !== undefined) {
          s.voice.shareKind = m.shareKind === "camera" ? "camera" : m.shareKind === "screen" ? "screen" : null;
        }
        this.saveSession(ws, s);
        this.broadcast({ type: "member-update", member: publicMember(s) });
        break;
      }

      // Gremlin Mode: relay a purely cosmetic, self-expiring prank. The
      // victim's client decides whether to run it and always sees who sent it.
      case "prank": {
        if (!s.joined) return;
        const kind = cleanText(m.kind, 20);
        if (!PRANK_KINDS.has(kind)) return;

        const now = Date.now();
        // Keyed on userId, not sid: reconnecting or opening a second tab
        // must not hand you a fresh cooldown.
        const last = this.prankAt.get(s.userId) || 0;
        const waited = now - last;
        if (waited < PRANK_COOLDOWN_MS) {
          ws.send(
            JSON.stringify({
              type: "prank-cooldown",
              seconds: Math.ceil((PRANK_COOLDOWN_MS - waited) / 1000),
            })
          );
          return;
        }

        const payload = { type: "pranked", from: s.sid, name: s.name, kind };
        const raw = JSON.stringify(payload);
        const to = String(m.to || "");
        let delivered = 0;

        if (to === "*") {
          for (const [sock, other] of this.sessions) {
            if (!other.joined || sock === ws || this.victimShielded(other, now)) continue;
            try {
              sock.send(raw);
              this.prankedAt.set(this.victimKey(other), now);
              delivered++;
            } catch {}
          }
          if (!delivered) {
            ws.send(JSON.stringify({ type: "prank-shielded" }));
            return;
          }
        } else {
          let target = null;
          let targetWs = null;
          for (const [sock, other] of this.sessions) {
            if (other.sid === to && other.joined) {
              target = other;
              targetWs = sock;
              break;
            }
          }
          if (!target) {
            // Target vanished — say so and don't charge them the cooldown.
            ws.send(JSON.stringify({ type: "prank-missed" }));
            return;
          }
          if (this.victimShielded(target, now)) {
            ws.send(JSON.stringify({ type: "prank-shielded" }));
            return;
          }
          try {
            targetWs.send(raw);
          } catch {
            ws.send(JSON.stringify({ type: "prank-missed" }));
            return;
          }
          this.prankedAt.set(this.victimKey(target), now);
        }

        this.prankAt.set(s.userId, now); // only a delivered prank costs cooldown
        this.prunePranks(now);
        ws.send(JSON.stringify({ type: "prank-sent", kind }));
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
    // prankAt deliberately survives disconnects (see the prank case); it is
    // pruned by age instead.
    if (s) this.rate.delete(s.sid);
    if (s?.joined) {
      this.broadcast({ type: "member-leave", sid: s.sid });
    }
    try {
      ws.close(1011, "session dropped");
    } catch {}
  }
}

/* ================================== hub ==================================== */
// One singleton Durable Object for the whole app. It holds the things that
// can't belong to any single server: your account, your friend tag, the friend
// graph, and the secret code for each DM conversation.
//
// It deliberately does NOT hold messages. When two people become friends the
// hub mints a random 12-character code and hands it to exactly those two; the
// DM itself is an ordinary ConcordServer at that code. That keeps DM history,
// reactions, typing, and voice calls on the code path that already works,
// and means the hub never sees a word anyone says.

const TAG_RE = /^[a-z0-9_.]{2,20}$/;
const FRIEND_CAP = 250;
const HUB_RATE_LIMITED = new Set([
  "hello", "friend-add", "friend-accept", "friend-decline", "friend-remove",
  "presence", "set-tag", "dm-open", "dm-nudge", "dm-read", "poke",
]);

const frKey = (a, b) => `fr:${a}:${b}`;
const unreadKey = (owner, other) => `unread:${owner}:${other}`;

export class ConcordHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // ws -> session
    this.online = new Map(); // uid -> Set<ws>
    this.rate = new Map();
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')
    );
    for (const ws of this.state.getWebSockets()) {
      const s = ws.deserializeAttachment();
      if (!s) continue;
      this.sessions.set(ws, s);
      if (s.uid) this.track(ws, s.uid);
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const session = { sid: crypto.randomUUID().slice(0, 8), uid: null };
    server.serializeAttachment(session);
    this.sessions.set(server, session);
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  track(ws, uid) {
    let set = this.online.get(uid);
    if (!set) {
      set = new Set();
      this.online.set(uid, set);
    }
    set.add(ws);
    return set.size === 1; // true when this uid just came online
  }

  untrack(ws, uid) {
    const set = this.online.get(uid);
    if (!set) return false;
    set.delete(ws);
    if (set.size) return false;
    this.online.delete(uid);
    return true; // that uid's last socket just went away
  }

  isOnline(uid) {
    return this.online.has(uid);
  }

  sendToUser(uid, payload) {
    const set = this.online.get(uid);
    if (!set) return false;
    const raw = JSON.stringify(payload);
    let sent = false;
    for (const ws of set) {
      try {
        ws.send(raw);
        sent = true;
      } catch {}
    }
    return sent;
  }

  overRate(sid) {
    const now = Date.now();
    let r = this.rate.get(sid);
    if (!r || now - r.windowStart > 5000) {
      r = { count: 0, windowStart: now };
      this.rate.set(sid, r);
    }
    r.count++;
    return r.count > 30;
  }

  async account(uid) {
    return uid ? await this.state.storage.get(`user:${uid}`) : null;
  }

  publicUser(uid, acct) {
    return {
      uid,
      tag: acct?.tag || "",
      name: acct?.name || "Wumpus",
      avatar: acct?.avatar || "🙂",
      color: acct?.color || "#5865f2",
      status: acct?.status || "",
      presence: acct?.presence || "online",
      online: this.isOnline(uid),
    };
  }

  // Tags are the "add me" handle: a slug, plus digits when the slug is taken.
  async mintTag(name) {
    const base =
      (typeof name === "string" ? name : "")
        .toLowerCase()
        .replace(/[^a-z0-9_.]/g, "")
        .slice(0, 14) || "wumpus";
    if (base.length >= 2 && !(await this.state.storage.get(`tag:${base}`))) return base;
    for (let i = 0; i < 12; i++) {
      const n = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
      const candidate = `${base.padEnd(2, "0")}${n}`;
      if (!(await this.state.storage.get(`tag:${candidate}`))) return candidate;
    }
    return `user${crypto.randomUUID().slice(0, 8)}`;
  }

  async friendRows(uid) {
    const rows = await this.state.storage.list({ prefix: `fr:${uid}:` });
    const out = [];
    for (const [key, row] of rows) out.push([key.slice(`fr:${uid}:`.length), row]);
    return out;
  }

  // Everyone who has accepted you — the people who get told when you come
  // online, change your name, or start playing something.
  async notifyFriends(uid, payload, skipWs = null) {
    const rows = await this.friendRows(uid);
    const raw = JSON.stringify(payload);
    for (const [other, row] of rows) {
      if (row.state !== "friend") continue;
      const set = this.online.get(other);
      if (!set) continue;
      for (const ws of set) {
        if (ws === skipWs) continue;
        try {
          ws.send(raw);
        } catch {}
      }
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 8000) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    const s = this.sessions.get(ws) || ws.deserializeAttachment();
    if (!s) return;
    this.sessions.set(ws, s);
    try {
      await this.hubDispatch(ws, s, m);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: "hub-error", error: String(err?.message || err) }));
      } catch {}
    }
  }

  async hubDispatch(ws, s, m) {
    const storage = this.state.storage;
    if (HUB_RATE_LIMITED.has(m.type) && this.overRate(s.sid)) return;

    switch (m.type) {
      case "hello": {
        if (s.uid) return; // identity is claimed once per socket, as in ConcordServer

        const claimed = cleanText(m.uid, 40);
        const presented = cleanText(m.token, 64);
        let uid = claimed;
        let acct = uid ? await storage.get(`user:${uid}`) : null;
        if (acct && acct.token !== presented) {
          acct = null; // wrong token — you get a new account, not theirs
          uid = "";
        }
        if (!acct) {
          uid = crypto.randomUUID();
          const tag = await this.mintTag(m.name);
          acct = {
            token: crypto.randomUUID(),
            tag,
            name: cleanText(m.name, 32) || "Wumpus",
            avatar: cleanText(m.avatar, 8) || "🙂",
            color: cleanColor(m.color),
            status: cleanText(m.status, 60),
            presence: cleanPresence(m.presence),
            at: Date.now(),
          };
          await storage.put({ [`user:${uid}`]: acct, [`tag:${tag}`]: uid });
        } else {
          // Profile travels with the account so friends can see it while
          // you're offline.
          if (m.name !== undefined) acct.name = cleanText(m.name, 32) || acct.name;
          if (m.avatar !== undefined) acct.avatar = cleanText(m.avatar, 8) || acct.avatar;
          if (m.color !== undefined) acct.color = cleanColor(m.color);
          if (m.status !== undefined) acct.status = cleanText(m.status, 60);
          if (m.presence !== undefined) acct.presence = cleanPresence(m.presence);
          acct.at = Date.now();
          await storage.put(`user:${uid}`, acct);
        }

        s.uid = uid;
        ws.serializeAttachment(s);
        this.sessions.set(ws, s);
        const cameOnline = this.track(ws, uid);

        const rows = await this.friendRows(uid);
        const friends = [];
        const incoming = [];
        const outgoing = [];
        const dmUnread = {};
        for (const [other, row] of rows) {
          const otherAcct = await storage.get(`user:${other}`);
          const user = this.publicUser(other, otherAcct);
          if (row.state === "friend") {
            const unread = (await storage.get(unreadKey(uid, other))) || 0;
            if (unread) dmUnread[other] = unread;
            friends.push({ ...user, dm: row.dm });
          } else if (row.state === "in") incoming.push(user);
          else if (row.state === "out") outgoing.push(user);
        }

        ws.send(
          JSON.stringify({
            type: "hub-welcome",
            you: this.publicUser(uid, acct),
            token: acct.token,
            friends,
            incoming,
            outgoing,
            dmUnread,
          })
        );
        if (cameOnline) {
          await this.notifyFriends(uid, { type: "friend-presence", uid, online: true, presence: acct.presence });
        }
        break;
      }

      case "set-tag": {
        if (!s.uid) return;
        const tag = cleanText(m.tag, 20).toLowerCase().replace(/^@/, "");
        if (!TAG_RE.test(tag)) {
          ws.send(JSON.stringify({ type: "hub-error", error: "Tags are 2–20 characters: letters, numbers, dot, underscore." }));
          return;
        }
        const acct = await this.account(s.uid);
        if (!acct || acct.tag === tag) return;
        const taken = await storage.get(`tag:${tag}`);
        if (taken && taken !== s.uid) {
          ws.send(JSON.stringify({ type: "hub-error", error: `@${tag} is taken. Try another.` }));
          return;
        }
        const old = acct.tag;
        acct.tag = tag;
        await storage.put({ [`user:${s.uid}`]: acct, [`tag:${tag}`]: s.uid });
        if (old && old !== tag) await storage.delete(`tag:${old}`);
        ws.send(JSON.stringify({ type: "tag-changed", tag }));
        await this.notifyFriends(s.uid, { type: "friend-update", user: this.publicUser(s.uid, acct) });
        break;
      }

      case "presence": {
        if (!s.uid) return;
        const acct = await this.account(s.uid);
        if (!acct) return;
        if (m.name !== undefined) acct.name = cleanText(m.name, 32) || acct.name;
        if (m.avatar !== undefined) acct.avatar = cleanText(m.avatar, 8) || acct.avatar;
        if (m.color !== undefined) acct.color = cleanColor(m.color);
        if (m.status !== undefined) acct.status = cleanText(m.status, 60);
        if (m.presence !== undefined) acct.presence = cleanPresence(m.presence);
        acct.at = Date.now();
        await storage.put(`user:${s.uid}`, acct);
        await this.notifyFriends(s.uid, { type: "friend-update", user: this.publicUser(s.uid, acct) });
        break;
      }

      case "friend-add": {
        if (!s.uid) return;
        const tag = cleanText(m.tag, 25).toLowerCase().replace(/^@/, "");
        if (!TAG_RE.test(tag)) {
          ws.send(JSON.stringify({ type: "hub-error", error: "That doesn't look like a tag. They look like @keith or @keith4821." }));
          return;
        }
        const targetUid = await storage.get(`tag:${tag}`);
        if (!targetUid) {
          ws.send(JSON.stringify({ type: "hub-error", error: `Nobody here goes by @${tag}.` }));
          return;
        }
        if (targetUid === s.uid) {
          ws.send(JSON.stringify({ type: "hub-error", error: "You cannot add yourself. Touch grass." }));
          return;
        }
        const mine = await storage.get(frKey(s.uid, targetUid));
        if (mine?.state === "friend") {
          ws.send(JSON.stringify({ type: "hub-error", error: "You're already friends." }));
          return;
        }
        if (mine?.state === "out") {
          ws.send(JSON.stringify({ type: "hub-error", error: "Already asked. Give them a minute." }));
          return;
        }
        const targetAcct = await storage.get(`user:${targetUid}`);
        // They already asked you — adding them back just accepts.
        if (mine?.state === "in") {
          await this.becomeFriends(s.uid, targetUid);
          return;
        }
        const rows = await this.friendRows(s.uid);
        if (rows.length >= FRIEND_CAP) {
          ws.send(JSON.stringify({ type: "hub-error", error: "That's a lot of friends. Prune some first." }));
          return;
        }
        const now = Date.now();
        await storage.put({
          [frKey(s.uid, targetUid)]: { state: "out", at: now },
          [frKey(targetUid, s.uid)]: { state: "in", at: now },
        });
        const myAcct = await this.account(s.uid);
        ws.send(JSON.stringify({ type: "friend-outgoing", user: this.publicUser(targetUid, targetAcct) }));
        this.sendToUser(targetUid, { type: "friend-request", user: this.publicUser(s.uid, myAcct) });
        break;
      }

      case "friend-accept": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "in") return;
        await this.becomeFriends(s.uid, other);
        break;
      }

      case "friend-decline":
      case "friend-remove": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (!row) return;
        await storage.delete([
          frKey(s.uid, other),
          frKey(other, s.uid),
          unreadKey(s.uid, other),
          unreadKey(other, s.uid),
        ]);
        ws.send(JSON.stringify({ type: "friend-removed", uid: other }));
        this.sendToUser(other, { type: "friend-removed", uid: s.uid });
        break;
      }

      case "dm-open": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") {
          ws.send(JSON.stringify({ type: "hub-error", error: "You can only DM friends." }));
          return;
        }
        // Older friendships predate DM codes; mint one on demand for both.
        let code = row.dm;
        if (!code) {
          code = newServerCode() + newServerCode().slice(0, 4);
          const mirror = (await storage.get(frKey(other, s.uid))) || { state: "friend", at: Date.now() };
          row.dm = code;
          mirror.dm = code;
          await storage.put({ [frKey(s.uid, other)]: row, [frKey(other, s.uid)]: mirror });
        }
        await storage.delete(unreadKey(s.uid, other));
        const otherAcct = await storage.get(`user:${other}`);
        ws.send(JSON.stringify({ type: "dm-ready", uid: other, code, user: this.publicUser(other, otherAcct) }));
        break;
      }

      // Sent alongside a DM message. The recipient isn't connected to the DM's
      // Durable Object unless they have it open, so this is what lights up
      // their sidebar — and what survives until they're back online.
      case "dm-nudge": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") return;
        const key = unreadKey(other, s.uid);
        const count = ((await storage.get(key)) || 0) + 1;
        await storage.put(key, Math.min(count, 999));
        const acct = await this.account(s.uid);
        this.sendToUser(other, {
          type: "dm-nudge",
          uid: s.uid,
          name: acct?.name || "Someone",
          preview: cleanText(m.preview, 120),
          count: Math.min(count, 999),
        });
        break;
      }

      case "dm-read": {
        if (!s.uid) return;
        await storage.delete(unreadKey(s.uid, cleanText(m.uid, 40)));
        break;
      }

      // Purely for fun: a friend-to-friend nudge that rattles their window.
      case "poke": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") return;
        const acct = await this.account(s.uid);
        const landed = this.sendToUser(other, { type: "poked", uid: s.uid, name: acct?.name || "Someone" });
        ws.send(JSON.stringify({ type: "poke-sent", landed }));
        break;
      }
    }
  }

  async becomeFriends(a, b) {
    const storage = this.state.storage;
    const now = Date.now();
    const existing = await storage.get(frKey(a, b));
    // 12 chars from the unambiguous alphabet: unguessable, and only these two
    // are ever told it. That secrecy is what keeps the DM private.
    const code = existing?.dm || newServerCode() + newServerCode().slice(0, 4);
    await storage.put({
      [frKey(a, b)]: { state: "friend", at: now, dm: code },
      [frKey(b, a)]: { state: "friend", at: now, dm: code },
    });
    const [acctA, acctB] = await Promise.all([this.account(a), this.account(b)]);
    this.sendToUser(a, { type: "friend-added", user: { ...this.publicUser(b, acctB), dm: code } });
    this.sendToUser(b, { type: "friend-added", user: { ...this.publicUser(a, acctA), dm: code } });
  }

  async webSocketClose(ws) {
    await this.dropHubSession(ws);
  }

  async webSocketError(ws) {
    await this.dropHubSession(ws);
  }

  async dropHubSession(ws) {
    const s = this.sessions.get(ws);
    this.sessions.delete(ws);
    if (s) {
      this.rate.delete(s.sid);
      if (s.uid && this.untrack(ws, s.uid)) {
        await this.notifyFriends(s.uid, { type: "friend-presence", uid: s.uid, online: false });
      }
    }
    try {
      ws.close(1011, "session dropped");
    } catch {}
  }
}

const PRESENCES = new Set(["online", "idle", "dnd", "invisible"]);
function cleanPresence(v) {
  return typeof v === "string" && PRESENCES.has(v) ? v : "online";
}

/* ================================ helpers ================================= */

function publicMember(s) {
  return {
    sid: s.sid,
    userId: s.userId,
    name: s.name,
    color: s.color,
    avatar: s.avatar,
    status: s.status || "",
    tag: s.tag || "",
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
