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

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_MSG = 10;
const MAX_PENDING_TICKETS = 10; // unspent tickets one person may hold at once
const UPLOADS_PER_10MIN = 30;
const TICKET_TTL_MS = 5 * 60 * 1000;
const ATT_TTL_MS = 30 * 60 * 1000;
const ROSTER_CAP = 200;
const CHANNEL_CAP = 100; // threads live in `channels`, so the ceiling had to move
const EMOJI_CAP = 50;
const EMOJI_MAX_BYTES = 256 * 1024;
const SOUND_CAP = 20;
const SOUND_MAX_BYTES = 512 * 1024;
const SLOWMODE_MAX_S = 300;
const EMOJI_NAME_RE = /^[a-z0-9_]{2,20}$/;
const CUSTOM_EMOJI_RE = /^:[a-z0-9_]{2,20}:$/;
// `a/<CODE>/<uuid>/<slug>` — four segments, nothing else.
const ATT_KEY_RE = /^a\/([A-Z0-9]{4,12})\/[a-f0-9-]{36}\/[A-Za-z0-9._-]{1,80}$/;

// A thread is a channel with a parent, and voice channels grew a chat pane, so
// "can you post here?" is a set membership test rather than `type === "text"`.
const CHATTABLE = new Set(["text", "thread", "voice"]);

// What we are willing to hand back with a real Content-Type. Everything else
// becomes application/octet-stream and therefore downloads instead of
// rendering. image/svg+xml and text/html are absent on purpose: both execute
// script on our own origin, which is the one thing an attachment must not do.
const SAFE_MIMES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp",
  "video/mp4", "video/webm", "video/quicktime",
  "audio/mpeg", "audio/ogg", "audio/wav", "audio/webm", "audio/mp4",
  "application/pdf", "text/plain", "application/zip", "application/json",
]);

// Everything a client can spam goes through the rate limiter. `rtc` is
// exempt (ICE candidates legitimately burst) and `hello` runs once.
const RATE_LIMITED = new Set([
  "msg", "react", "edit", "delete", "typing", "history", "set-profile",
  "create-channel", "update-channel", "delete-channel", "update-server",
  "voice-join", "voice-leave", "voice-state", "prank", "hello",
  "pin", "unpin", "pins", "search", "sound",
  "upload-ticket", "create-thread", "leave-server", "kick", "ban", "unban",
  "bans", "emoji-add", "emoji-remove", "sound-add", "sound-remove",
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

    if (url.pathname.startsWith("/api/upload/")) {
      return handleUpload(request, env, url);
    }

    // Must run before the asset server, or /f/ would be a 404 from the SPA
    // fallback instead of a file.
    if (url.pathname.startsWith("/f/")) {
      return serveFile(request, env, url);
    }

    return env.ASSETS.fetch(request);
  },
};

// Spend an upload ticket. The ticket is the only identity this request has —
// there is no socket here — so the DO validates it and hands back the key it
// already picked, rather than trusting anything on the wire.
async function handleUpload(request, env, url) {
  if (request.method !== "PUT") return new Response("expected PUT", { status: 405 });
  if (!env.FILES) return new Response("uploads are not configured", { status: 503 });

  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!CODE_RE.test(code)) return new Response("bad server code", { status: 400 });
  const ticket = url.pathname.slice("/api/upload/".length);
  if (!/^[a-f0-9-]{36}$/.test(ticket)) return new Response("bad ticket", { status: 400 });

  // A chunked upload gives us no size to check against, and the whole point of
  // the ticket is a bound we can enforce before writing a byte.
  const len = Number(request.headers.get("Content-Length"));
  if (!Number.isFinite(len) || len <= 0) return new Response("length required", { status: 411 });
  if (len > MAX_FILE_BYTES) return new Response("too large", { status: 413 });

  const stub = env.SERVERS.get(env.SERVERS.idFromName(code));
  const claimed = await stub.fetch(
    `https://do/internal/claim?ticket=${encodeURIComponent(ticket)}`
  );
  if (!claimed.ok) return new Response("ticket expired or already spent", { status: 403 });
  const claim = await claimed.json();
  if (len > claim.max) return new Response("too large", { status: 413 });

  // The mime on the ticket wins. Believing Content-Type here would let anyone
  // declare image/png and upload markup we then serve from our own origin.
  await env.FILES.put(claim.key, request.body, {
    httpMetadata: { contentType: claim.mime },
  });

  return Response.json({
    ok: true,
    att: { key: claim.key, name: claim.key.split("/").pop(), size: len, mime: claim.mime },
  });
}

// Server codes are the auth for everything in this app, so an attacker who can
// guess a key already knows the code inside it. Validating the prefix here is
// defence in depth against a malformed or hand-built key, not a real boundary.
async function serveFile(request, env, url) {
  if (!env.FILES) return new Response("not found", { status: 404 });
  let key;
  try {
    key = decodeURIComponent(url.pathname.slice(3));
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!ATT_KEY_RE.test(key)) return new Response("not found", { status: 404 });

  const obj = await env.FILES.get(key);
  if (!obj) return new Response("not found", { status: 404 });

  // Second pass over the allowlist: the metadata was written whenever this file
  // was uploaded, which may predate a mime we have since stopped trusting.
  const mime = safeMime(obj.httpMetadata?.contentType);
  const inline = /^(image|video|audio)\//.test(mime) || mime === "application/pdf";
  const name = key.split("/").pop();
  return new Response(obj.body, {
    headers: {
      "Content-Type": mime,
      "Content-Disposition": inline ? "inline" : `attachment; filename="${name}"`,
      "Content-Length": String(obj.size),
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
      ETag: obj.httpEtag,
    },
  });
}

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
    // Every Map on `this` is erased when the DO hibernates, which means all of
    // these limiters fail open on the first message after a wake-up. That's a
    // deliberate trade: persisting a counter per keystroke costs more than the
    // one extra emoji a friend group might squeeze through.
    this.slowAt = new Map(); // `${userId}:${chanId}` -> last message
    this.uploadAt = new Map(); // userId -> recent upload timestamps
    this.authWrites = 0;
    this.code = ""; // this server's invite code; see fetch()
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

    // Only the Worker holds a stub for this object, so this route is not
    // reachable from the internet — it is the trusted half of an upload.
    if (url.pathname === "/internal/claim") {
      return this.claimTicket(url.searchParams.get("ticket") || "");
    }

    if (url.pathname !== "/ws" || request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // A DO cannot ask what name it was created under, and attachment keys need
    // it. The connect URL is the only place it appears, so remember it — a
    // socket that wakes from hibernation arrives with no URL at all.
    const joining = (url.searchParams.get("server") || "").toUpperCase();
    if (CODE_RE.test(joining) && this.code !== joining) {
      this.code = joining;
      if ((await this.state.storage.get("code")) !== joining) {
        await this.state.storage.put("code", joining);
      }
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
    for (const [key, at] of this.slowAt) {
      if (now - at > SLOWMODE_MAX_S * 1000) this.slowAt.delete(key);
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

  // Unconsumed uploads and tickets nobody spent, swept on the auth schedule.
  // Orphans outlive a DO that dies mid-write; R2's free tier is 10 GB and this
  // is a friend group, so we let those go.
  async sweepUploads(now) {
    const storage = this.state.storage;
    const doomed = [];
    const orphans = [];
    for (const [key, rec] of await storage.list({ prefix: "att:" })) {
      if (rec?.exp > now) continue;
      doomed.push(key);
      orphans.push(key.slice(4));
    }
    for (const [key, rec] of await storage.list({ prefix: "tkt:" })) {
      if (!(rec?.exp > now)) doomed.push(key);
    }
    await this.dropObjects(orphans);
    if (doomed.length) await storage.delete(doomed);
  }

  // The ticket must die in the same breath it is read, or two racing PUTs both
  // see it alive and the second one overwrites the first one's key.
  async claimTicket(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) return Response.json({ ok: false }, { status: 404 });
    const storage = this.state.storage;
    const claim = await this.state.blockConcurrencyWhile(async () => {
      const tkt = await storage.get(`tkt:${id}`);
      if (!tkt) return null;
      await storage.delete(`tkt:${id}`);
      if (!(tkt.exp > Date.now())) return null;
      await storage.put(`att:${tkt.key}`, {
        userId: tkt.userId,
        mime: tkt.mime,
        exp: Date.now() + ATT_TTL_MS,
      });
      return tkt;
    });
    if (!claim) return Response.json({ ok: false }, { status: 404 });
    return Response.json({
      ok: true,
      key: claim.key,
      mime: claim.mime,
      max: claim.max,
      userId: claim.userId,
    });
  }

  async dropObjects(keys) {
    if (!keys?.length || !this.env.FILES) return;
    try {
      await this.env.FILES.delete(keys);
    } catch {
      // A failed delete leaves an orphan, which is cheaper than a failed send.
    }
  }

  async dropMessageFiles(msgs) {
    const keys = [];
    for (const msg of msgs) {
      for (const a of msg?.attachments || []) if (a?.key) keys.push(a.key);
    }
    await this.dropObjects(keys);
  }

  // Turns client-declared attachments into stored ones. Each key must have an
  // `att:` record minted by *this* person's upload; anything else is dropped
  // without comment, because a client that sends a bad key is a bug, not a user.
  async claimAttachments(s, raw) {
    if (!Array.isArray(raw) || !raw.length) return [];
    const storage = this.state.storage;
    const out = [];
    for (const a of raw.slice(0, MAX_FILES_PER_MSG)) {
      const key = typeof a?.key === "string" ? a.key : "";
      if (!ATT_KEY_RE.test(key)) continue;
      const rec = await storage.get(`att:${key}`);
      if (!rec || rec.userId !== s.userId) continue;
      await storage.delete(`att:${key}`);
      const att = {
        key,
        url: `/f/${key}`,
        name: cleanFileName(a.name) || key.split("/").pop(),
        size: clampInt(a.size, 0, MAX_FILE_BYTES),
        mime: safeMime(rec.mime),
      };
      // Dimensions and duration are measured by the browser purely so the
      // bubble reserves the right space before the file loads. Cosmetic, so
      // clamped rather than verified.
      const w = clampInt(a.w, 0, 20000);
      const h = clampInt(a.h, 0, 20000);
      const dur = clampInt(a.dur, 0, 86400);
      if (w) att.w = w;
      if (h) att.h = h;
      if (dur) att.dur = dur;
      if (a.spoiler) att.spoiler = true;
      out.push(att);
    }
    return out;
  }

  async isOwner(userId) {
    const meta = await this.state.storage.get("meta");
    return !!userId && meta?.owner === userId;
  }

  async banList() {
    return [...(await this.state.storage.list({ prefix: "ban:" })).values()];
  }

  // Emoji and soundboard clips are both "a spent upload ticket, but smaller".
  // R2 is asked for the real size because the ticket only ever knew what the
  // client claimed the size would be.
  async consumeAsset(s, rawKey, kind, maxBytes) {
    const key = typeof rawKey === "string" ? rawKey : "";
    if (!ATT_KEY_RE.test(key)) return { error: "That upload isn't one of ours." };
    const rec = await this.state.storage.get(`att:${key}`);
    if (!rec || rec.userId !== s.userId) return { error: "That upload expired. Send it again." };
    if (!safeMime(rec.mime).startsWith(`${kind}/`)) {
      return { error: kind === "image" ? "Emoji have to be images." : "Clips have to be audio." };
    }
    const head = await this.env.FILES?.head(key);
    if (!head) return { error: "That upload never finished." };
    if (head.size > maxBytes) return { error: `That one has to be under ${Math.round(maxBytes / 1024)} KB.` };
    await this.state.storage.delete(`att:${key}`);
    return { key };
  }

  async rosterList() {
    return [...(await this.state.storage.list({ prefix: "roster:" })).values()];
  }

  async emojiList() {
    const rows = await this.state.storage.list({ prefix: "emoji:" });
    return [...rows.values()].map((e) => ({ name: e.name, url: `/f/${e.key}` }));
  }

  async soundList() {
    const rows = await this.state.storage.list({ prefix: "sound:" });
    return [...rows.values()].map((x) => ({ id: x.id, name: x.name, url: `/f/${x.key}` }));
  }

  // Roster rows outlive sockets, so they need their own ceiling. Anyone with a
  // socket open is exempt — evicting someone mid-conversation would be absurd.
  async sweepRoster() {
    const rows = await this.state.storage.list({ prefix: "roster:" });
    if (rows.size <= ROSTER_CAP) return;
    const live = new Set();
    for (const s of this.sessions.values()) if (s.userId) live.add(`roster:${s.userId}`);
    const cold = [...rows].filter(([key]) => !live.has(key)).sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
    const doomed = cold.slice(0, rows.size - ROSTER_CAP).map(([key]) => key);
    if (doomed.length) await this.state.storage.delete(doomed);
  }

  async writeRoster(s) {
    const key = `roster:${s.userId}`;
    const now = Date.now();
    const existing = await this.state.storage.get(key);
    const entry = {
      userId: s.userId,
      name: s.name,
      color: s.color,
      avatar: s.avatar,
      tag: s.tag || "",
      status: s.status || "",
      at: now,
      joinedAt: existing?.joinedAt || now,
    };
    await this.state.storage.put(key, entry);
    if (!existing) await this.sweepRoster();
    return entry;
  }

  // Removing the owner has to hand the keys to someone, or the server locks
  // itself out of its own moderation forever.
  async removeMember(userId, closeSockets) {
    const storage = this.state.storage;
    await storage.delete(`roster:${userId}`);
    const meta = await storage.get("meta");
    if (meta?.owner === userId) {
      const rows = await this.rosterList();
      const heir = rows.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
      meta.owner = heir?.userId || null;
      await storage.put("meta", meta);
      this.broadcast({ type: "server-meta", meta });
    }
    this.broadcast({ type: "roster-remove", userId });
    if (!closeSockets) return;
    for (const [ws, other] of this.sessions) {
      if (other.userId !== userId) continue;
      try {
        ws.close(4003, "removed");
      } catch {}
    }
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

  uploadBudget(userId, count, now) {
    const recent = (this.uploadAt.get(userId) || []).filter((t) => now - t < 600_000);
    if (recent.length + count > UPLOADS_PER_10MIN) return false;
    for (let i = 0; i < count; i++) recent.push(now);
    this.uploadAt.set(userId, recent);
    return true;
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

        // Before the identity is minted, not after: a banned member should
        // never get a session, a roster row, or a storage write out of us.
        // Bans key on userId, so someone willing to throw away their token can
        // walk back in as a stranger — that is the honest limit of a system
        // where the invite code is the only real credential.
        if (userId && (await storage.get(`ban:${userId}`))) {
          ws.send(JSON.stringify({ type: "banned" }));
          try {
            ws.close(4003, "banned");
          } catch {}
          return;
        }

        if (!userId) userId = crypto.randomUUID();
        let token = tokenOf(await storage.get(`auth:${userId}`));
        const isNewIdentity = !token;
        if (isNewIdentity) token = crypto.randomUUID();
        // `at` doubles as last-seen so dormant identities can be swept.
        await storage.put(`auth:${userId}`, { token, at: Date.now() });
        if (isNewIdentity && ++this.authWrites % AUTH_SWEEP_EVERY === 0) {
          await this.sweepAuth(Date.now());
          await this.sweepUploads(Date.now());
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

        const meta = await storage.get("meta");
        // Whoever turns up first is in charge. There is no other moment at
        // which we could possibly tell.
        if (meta && !meta.owner) {
          meta.owner = userId;
          await storage.put("meta", meta);
        }
        const entry = await this.writeRoster(s);
        const [channels, roster, emoji, sounds] = await Promise.all([
          storage.get("channels"),
          this.rosterList(),
          this.emojiList(),
          this.soundList(),
        ]);
        ws.send(
          JSON.stringify({
            type: "welcome",
            you: publicMember(s),
            token: s.token, // proves this userId is ours on future connects
            meta,
            channels,
            members: this.members(),
            roster,
            owner: meta?.owner || null,
            emoji,
            sounds,
          })
        );
        this.broadcast({ type: "member-join", member: publicMember(s) }, ws);
        this.broadcast({ type: "roster", entry }, ws);
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
        this.broadcast({ type: "roster", entry: await this.writeRoster(s) });
        break;
      }

      case "msg": {
        if (!s.joined) return;
        const content = cleanText(m.content, 4000);
        const chanId = String(m.chanId || "");
        const channels = (await storage.get("channels")) || [];
        const chan = channels.find((c) => c.id === chanId);
        if (!chan || !CHATTABLE.has(chan.type)) return;
        // A picture with no caption is the entire reason attachments exist.
        // Counted before they're claimed, because a slowmode bounce must not
        // consume the upload the sender is about to retry with.
        const wanted = Array.isArray(m.attachments) ? m.attachments.length : 0;
        if (!content && !wanted) return;

        if (chan.slow && !(await this.isOwner(s.userId))) {
          const now = Date.now();
          const waited = now - (this.slowAt.get(`${s.userId}:${chanId}`) || 0);
          if (waited < chan.slow * 1000) {
            ws.send(
              JSON.stringify({
                type: "slowmode",
                chanId,
                seconds: Math.ceil((chan.slow * 1000 - waited) / 1000),
              })
            );
            return;
          }
          this.slowAt.set(`${s.userId}:${chanId}`, now);
        }

        const attachments = await this.claimAttachments(s, m.attachments);
        if (!content && !attachments.length) return;

        const seqKey = `chanseq:${chanId}`;
        const seq = ((await storage.get(seqKey)) || 0) + 1;
        const msg = {
          id: seq,
          chanId,
          author: { userId: s.userId, name: s.name, color: s.color, avatar: s.avatar },
          content,
          ts: Date.now(),
        };
        if (attachments.length) msg.attachments = attachments;
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
        if (seq > MSG_CAP) {
          // Read the message falling off the end before dropping it, or its
          // files sit in the bucket forever with nothing left pointing at them.
          const evicted = msgKey(chanId, seq - MSG_CAP);
          await this.dropMessageFiles([await storage.get(evicted)]);
          await storage.delete(evicted);
        }
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
        await this.dropMessageFiles([msg]);
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
        // `:name:` is a custom emoji and needs room for the name; everything
        // else is a literal glyph and keeps the tight clamp it always had.
        const wide = cleanText(m.emoji, 24);
        let emoji;
        if (CUSTOM_EMOJI_RE.test(wide)) {
          if (!(await storage.get(`emoji:${wide.slice(1, -1)}`))) return;
          emoji = wide;
        } else {
          emoji = cleanText(m.emoji, 8);
        }
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
          ? channels.filter((c) => c.id === scope && CHATTABLE.has(c.type))
          : channels.filter((c) => CHATTABLE.has(c.type));
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
        const sound = cleanText(m.sound, 24);
        // Built-ins are synthesized on the receiver; a custom clip is a file,
        // so it travels with a url and nothing else about the shape changes.
        const custom = SOUNDS.has(sound) ? null : await storage.get(`sound:${sound}`);
        if (!SOUNDS.has(sound) && !custom) return;
        const now = Date.now();
        const last = this.soundAt.get(s.userId) || 0;
        if (now - last < 2000) return; // one clip per 2s per person
        this.soundAt.set(s.userId, now);
        const payload = { type: "sound", sound, name: s.name, sid: s.sid };
        if (custom) payload.url = `/f/${custom.key}`;
        const raw = JSON.stringify(payload);
        for (const [sock, other] of this.sessions) {
          if (!other.joined || other.voice?.chanId !== s.voice.chanId) continue;
          try {
            sock.send(raw);
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
        if (channels.length >= CHANNEL_CAP) return;
        const nextChanId = ((await storage.get("nextChanId")) || 100) + 1;
        const chan = { id: `c${nextChanId}`, type, name };
        if (type === "text") chan.topic = cleanText(m.topic, 100);
        // Categories are one string on the channel. Grouping, ordering and
        // whether you folded one away are all the client's problem.
        const cat = cleanText(m.cat, 24);
        if (cat) chan.cat = cat;
        if (m.slow !== undefined) chan.slow = clampInt(m.slow, 0, SLOWMODE_MAX_S);
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
        if (m.topic !== undefined && chan.type !== "voice") chan.topic = cleanText(m.topic, 100);
        if (m.cat !== undefined) {
          const cat = cleanText(m.cat, 24);
          if (cat) chan.cat = cat;
          else delete chan.cat;
        }
        if (m.slow !== undefined) chan.slow = clampInt(m.slow, 0, SLOWMODE_MAX_S);
        await storage.put("channels", channels);
        this.broadcast({ type: "channel-update", channel: chan });
        break;
      }

      case "delete-channel": {
        if (!s.joined) return;
        let channels = (await storage.get("channels")) || [];
        const chan = channels.find((c) => c.id === m.chanId);
        if (!chan) return;
        // Keep at least one text and one voice channel. Threads are disposable
        // by nature, so the floor never applies to them.
        if (chan.type !== "thread" && channels.filter((c) => c.type === chan.type).length <= 1) return;
        // A thread without its parent is just an orphan nobody can reach.
        const doomed = [chan.id, ...channels.filter((c) => c.parent === chan.id).map((c) => c.id)];
        channels = channels.filter((c) => !doomed.includes(c.id));
        await storage.put("channels", channels);
        for (const id of doomed) {
          const rows = await storage.list({ prefix: `msg:${id}:` });
          await this.dropMessageFiles([...rows.values()]);
          await storage.delete([...rows.keys(), `chanseq:${id}`, `pins:${id}`]);
          this.broadcast({ type: "channel-delete", chanId: id });
        }
        break;
      }

      // A thread is a channel with a parent. Everything that already works on
      // a channel — history, pins, reactions, slowmode — works on it for free.
      case "create-thread": {
        if (!s.joined) return;
        const chanId = String(m.chanId || "");
        const key = msgKey(chanId, Number(m.msgId));
        const src = await storage.get(key);
        if (!src) return;
        const channels = (await storage.get("channels")) || [];
        const parent = channels.find((c) => c.id === chanId);
        if (!parent || parent.type === "thread") return; // no threads on threads
        // One thread per message; asking twice hands back the first one.
        const already = src.threadId && channels.find((c) => c.id === src.threadId);
        if (already) {
          ws.send(
            JSON.stringify({
              type: "msg-thread",
              chanId,
              msgId: src.id,
              threadId: already.id,
              name: already.name,
            })
          );
          return;
        }
        if (channels.length >= CHANNEL_CAP) {
          ws.send(JSON.stringify({ type: "error", error: `${CHANNEL_CAP} channels is the ceiling. Delete something.` }));
          return;
        }
        const nextChanId = ((await storage.get("nextChanId")) || 100) + 1;
        const name = cleanChannelName(m.name) || cleanChannelName(src.content) || `thread-${src.id}`;
        const chan = { id: `t${nextChanId}`, type: "thread", name, parent: chanId, rootId: src.id, at: Date.now() };
        channels.push(chan);
        src.threadId = chan.id;
        await storage.put({ channels, nextChanId, [key]: src });
        this.broadcast({ type: "channel-create", channel: chan });
        this.broadcast({ type: "msg-thread", chanId, msgId: src.id, threadId: chan.id, name: chan.name });
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

      // Uploads can't ride the socket, and a bare HTTP POST has no identity, so
      // the socket you're already authenticated on issues a ticket you spend
      // over HTTP. The DO picks the key; the client never gets to name it.
      case "upload-ticket": {
        if (!s.joined) return;
        if (!this.env.FILES) {
          ws.send(JSON.stringify({ type: "error", error: "Uploads aren't switched on here." }));
          return;
        }
        const files = Array.isArray(m.files) ? m.files : [];
        if (!files.length || files.length > MAX_FILES_PER_MSG) {
          ws.send(JSON.stringify({ type: "error", error: `${MAX_FILES_PER_MSG} files at a time, tops.` }));
          return;
        }
        for (const f of files) {
          const size = Number(f?.size);
          if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
            ws.send(JSON.stringify({ type: "error", error: "Files cap out at 25 MB." }));
            return;
          }
        }
        const now = Date.now();
        if (!this.uploadBudget(s.userId, files.length, now)) {
          ws.send(JSON.stringify({ type: "error", error: "That's a lot of uploading. Give it ten minutes." }));
          return;
        }
        const pending = await storage.list({ prefix: "tkt:" });
        let mine = 0;
        for (const t of pending.values()) if (t?.userId === s.userId && t.exp > now) mine++;
        if (mine + files.length > MAX_PENDING_TICKETS) {
          ws.send(JSON.stringify({ type: "error", error: "Finish the uploads you already started." }));
          return;
        }
        const code = this.code || (await storage.get("code")) || "";
        if (!CODE_RE.test(code)) {
          ws.send(JSON.stringify({ type: "error", error: "This server can't take uploads yet. Reconnect." }));
          return;
        }
        const writes = {};
        const tickets = [];
        for (const f of files) {
          const id = crypto.randomUUID();
          const key = `a/${code}/${crypto.randomUUID()}/${cleanFileName(f?.name)}`;
          writes[`tkt:${id}`] = {
            key,
            mime: safeMime(f?.mime),
            max: MAX_FILE_BYTES,
            userId: s.userId,
            exp: now + TICKET_TTL_MS,
          };
          tickets.push({ id, key, max: MAX_FILE_BYTES });
        }
        await storage.put(writes);
        ws.send(JSON.stringify({ type: "upload-tickets", tickets }));
        break;
      }

      case "leave-server": {
        if (!s.joined) return;
        await this.removeMember(s.userId, false);
        break;
      }

      case "kick":
      case "ban": {
        if (!s.joined || !(await this.isOwner(s.userId))) return;
        const userId = cleanText(m.userId, 40);
        // Banning yourself would leave the server ownerless and you outside it.
        if (!userId || userId === s.userId) return;
        if (m.type === "ban") {
          const row = await storage.get(`roster:${userId}`);
          await storage.put(`ban:${userId}`, {
            userId,
            name: row?.name || "",
            at: Date.now(),
            by: s.userId,
          });
        }
        await this.removeMember(userId, true);
        break;
      }

      case "unban": {
        if (!s.joined || !(await this.isOwner(s.userId))) return;
        const userId = cleanText(m.userId, 40);
        if (!userId) return;
        await storage.delete(`ban:${userId}`);
        ws.send(JSON.stringify({ type: "bans", list: await this.banList() }));
        break;
      }

      case "bans": {
        if (!s.joined || !(await this.isOwner(s.userId))) return;
        ws.send(JSON.stringify({ type: "bans", list: await this.banList() }));
        break;
      }

      // Stored as plain text, rendered as an image by the client — so a message
      // full of :blobcat: is still a message you can search.
      case "emoji-add": {
        if (!s.joined) return;
        const name = cleanText(m.name, 20).toLowerCase();
        if (!EMOJI_NAME_RE.test(name)) {
          ws.send(JSON.stringify({ type: "error", error: "Emoji names are 2–20 of a–z, 0–9 and _." }));
          return;
        }
        const rows = await storage.list({ prefix: "emoji:" });
        if (rows.has(`emoji:${name}`)) {
          ws.send(JSON.stringify({ type: "error", error: `:${name}: is already taken.` }));
          return;
        }
        if (rows.size >= EMOJI_CAP) {
          ws.send(JSON.stringify({ type: "error", error: `${EMOJI_CAP} emoji is the limit. Retire one.` }));
          return;
        }
        const asset = await this.consumeAsset(s, m.key, "image", EMOJI_MAX_BYTES);
        if (asset.error) {
          ws.send(JSON.stringify({ type: "error", error: asset.error }));
          return;
        }
        await storage.put(`emoji:${name}`, { name, key: asset.key, by: s.userId, at: Date.now() });
        this.broadcast({ type: "emoji", list: await this.emojiList() });
        break;
      }

      case "emoji-remove": {
        if (!s.joined) return;
        const name = cleanText(m.name, 20).toLowerCase();
        const row = await storage.get(`emoji:${name}`);
        if (!row) return;
        if (row.by !== s.userId && !(await this.isOwner(s.userId))) return;
        await storage.delete(`emoji:${name}`);
        await this.dropObjects([row.key]);
        this.broadcast({ type: "emoji", list: await this.emojiList() });
        break;
      }

      case "sound-add": {
        if (!s.joined) return;
        const name = cleanText(m.name, 24);
        if (!name) return;
        const rows = await storage.list({ prefix: "sound:" });
        if (rows.size >= SOUND_CAP) {
          ws.send(JSON.stringify({ type: "error", error: `${SOUND_CAP} clips is the limit. Retire one.` }));
          return;
        }
        const asset = await this.consumeAsset(s, m.key, "audio", SOUND_MAX_BYTES);
        if (asset.error) {
          ws.send(JSON.stringify({ type: "error", error: asset.error }));
          return;
        }
        const id = "sc" + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
        await storage.put(`sound:${id}`, { id, name, key: asset.key, by: s.userId, at: Date.now() });
        this.broadcast({ type: "sounds", list: await this.soundList() });
        break;
      }

      case "sound-remove": {
        if (!s.joined) return;
        const id = cleanText(m.id, 24);
        const row = await storage.get(`sound:${id}`);
        if (!row) return;
        if (row.by !== s.userId && !(await this.isOwner(s.userId))) return;
        await storage.delete(`sound:${id}`);
        await this.dropObjects([row.key]);
        this.broadcast({ type: "sounds", list: await this.soundList() });
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
const GDM_MAX_MEMBERS = 10;
const GDM_CAP = 20; // group conversations per person
const HUB_RATE_LIMITED = new Set([
  "hello", "friend-add", "friend-accept", "friend-decline", "friend-remove",
  "presence", "set-tag", "dm-open", "dm-nudge", "dm-read", "poke",
  "gdm-create", "gdm-open", "gdm-leave", "gdm-add", "gdm-rename",
]);

const frKey = (a, b) => `fr:${a}:${b}`;
// Group ids start with "g" and user ids are UUIDs, so one unread namespace
// serves both without any chance of collision.
const unreadKey = (owner, other) => `unread:${owner}:${other}`;
const groupKey = (id) => `gdm:${id}`;
const userGroupKey = (uid, id) => `ugdm:${uid}:${id}`;
const GDM_ID_RE = /^g[a-f0-9]{12}$/;

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

  /* ------------------------------- groups -------------------------------- */
  // A group DM is the same idea as a 1:1 one: the hub owns the membership list
  // and the secret code, and the conversation itself is an ordinary
  // ConcordServer that only the members are ever told the code for.

  async loadGroup(id) {
    if (!GDM_ID_RE.test(id)) return null;
    return await this.state.storage.get(groupKey(id));
  }

  async publicGroup(group) {
    const members = [];
    for (const uid of group.members) {
      const acct = await this.state.storage.get(`user:${uid}`);
      members.push(this.publicUser(uid, acct));
    }
    return {
      id: group.id,
      code: group.code,
      name: group.name,
      icon: group.icon,
      owner: group.owner,
      members,
    };
  }

  // Tells every current member something, optionally skipping one uid.
  async tellGroup(group, payload, skipUid = null) {
    for (const uid of group.members) {
      if (uid === skipUid) continue;
      this.sendToUser(uid, payload);
    }
  }

  async saveGroup(group) {
    const writes = { [groupKey(group.id)]: group };
    for (const uid of group.members) writes[userGroupKey(uid, group.id)] = 1;
    await this.state.storage.put(writes);
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

        // Group conversations this account belongs to.
        const groups = [];
        const groupRows = await storage.list({ prefix: `ugdm:${uid}:` });
        for (const key of groupRows.keys()) {
          const group = await storage.get(groupKey(key.slice(`ugdm:${uid}:`.length)));
          if (!group || !group.members.includes(uid)) continue;
          const unread = (await storage.get(unreadKey(uid, group.id))) || 0;
          if (unread) dmUnread[group.id] = unread;
          groups.push(await this.publicGroup(group));
        }

        ws.send(
          JSON.stringify({
            type: "hub-welcome",
            you: this.publicUser(uid, acct),
            token: acct.token,
            friends,
            incoming,
            outgoing,
            groups,
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
        const acct = await this.account(s.uid);
        const preview = cleanText(m.preview, 120);

        // Group flavour: fan out to everyone else in the group.
        if (m.gdm) {
          const group = await this.loadGroup(cleanText(m.gdm, 40));
          if (!group || !group.members.includes(s.uid)) return;
          for (const uid of group.members) {
            if (uid === s.uid) continue;
            const key = unreadKey(uid, group.id);
            const count = Math.min(((await storage.get(key)) || 0) + 1, 999);
            await storage.put(key, count);
            this.sendToUser(uid, {
              type: "dm-nudge",
              gdm: group.id,
              name: acct?.name || "Someone",
              groupName: group.name,
              preview,
              count,
            });
          }
          break;
        }

        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") return;
        const key = unreadKey(other, s.uid);
        const count = ((await storage.get(key)) || 0) + 1;
        await storage.put(key, Math.min(count, 999));
        this.sendToUser(other, {
          type: "dm-nudge",
          uid: s.uid,
          name: acct?.name || "Someone",
          preview,
          count: Math.min(count, 999),
        });
        break;
      }

      case "dm-read": {
        if (!s.uid) return;
        await storage.delete(unreadKey(s.uid, cleanText(m.uid, 40)));
        break;
      }

      case "gdm-create": {
        if (!s.uid) return;
        const wanted = Array.isArray(m.uids) ? m.uids.map((u) => cleanText(u, 40)).filter(Boolean) : [];
        // You can only pull in people you're actually friends with.
        const invited = [];
        for (const uid of wanted) {
          if (uid === s.uid || invited.includes(uid)) continue;
          const row = await storage.get(frKey(s.uid, uid));
          if (row?.state === "friend") invited.push(uid);
        }
        if (!invited.length) {
          ws.send(JSON.stringify({ type: "hub-error", error: "Pick at least one friend for the group." }));
          return;
        }
        if (invited.length + 1 > GDM_MAX_MEMBERS) {
          ws.send(JSON.stringify({ type: "hub-error", error: `Groups cap out at ${GDM_MAX_MEMBERS} people.` }));
          return;
        }
        const mine = await storage.list({ prefix: `ugdm:${s.uid}:` });
        if (mine.size >= GDM_CAP) {
          ws.send(JSON.stringify({ type: "hub-error", error: "That's a lot of group chats. Leave one first." }));
          return;
        }
        const members = [s.uid, ...invited];
        const group = {
          id: "g" + crypto.randomUUID().replace(/-/g, "").slice(0, 12),
          code: newServerCode() + newServerCode().slice(0, 4),
          name: cleanText(m.name, 40) || "",
          icon: cleanText(m.icon, 8) || "👥",
          owner: s.uid,
          members,
          at: Date.now(),
        };
        await this.saveGroup(group);
        const pub = await this.publicGroup(group);
        await this.tellGroup(group, { type: "gdm-added", group: pub });
        break;
      }

      case "gdm-open": {
        if (!s.uid) return;
        const group = await this.loadGroup(cleanText(m.id, 40));
        if (!group || !group.members.includes(s.uid)) return;
        await storage.delete(unreadKey(s.uid, group.id));
        ws.send(JSON.stringify({ type: "gdm-ready", group: await this.publicGroup(group) }));
        break;
      }

      case "gdm-add": {
        if (!s.uid) return;
        const group = await this.loadGroup(cleanText(m.id, 40));
        if (!group || !group.members.includes(s.uid)) return;
        const uid = cleanText(m.uid, 40);
        if (!uid || group.members.includes(uid)) return;
        const row = await storage.get(frKey(s.uid, uid));
        if (row?.state !== "friend") {
          ws.send(JSON.stringify({ type: "hub-error", error: "You can only add your own friends." }));
          return;
        }
        if (group.members.length >= GDM_MAX_MEMBERS) {
          ws.send(JSON.stringify({ type: "hub-error", error: `Groups cap out at ${GDM_MAX_MEMBERS} people.` }));
          return;
        }
        group.members.push(uid);
        await this.saveGroup(group);
        const pub = await this.publicGroup(group);
        await this.tellGroup(group, { type: "gdm-added", group: pub });
        break;
      }

      case "gdm-rename": {
        if (!s.uid) return;
        const group = await this.loadGroup(cleanText(m.id, 40));
        if (!group || !group.members.includes(s.uid)) return;
        if (m.name !== undefined) group.name = cleanText(m.name, 40);
        if (m.icon !== undefined) group.icon = cleanText(m.icon, 8) || group.icon;
        await this.saveGroup(group);
        await this.tellGroup(group, { type: "gdm-added", group: await this.publicGroup(group) });
        break;
      }

      case "gdm-leave": {
        if (!s.uid) return;
        const group = await this.loadGroup(cleanText(m.id, 40));
        if (!group || !group.members.includes(s.uid)) return;
        group.members = group.members.filter((u) => u !== s.uid);
        await storage.delete([userGroupKey(s.uid, group.id), unreadKey(s.uid, group.id)]);
        ws.send(JSON.stringify({ type: "gdm-removed", id: group.id }));
        if (group.members.length < 2) {
          // Nobody left to talk to — drop the record entirely.
          const leftovers = group.members.map((u) => userGroupKey(u, group.id));
          await storage.delete([groupKey(group.id), ...leftovers]);
          await this.tellGroup(group, { type: "gdm-removed", id: group.id });
          break;
        }
        await storage.put(groupKey(group.id), group);
        await this.tellGroup(group, { type: "gdm-added", group: await this.publicGroup(group) });
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

// A filename ends up inside an R2 key and inside a Content-Disposition header,
// so separators, dot-dot and quotes all have to be gone before it gets there.
function cleanFileName(v) {
  const name = cleanText(v, 80)
    .replace(/[\\/]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^[._-]+/, "");
  return name.slice(0, 80) || "file";
}

function safeMime(v) {
  const mime = typeof v === "string" ? v.split(";")[0].trim().toLowerCase() : "";
  return SAFE_MIMES.has(mime) ? mime : "application/octet-stream";
}

function clampInt(v, lo, hi) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
}
