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
const SEARCH_SCAN = 1200; // messages examined per search, split across channels
const SEARCH_HITS = 40;
const ARCH_BATCH = 50; // evicted messages per archive object
const ARCH_BUF_CAP = 400; // evictions we hold in the DO while R2 is unreachable
const ARCH_LIST_PAGES = 10; // R2 list pages walked per archive read
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

// A DM is not a guild with two people in it. Every op below exists so an owner
// can shape a server, and a DM has no owner — so in a DM they instead let
// either party quietly destroy the conversation. `create-channel` and
// `delete-channel` were gated on `joined` alone, which meant a member could
// clear the "keep one of each type" floor with a decoy channel and then delete
// the real one, taking the history and its attachments with it; `ban` let
// whoever opened the conversation first evict the other party from it forever.
const DM_FORBIDDEN = new Set([
  "create-channel", "delete-channel", "update-server", "kick", "ban", "unban", "bans",
]);

// Whether a DM realm still lets an uncredentialed `hello` through. See dmGate():
// enforcement switches itself on per conversation the first time any member
// proves an updated client, so this is the lever that closes the window for
// everyone at once once the client has actually shipped.
const DM_AUTH_GRACE = true;

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

    if (url.pathname.startsWith("/api/invite/")) {
      return handleInvitePeek(request, env, url);
    }

    if (url.pathname.startsWith("/api/upload/")) {
      return handleUpload(request, env, url);
    }

    // Must run before the asset server, or /f/ would be a 404 from the SPA
    // fallback instead of a file.
    if (url.pathname.startsWith("/f/")) {
      return serveFile(request, env, url);
    }

    return withCsp(await env.ASSETS.fetch(request));
  },
};

// Second line of defence behind the escaping, for a message pipeline that ends
// in innerHTML. Only the HTML document carries it: /f/ serves user uploads and
// already has its own non-negotiable headers, and a policy on a WebSocket
// upgrade means nothing.
//
// img-src is deliberately wide open. Pasting a link to a picture and having the
// picture appear is a feature this app has, so locking images down to 'self'
// would quietly delete it — and an <img> is not a script-execution vector, which
// is what the rest of this policy is for. 'unsafe-inline' in style-src is
// likewise not optional: the client sets element.style all over the place.
// No frame-src: the YouTube embed is a thumbnail and a link, never an iframe.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function withCsp(res) {
  if (!/^text\/html/i.test(res.headers.get("Content-Type") || "")) return res;
  const headers = new Headers(res.headers);
  headers.set("Content-Security-Policy", CSP);
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
  try {
    await env.FILES.put(claim.key, request.body, {
      httpMetadata: { contentType: claim.mime },
    });
  } catch {
    // The claim already wrote `att:<key>`, which is the client's permission to
    // attach this key to a message. If the bytes never landed, that permission
    // has to go with them, or a dropped connection posts a 404 into history.
    await stub.fetch(`https://do/internal/unclaim?key=${encodeURIComponent(claim.key)}`);
    return new Response("upload failed", { status: 502 });
  }

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

// Module scope, not a Durable Object: this is one cheap GET with no socket
// and no per-server home to hang a counter on, so a plain per-isolate Map is
// enough to blunt a script working through the alphabet from one address. It
// resets whenever the isolate does and has no sweep, same trade ConcordHub's
// own in-memory `probes` Map makes for the same reason — a friend group does
// not produce enough distinct IPs to make that a leak worth guarding.
const INVITE_PEEK_WINDOW_MS = 60_000;
const INVITE_PEEKS_PER_WINDOW = 20; // same order as the hub's tag-probe budget
const invitePeeks = new Map(); // ip -> [timestamps]

function overInvitePeekRate(ip) {
  if (!ip) return false; // no CF-Connecting-IP under `wrangler dev` — no limit beats a crash
  const now = Date.now();
  const hits = (invitePeeks.get(ip) || []).filter((t) => now - t < INVITE_PEEK_WINDOW_MS);
  if (hits.length >= INVITE_PEEKS_PER_WINDOW) return true;
  hits.push(now);
  invitePeeks.set(ip, hits);
  return false;
}

// GET /api/invite/<CODE> — what an invite link is worth before you've spent a
// name and an avatar on it. /ws?server=CODE already answers this exact
// question via 404 vs 101, so this doesn't hand a guesser anything new; it
// does turn the question into a bare GET with no WebSocket upgrade to
// complete, which is why it gets its own tighter budget and a short cache
// instead of riding on the socket path's limits.
async function handleInvitePeek(request, env, url) {
  const code = url.pathname.slice("/api/invite/".length).toUpperCase();
  if (!CODE_RE.test(code)) return new Response("not found", { status: 404 });

  const ip = cleanText(request.headers.get("CF-Connecting-IP"), 64);
  if (overInvitePeekRate(ip)) return new Response("slow down", { status: 429 });

  // idFromName is free; the fetch below is what actually wakes the object, so
  // a miss here costs exactly what a miss on /ws?server=CODE already costs —
  // one DO invocation reading an empty `meta`, nothing written.
  const stub = env.SERVERS.get(env.SERVERS.idFromName(code));
  let res;
  try {
    res = await stub.fetch("https://do/internal/invite-peek");
  } catch {
    return new Response("not found", { status: 404 });
  }
  if (!res.ok) return new Response("not found", { status: 404 });

  return new Response(await res.text(), {
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
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

// Archive keys pad to the same width as `msg:` for the same reason: both DO
// storage and R2 order keys as strings, so the padding is the only thing that
// makes "sorted" and "chronological" the same sentence.
const archBufPrefix = (chanId) => `archbuf:${chanId}:`;
const archBufKey = (chanId, seq) => archBufPrefix(chanId) + String(seq).padStart(8, "0");
const archPrefix = (code, chanId) => `arch/${code}/${chanId}/`;
const archKey = (code, chanId, first, last) =>
  `${archPrefix(code, chanId)}${String(first).padStart(8, "0")}-${String(last).padStart(8, "0")}.jsonl`;
const archFirstSeq = (key) => Number(key.split("/").pop().split("-")[0]);

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
    // The upload budget is the one limiter that is NOT allowed to fail open:
    // everything else it guards costs a broadcast, that one costs 25 MB of R2
    // per call, so it lives in storage instead of here.
    this.flushing = new Set(); // chanIds with an archive flush in flight
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

    // The other half of a claim: an upload that never made it to R2 gives back
    // the permission it was handed.
    if (url.pathname === "/internal/unclaim") {
      const key = url.searchParams.get("key") || "";
      if (ATT_KEY_RE.test(key)) await this.state.storage.delete(`att:${key}`);
      return Response.json({ ok: true });
    }

    // What GET /api/invite/<CODE> is allowed to know: the name and icon, and
    // the OWNER's name if `meta.owner` already has a roster row for it — both
    // already sitting in storage, so nothing new gets written or kept for this.
    // Read-only end to end: a probe, hit or miss, leaves no trace.
    //
    // Deliberately `owner`, not `inviter`. We have no idea who sent you the
    // link — anyone with the code can — so calling it the inviter would be a
    // guess presented as a fact, and wrong every time somebody shares a server
    // they don't own.
    // A conversation is not a joinable server, so `kind: "dm"` answers exactly
    // like an unknown code — a DM/group code is never distinguishable from a
    // 404 through this door. `meta.kind` is settled once, at creation, by
    // asking the hub (see hubOwnsCode below), so this needs no second hub
    // round trip to enforce the same thing again.
    if (url.pathname === "/internal/invite-peek") {
      const meta = await this.state.storage.get("meta");
      if (!meta || meta.kind === "dm") return new Response("not found", { status: 404 });
      const out = { name: meta.name, icon: meta.icon };
      if (meta.owner) {
        const owner = await this.state.storage.get(`roster:${meta.owner}`);
        if (owner?.name) out.owner = owner.name;
      }
      return Response.json(out);
    }

    // The hub telling us somebody just stopped being a member. Checking
    // membership on `hello` alone would leave whoever is already connected
    // sitting inside the conversation they were removed from until they chose
    // to reconnect, which is not what "removed" means to the person who did it.
    if (url.pathname === "/internal/evict") {
      const uid = url.searchParams.get("uid") || "";
      if (uid) {
        for (const [ws, s] of this.sessions) {
          if (s.hubUid !== uid) continue;
          try {
            ws.send(JSON.stringify({ type: "dm-denied", error: "You're not in this conversation." }));
            ws.close(4005, "not a member");
          } catch {}
        }
      }
      return Response.json({ ok: true });
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
      // Whether this code is a conversation is the hub's fact, not the
      // client's. It used to arrive as `&kind=dm` on the connect URL, which
      // meant a DM's entire feature set — owner, bans, channel management —
      // hinged on a string the connecting browser chose for itself.
      const isDm = await this.hubOwnsCode(joining);
      meta = {
        name: cleanText(url.searchParams.get("name"), 40) || "New Server",
        icon: cleanText(url.searchParams.get("icon"), 8) || "🎮",
        kind: isDm ? "dm" : "guild",
        createdAt: Date.now(),
      };
      // A DM has nobody to be in charge of it, and `hello` knows not to fill
      // this in for a conversation.
      if (isDm) meta.owner = null;
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
    } else if (meta.kind === "dm" && meta.owner) {
      // Migration, run once per conversation. DMs minted while `kind` was a URL
      // parameter were plain servers, so whoever opened one first became its
      // owner — and could then ban the other party out of their own
      // conversation with no unban path the victim could reach. Both the title
      // and everything done with it go: a ban list nobody can administer is
      // just a permanent exclusion.
      meta.owner = null;
      const bans = await this.state.storage.list({ prefix: "ban:" });
      if (bans.size) await this.state.storage.delete([...bans.keys()]);
      await this.state.storage.put("meta", meta);
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
  // dormant ones. What must never be swept is an identity the server still
  // remembers anywhere else: an `auth:` row is the *only* proof a userId is
  // taken, so deleting one while a roster row still names that person turns
  // them into an unclaimed identity anybody can walk up and assume. Exempting
  // only live sockets meant flooding 300 throwaway hellos while the owner had
  // their tab shut was enough to inherit the server. ROSTER_CAP (200) is below
  // AUTH_CAP (300), so keeping every remembered member always fits.
  async sweepAuth(now) {
    const rows = await this.state.storage.list({ prefix: "auth:" });
    const live = new Set();
    for (const s of this.sessions.values()) {
      if (s.userId) live.add(`auth:${s.userId}`);
    }
    for (const entry of await this.rosterList()) {
      if (entry?.userId) live.add(`auth:${entry.userId}`);
    }
    const meta = await this.state.storage.get("meta");
    if (meta?.owner) live.add(`auth:${meta.owner}`);
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
    // Upload budgets are windows, not records — once the window has rolled past
    // the row says nothing and is just a per-identity leak.
    for (const [key, stamps] of await storage.list({ prefix: "ub:" })) {
      if (!(stamps?.length && now - stamps[stamps.length - 1] < 600_000)) doomed.push(key);
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

  /* ------------------------------ the archive ------------------------------ */
  // The 300-message ring used to be the whole story: whatever fell off the end
  // was deleted and that was that, which is fine for a demo and useless for a
  // group that talks. Now the evicted message lands in a durable per-channel
  // buffer and, every ARCH_BATCH evictions, in one immutable JSONL object in
  // R2. R2 cannot append, so the alternative — one growing object per channel —
  // would mean reading and rewriting the entire history of a channel on every
  // single message. Batches of 50 keep each write O(50) forever.

  async archiveCode() {
    const code = this.code || (await this.state.storage.get("code")) || "";
    return CODE_RE.test(code) ? code : "";
  }

  // Called from the `msg` hot path, so the only thing it waits on is the DO
  // write. The R2 upload is deliberately *not* awaited — a person pressing
  // enter should never pay for a bucket round trip — and rides waitUntil so the
  // runtime keeps us alive until it lands.
  async archivePush(chanId, msg) {
    await this.state.storage.put(archBufKey(chanId, msg.id), msg);
    if (msg.id % ARCH_BATCH !== 0) return;
    const flush = this.archiveFlush(chanId).catch(() => {});
    this.state.waitUntil?.(flush);
  }

  // Crash tolerance lives in the ordering here: the buffer is written before
  // the flush starts and cleared only after R2 has acknowledged, so a DO that
  // dies mid-flush loses nothing and simply replays. A replay writes the same
  // messages to the same key, which overwrites rather than duplicates — and the
  // read path dedupes by id anyway, for the window where both copies exist.
  async archiveFlush(chanId) {
    if (!this.env.FILES || this.flushing.has(chanId)) return;
    const code = await this.archiveCode();
    if (!code) return;
    this.flushing.add(chanId);
    try {
      const rows = await this.state.storage.list({
        prefix: archBufPrefix(chanId),
        limit: ARCH_BUF_CAP + ARCH_BATCH,
      });
      if (!rows.size) return;
      const msgs = [...rows.values()];
      await this.env.FILES.put(
        archKey(code, chanId, msgs[0].id, msgs[msgs.length - 1].id),
        msgs.map((x) => JSON.stringify(x)).join("\n"),
        { httpMetadata: { contentType: "application/x-ndjson" } }
      );
      await this.state.storage.delete([...rows.keys()]);
    } catch {
      await this.archiveTrim(chanId);
    } finally {
      this.flushing.delete(chanId);
    }
  }

  // An R2 outage must not turn the buffer into an unbounded leak inside the DO.
  // Past the cap we drop the *oldest* unflushed messages: they are the furthest
  // from anything someone is about to scroll back to, and dropping from that
  // end leaves the surviving range contiguous with the live window. Their
  // attachments become orphans in the bucket — the same deal sweepUploads
  // already accepts, for the same reason.
  async archiveTrim(chanId) {
    try {
      const rows = await this.state.storage.list({
        prefix: archBufPrefix(chanId),
        limit: ARCH_BUF_CAP + ARCH_BATCH,
      });
      if (rows.size <= ARCH_BUF_CAP) return;
      await this.state.storage.delete([...rows.keys()].slice(0, rows.size - ARCH_BUF_CAP));
    } catch {}
  }

  async archiveObjects(code, chanId) {
    const prefix = archPrefix(code, chanId);
    const keys = [];
    let cursor;
    for (let page = 0; page < ARCH_LIST_PAGES; page++) {
      const res = await this.env.FILES.list({ prefix, cursor, limit: 1000 });
      for (const o of res.objects) keys.push(o.key);
      if (!res.truncated) break;
      cursor = res.cursor;
    }
    return keys;
  }

  // The newest `need` archived messages older than `ceiling`. The unflushed
  // buffer is consulted first because it holds the ones nearest the live
  // window — which is exactly where someone scrolling up arrives first.
  async archiveRead(chanId, ceiling, need) {
    if (need <= 0 || !(ceiling > 1)) return [];
    const byId = new Map();
    const rows = await this.state.storage.list({
      prefix: archBufPrefix(chanId),
      end: archBufKey(chanId, ceiling),
      reverse: true,
      limit: need,
    });
    for (const msg of rows.values()) byId.set(msg.id, msg);
    if (byId.size < need && this.env.FILES) {
      const code = await this.archiveCode();
      try {
        const keys = code
          ? (await this.archiveObjects(code, chanId)).filter((k) => archFirstSeq(k) < ceiling)
          : [];
        // Backwards: objects sort by their first seq, so the tail of the list
        // is the newest history and the first thing wanted.
        for (let i = keys.length - 1; i >= 0 && byId.size < need; i--) {
          const obj = await this.env.FILES.get(keys[i]);
          if (!obj) continue;
          for (const msg of parseJsonl(await obj.text())) {
            if (msg.id < ceiling) byId.set(msg.id, msg);
          }
        }
      } catch {
        // A bucket we cannot reach means a short page, not a broken channel.
      }
    }
    return [...byId.values()].sort((a, b) => a.id - b.id).slice(-need);
  }

  // Is there anything older than `oldest`? Answered from the cheap end first:
  // a channel that never filled its ring has no archive at all, and the DO-side
  // buffer answers most of the rest without touching R2.
  async archiveHasOlder(chanId, oldest) {
    if (!(oldest > 1)) return false;
    if (((await this.state.storage.get(`chanseq:${chanId}`)) || 0) <= MSG_CAP) return false;
    const rows = await this.state.storage.list({ prefix: archBufPrefix(chanId), limit: 1 });
    for (const msg of rows.values()) if (msg.id < oldest) return true;
    if (!this.env.FILES) return false;
    const code = await this.archiveCode();
    if (!code) return false;
    try {
      const res = await this.env.FILES.list({ prefix: archPrefix(code, chanId), limit: 1 });
      return !!res.objects.length && archFirstSeq(res.objects[0].key) < oldest;
    } catch {
      return false;
    }
  }

  // Deleting a channel has to take its archive with it, or the channel is gone
  // from every list while everything it ever held stays in the bucket.
  async archivePurge(chanId) {
    const storage = this.state.storage;
    const rows = await storage.list({ prefix: archBufPrefix(chanId) });
    await this.dropMessageFiles([...rows.values()]);
    if (rows.size) await storage.delete([...rows.keys()]);
    if (!this.env.FILES) return;
    const code = await this.archiveCode();
    if (!code) return;
    try {
      const keys = await this.archiveObjects(code, chanId);
      for (const key of keys) {
        const obj = await this.env.FILES.get(key);
        if (obj) await this.dropMessageFiles(parseJsonl(await obj.text()));
      }
      for (let i = 0; i < keys.length; i += 1000) await this.dropObjects(keys.slice(i, i + 1000));
    } catch {}
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
      // The `att:` row is minted when the ticket is claimed, which is *before*
      // the bytes are streamed — so an upload that died halfway leaves a record
      // pointing at nothing. Ask the bucket, the way consumeAsset already does,
      // or a flaky connection writes a permanently broken image into history.
      const head = await this.env.FILES?.head(key);
      await storage.delete(`att:${key}`);
      if (!head) continue;
      const att = {
        key,
        url: `/f/${key}`,
        name: cleanFileName(a.name) || key.split("/").pop(),
        size: clampInt(head.size, 0, MAX_FILE_BYTES),
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

  async isDirect() {
    return (await this.state.storage.get("meta"))?.kind === "dm";
  }

  /* ---------------------------- the hub, asked ---------------------------- */
  // §12 of CONTRACTS says a code is a bearer capability and the hub's
  // membership list is bookkeeping, not enforcement. For a conversation that is
  // wrong in the one place it matters: leaving a group and unfriending are both
  // supposed to *take something away*, and neither did. So a realm the hub owns
  // asks the hub who is allowed in — live, on every connect, so a removal takes
  // effect immediately with no rotation, no expiry window and no history loss.
  // The cost is one DO-to-DO fetch per DM `hello`; nothing on the message path.

  hubStub() {
    return this.env.HUB ? this.env.HUB.get(this.env.HUB.idFromName("hub")) : null;
  }

  async hubOwnsCode(code) {
    const stub = this.hubStub();
    if (!stub || !CODE_RE.test(code)) return false;
    try {
      const res = await stub.fetch(`https://do/internal/code-kind?code=${encodeURIComponent(code)}`);
      return res.ok && !!(await res.json()).direct;
    } catch {
      return false;
    }
  }

  // `known: false` means the hub has never minted this code and has no opinion
  // about it — a conversation from before the hub wrote its codes down. Those
  // are grandfathered rather than bricked; see dmGate().
  async hubMembership(code, uid, token) {
    const stub = this.hubStub();
    if (!stub) return { known: false };
    try {
      const res = await stub.fetch(
        `https://do/internal/dm-member?code=${encodeURIComponent(code)}` +
          `&uid=${encodeURIComponent(uid)}&token=${encodeURIComponent(token)}`
      );
      if (!res.ok) return { known: false };
      return await res.json();
    } catch {
      // An unreachable hub must not become an open door.
      return { known: true, ok: false };
    }
  }

  // Backward compatibility, decided deliberately. An older client sends no hub
  // credentials at all, so refusing every uncredentialed hello would lock every
  // existing conversation until the update reached every open tab. Instead
  // enforcement arms itself per conversation the first time *any* member proves
  // an updated client, and that fact is recorded on the realm. Before the flip a
  // conversation is exactly as bearer-only as it was yesterday — no worse; after
  // it, nobody can opt out by simply omitting the credentials, which is the only
  // property that matters. DM_AUTH_GRACE closes the window for everyone at once.
  async dmGate(m, meta) {
    const hubUid = cleanText(m.hubUid, 40);
    const hubToken = cleanText(m.hubToken, 64);
    const code = this.code || (await this.state.storage.get("code")) || "";
    if (!hubUid || !hubToken) {
      if (meta.dmAuth || !DM_AUTH_GRACE) {
        return { ok: false, error: "This conversation needs an up-to-date Concord. Reload the page." };
      }
      return { ok: true };
    }
    const verdict = await this.hubMembership(code, hubUid, hubToken);
    if (!verdict.known) return { ok: true, hubUid };
    if (!verdict.ok) return { ok: false, error: "You're not in this conversation." };
    if (!meta.dmAuth) {
      meta.dmAuth = true;
      await this.state.storage.put("meta", meta);
    }
    return { ok: true, hubUid };
  }

  // Does this server still know who that userId is, independently of `auth:`?
  async isRemembered(userId) {
    if (await this.state.storage.get(`roster:${userId}`)) return true;
    return await this.isOwner(userId);
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
  // socket open is exempt, and so is the owner — evicting someone mid-
  // conversation would be absurd, and evicting the owner unpicks `isRemembered`.
  //
  // "Least recently seen" was the wrong rule for the *cap*, because cap pressure
  // is the half an attacker manufactures. Two hundred throwaway hellos pushed
  // the oldest real member out of the roster, and sweepAuth only exempts people
  // the roster still names — so the two sweeps together handed out a remembered
  // identity. Age still evicts oldest-first, which is what a sweep is for; a cap
  // breach evicts the *newest* cold rows instead, which are the ones that caused
  // it. A flood therefore evicts itself.
  async sweepRoster() {
    const rows = await this.state.storage.list({ prefix: "roster:" });
    if (rows.size <= ROSTER_CAP) return;
    const live = new Set();
    for (const s of this.sessions.values()) if (s.userId) live.add(`roster:${s.userId}`);
    const owner = (await this.state.storage.get("meta"))?.owner;
    if (owner) live.add(`roster:${owner}`);
    const now = Date.now();
    const cold = [...rows]
      .filter(([key]) => !live.has(key))
      .sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
    const doomed = cold.filter(([, e]) => now - (e?.at || 0) > AUTH_TTL_MS).map(([key]) => key);
    const over = rows.size - doomed.length - ROSTER_CAP;
    if (over > 0) {
      const dead = new Set(doomed);
      const newestFirst = cold.filter(([key]) => !dead.has(key)).reverse();
      for (const [key] of newestFirst.slice(0, over)) doomed.push(key);
    }
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
  // itself out of its own moderation forever. But only to *someone*: an owner
  // of `null` was a takeover waiting to happen, because the next hello through
  // the door claims an unowned server. When the last member walks out there is
  // nobody to inherit, so the departing owner keeps the title — they can come
  // back with their token, and nobody else can.
  async removeMember(userId, closeSockets) {
    const storage = this.state.storage;
    await storage.delete(`roster:${userId}`);
    const meta = await storage.get("meta");
    if (meta?.owner === userId) {
      const rows = await this.rosterList();
      const heir = rows.sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0))[0];
      if (heir?.userId) {
        meta.owner = heir.userId;
        await storage.put("meta", meta);
        this.broadcast({ type: "server-meta", meta });
      }
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

  // Kept in storage rather than in a Map. Every other limiter here fails open
  // after a hibernation wake-up and that's a fair trade for one extra emoji;
  // this one guards 25 MB writes into a bucket, and "wait for the DO to sleep"
  // is not a lock anyone should have to respect voluntarily.
  async uploadBudget(userId, count, now) {
    const key = `ub:${userId}`;
    const recent = ((await this.state.storage.get(key)) || []).filter((t) => now - t < 600_000);
    if (recent.length + count > UPLOADS_PER_10MIN) return false;
    for (let i = 0; i < count; i++) recent.push(now);
    await this.state.storage.put(key, recent);
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
    if (DM_FORBIDDEN.has(m.type) && (await this.isDirect())) return;

    switch (m.type) {
      case "hello": {
        // Identity is claimed exactly once per connection. Without this a
        // client could re-hello on a live socket to assume another member's
        // userId (their messages, their prank cooldown) at will.
        if (s.joined) return;

        // For a conversation, membership is checked before anything is written:
        // somebody who was removed should get no session, no roster row and no
        // storage write out of us.
        const helloMeta = await storage.get("meta");
        let gateUid = "";
        if (helloMeta?.kind === "dm") {
          const gate = await this.dmGate(m, helloMeta);
          if (!gate.ok) {
            ws.send(JSON.stringify({ type: "dm-denied", error: gate.error }));
            try {
              ws.close(4005, "not a member");
            } catch {}
            return;
          }
          gateUid = gate.hubUid || "";
        }

        // A userId is owned by whoever first claimed it here, proven by a
        // server-issued token. Present the wrong token and you get a fresh
        // identity instead of someone else's.
        const claimed = cleanText(m.userId, 40);
        const presented = cleanText(m.token, 64);
        const tokenOf = (row) => (typeof row === "string" ? row : row?.token);
        let userId = claimed;
        if (userId) {
          const owner = tokenOf(await storage.get(`auth:${userId}`));
          if (owner) {
            if (owner !== presented) userId = "";
          } else if (await this.isRemembered(userId)) {
            // No `auth:` row, but the server still knows this person — they hold
            // a roster row, or they own the place. The absence of a token row is
            // then a hole in our own bookkeeping, not permission: an identity we
            // remember must never be claimable by someone who can't prove it.
            userId = "";
          }
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
        // Remembered so the hub can have this socket dropped the moment its
        // owner stops being a member; see /internal/evict.
        if (gateUid) s.hubUid = gateUid;
        this.saveSession(ws, s);

        const meta = await storage.get("meta");
        // Whoever turns up first is in charge. There is no other moment at
        // which we could possibly tell — except in a conversation, which has no
        // owner at all, because "first to open it" is not a claim to the other
        // person's messages.
        if (meta && meta.kind !== "dm" && !meta.owner) {
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

        const slowKey = chan.slow && !(await this.isOwner(s.userId)) ? `${s.userId}:${chanId}` : "";
        if (slowKey) {
          const waited = Date.now() - (this.slowAt.get(slowKey) || 0);
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
        }

        const attachments = await this.claimAttachments(s, m.attachments);
        if (!content && !attachments.length) return;
        // Only a message that actually posts spends the slowmode slot. Charging
        // for one the server then drops leaves you waiting out a cooldown for
        // something nobody ever saw.
        if (slowKey) this.slowAt.set(slowKey, Date.now());

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
              content: clip(parent.content, 120),
            };
          }
        }
        const writes = { [seqKey]: seq, [msgKey(chanId, seq)]: msg };
        await storage.put(writes);
        if (seq > MSG_CAP) {
          // What falls off the end is archived, not destroyed — and its
          // attachments deliberately go with it rather than being deleted. An
          // archive full of broken images would be worse than no archive, so
          // attachment storage now grows with history instead of staying capped
          // at 300 messages a channel. Against a 10 GB free tier and a friend
          // group that is the trade we want; an explicit `delete` still takes
          // the files with it, and so does deleting the channel.
          const evictedKey = msgKey(chanId, seq - MSG_CAP);
          const evicted = await storage.get(evictedKey);
          if (evicted) await this.archivePush(chanId, evicted);
          await storage.delete(evictedKey);
          // The pin index used to only notice its dead entries when someone
          // opened the pin list. Eviction knows exactly which id just left.
          if (evicted?.pinned) {
            const idxKey = `pins:${chanId}`;
            const ids = ((await storage.get(idxKey)) || []).filter((id) => id !== evicted.id);
            await storage.put(idxKey, ids);
          }
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
        const before = Number(m.before) || 0;
        const opts = {
          prefix: `msg:${chanId}:`,
          reverse: true,
          limit: HISTORY_PAGE,
        };
        if (before) opts.end = msgKey(chanId, before);
        const map = await storage.list(opts);
        let messages = [...map.values()].reverse();
        // Once the live window runs out the archive fills the rest of the page.
        // Deliberately the same `history` frame: the client already knows how
        // to render one, and paging past 300 messages shouldn't need it to
        // learn a second way of receiving the same thing.
        if (messages.length < HISTORY_PAGE) {
          const ceiling = messages.length ? messages[0].id : before || Number.MAX_SAFE_INTEGER;
          const older = await this.archiveRead(chanId, ceiling, HISTORY_PAGE - messages.length);
          if (older.length) messages = older.concat(messages);
        }
        ws.send(
          JSON.stringify({
            type: "history",
            chanId,
            messages,
            before: m.before || null,
            // So the client can offer "load older" instead of guessing from a
            // short page whether it has reached the beginning.
            hasArchive: await this.archiveHasOlder(chanId, messages.length ? messages[0].id : before),
          })
        );
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
        // One budget consumed in channel order meant the first four full
        // channels ate all 1200 and every channel after them was never looked
        // at — silently, because `truncated` only ever meant "40 hits". Each
        // target gets its own share instead, and anything we didn't finish
        // reading says so. Stopping early is fine; not admitting it isn't.
        const budget = Math.max(1, Math.floor(SEARCH_SCAN / (targets.length || 1)));
        const hits = [];
        let partial = false;
        for (const c of targets) {
          if (hits.length >= SEARCH_HITS) break;
          const rows = await storage.list({ prefix: `msg:${c.id}:`, reverse: true, limit: budget });
          for (const msg of rows.values()) {
            if (msg.content.toLowerCase().includes(q)) {
              hits.push({ ...msg, chanName: c.name });
              if (hits.length >= SEARCH_HITS) break;
            }
          }
          // Either we stopped at this channel's share, or the channel is full
          // and the rest of it is in the archive, which search does not read.
          if (rows.size >= Math.min(budget, MSG_CAP)) partial = true;
        }
        ws.send(
          JSON.stringify({
            type: "search-results",
            q: m.q,
            chanId: scope,
            hits,
            truncated: hits.length >= SEARCH_HITS || partial,
          })
        );
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
        // Threads share this budget, so hitting the ceiling is realistic now and
        // a button that just stops working is the worst way to find out.
        if (channels.length >= CHANNEL_CAP) {
          ws.send(JSON.stringify({ type: "error", error: `${CHANNEL_CAP} channels is the ceiling. Delete something.` }));
          return;
        }
        // Two #random rows in one sidebar are indistinguishable from a bug, and
        // the name is how people refer to a channel out loud. Threads are exempt
        // — they're named after a moment rather than a topic, and two people
        // starting an "about that" on different messages is entirely reasonable.
        if (channels.some((c) => c.type === type && c.name === name)) {
          const label = type === "voice" ? `a voice channel called ${name}` : `a #${name}`;
          ws.send(JSON.stringify({ type: "error", error: `There's already ${label} here.` }));
          return;
        }
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
        const dying = [chan, ...channels.filter((c) => c.parent === chan.id)];
        const doomed = dying.map((c) => c.id);
        channels = channels.filter((c) => !doomed.includes(c.id));
        await storage.put("channels", channels);
        // A thread's chip lives on the message it grew from. Leave it behind and
        // the client renders a link into a channel that no longer exists, where
        // everything typed is silently dropped.
        for (const t of dying) {
          if (t.type !== "thread" || !t.parent || doomed.includes(t.parent)) continue;
          const rootKey = msgKey(t.parent, Number(t.rootId));
          const root = await storage.get(rootKey);
          if (!root || root.threadId !== t.id) continue;
          delete root.threadId;
          await storage.put(rootKey, root);
          this.broadcast({ type: "msg-thread", chanId: t.parent, msgId: root.id, threadId: null, name: "" });
        }
        for (const id of doomed) {
          const rows = await storage.list({ prefix: `msg:${id}:` });
          await this.dropMessageFiles([...rows.values()]);
          await this.archivePurge(id);
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
        // Every refusal on this path is tagged `for: "upload-ticket"` and echoes
        // the nonce. Without that, the client can't tell "your files were
        // refused" from an unrelated error thrown anywhere else in dispatch, so
        // one stray failure aborted the batch and stranded up to ten tickets in
        // storage for their whole five-minute TTL.
        const nonce = cleanText(m.nonce, 64) || undefined;
        const refuse = (error) =>
          ws.send(JSON.stringify({ type: "error", error, for: "upload-ticket", nonce }));
        if (!this.env.FILES) {
          refuse("Uploads aren't switched on here.");
          return;
        }
        const files = Array.isArray(m.files) ? m.files : [];
        if (!files.length || files.length > MAX_FILES_PER_MSG) {
          refuse(`${MAX_FILES_PER_MSG} files at a time, tops.`);
          return;
        }
        for (const f of files) {
          const size = Number(f?.size);
          if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
            refuse("Files cap out at 25 MB.");
            return;
          }
        }
        const now = Date.now();
        if (!(await this.uploadBudget(s.userId, files.length, now))) {
          refuse("That's a lot of uploading. Give it ten minutes.");
          return;
        }
        const pending = await storage.list({ prefix: "tkt:" });
        let mine = 0;
        for (const t of pending.values()) if (t?.userId === s.userId && t.exp > now) mine++;
        if (mine + files.length > MAX_PENDING_TICKETS) {
          refuse("Finish the uploads you already started.");
          return;
        }
        const code = this.code || (await storage.get("code")) || "";
        if (!CODE_RE.test(code)) {
          refuse("This server can't take uploads yet. Reconnect.");
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
            // The size the client declared is what it may actually spend. It was
            // MAX_FILE_BYTES here, which made the declaration decorative — you
            // could announce 10 bytes and upload 25 MB. The wire still quotes
            // the protocol ceiling, because that's the number a client needs to
            // know before it picks a file.
            max: clampInt(f?.size, 1, MAX_FILE_BYTES),
            userId: s.userId,
            exp: now + TICKET_TTL_MS,
          };
          tickets.push({ id, key, max: MAX_FILE_BYTES });
        }
        await storage.put(writes);
        // The nonce pairs this reply with the batch that asked for it; two
        // overlapping batches otherwise zip filenames against the wrong tickets.
        ws.send(JSON.stringify({ type: "upload-tickets", tickets, nonce }));
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
// Counted over accepted friends only. It used to count every `fr:` row, which
// includes *incoming* requests — so three hundred throwaway accounts each
// sending one request permanently locked the victim out of adding anybody,
// and the only way back was three hundred manual declines.
const FRIEND_CAP = 250;
// The separate ceiling that flood needed, enforced against the person being
// asked rather than the person asking. Past it a request is dropped and the
// sender is told the same thing they'd be told if it had landed.
const INCOMING_CAP = 60;
const GDM_MAX_MEMBERS = 10;
const GDM_CAP = 20; // group conversations per person
// Tags are short human slugs, which makes an unbounded `friend-add` a
// directory. The old limiter keyed on s.sid, minted fresh per socket, so it
// cost an attacker one extra WebSocket per thirty probes.
const PROBE_WINDOW_MS = 60_000;
const PROBES_PER_WINDOW = 12;
// Accounts are free and uncapped, which is what made the flood cheap. Absent
// under `wrangler dev`, where there is no CF-Connecting-IP to key on.
const ACCOUNTS_PER_IP_HOUR = 30;
const IP_WINDOW_MS = 60 * 60 * 1000;
const IP_SWEEP_EVERY = 50;
// A ring arrives unsolicited and aimed at one person, so the shared 30-per-5s
// ceiling below is the wrong tool on its own: that one is a flood guard, and
// ringing someone over and over is the harassment shape the block system exists
// for. Six a minute is already redialling every ten seconds. Keyed on the
// account rather than the socket, for the reason `probeBudget` spells out — a
// socket costs an attacker nothing to replace.
const RING_WINDOW_MS = 60_000;
const RINGS_PER_WINDOW = 6;
const HUB_RATE_LIMITED = new Set([
  "hello", "friend-add", "friend-accept", "friend-decline", "friend-remove",
  "presence", "set-tag", "dm-open", "dm-nudge", "dm-read", "poke",
  "gdm-create", "gdm-open", "gdm-leave", "gdm-add", "gdm-rename",
  "friend-block", "friend-unblock", "blocks", "call-ring", "call-end",
]);

const frKey = (a, b) => `fr:${a}:${b}`;
// `block:<uid>:<other>` — "uid does not want to hear from other". Written on
// decline, so a declined requester cannot simply ask again forever, and checked
// anywhere one person can reach another without being friends.
const blockKey = (a, b) => `block:${a}:${b}`;
// The record that makes a conversation code more than a bearer capability: what
// the hub minted this code *for*. ConcordServer asks about it on `hello`.
// Nothing deletes one, ever, and that is load-bearing in the same way `user:`
// is: a code the hub has forgotten is a code the realm grandfathers, so tidying
// these away re-opens every conversation they named.
const dmCodeKey = (code) => `dmcode:${code}`;
// Sorted, so the same pair always writes the same reference no matter which of
// the two happens to register the code first.
const dmRef = (a, b) => (a < b ? { kind: "dm", a, b } : { kind: "dm", a: b, b: a });
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
    // The IP half of the tag-probe limiter. In memory, unlike the per-account
    // half: one storage row per distinct IP would grow without bound, and this
    // object deliberately has no sweep over anything identity-shaped (see
    // `hello`). Losing it to hibernation costs an attacker a wait, not nothing.
    this.probes = new Map(); // ip -> [timestamps]
    // The call-ring budget, in memory for the same reason and with the same
    // caveat. Deliberately not a storage row: `call-ring` is the one op here
    // that writes nothing at all, and giving it a counter would be the first
    // step back towards the durable state it exists to avoid.
    this.rings = new Map(); // uid -> [timestamps]
    this.newAccounts = 0;
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
    const url = new URL(request.url);

    // Only the Worker and other Durable Objects hold a stub for this object, so
    // these two routes are not reachable from the internet. They are how a
    // conversation's ConcordServer asks the hub the one question it cannot
    // answer for itself.
    if (url.pathname === "/internal/code-kind") {
      const code = (url.searchParams.get("code") || "").toUpperCase();
      const ref = CODE_RE.test(code) ? await this.state.storage.get(dmCodeKey(code)) : null;
      return Response.json({ direct: !!ref });
    }
    if (url.pathname === "/internal/dm-member") {
      return Response.json(
        await this.dmMember(
          (url.searchParams.get("code") || "").toUpperCase(),
          url.searchParams.get("uid") || "",
          url.searchParams.get("token") || ""
        )
      );
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Cloudflare only sets this at the edge, so under `wrangler dev` it is
    // absent and every limiter keyed on it degrades to no limit rather than to
    // a crash. That's the right failure direction for a friend group.
    const ip = cleanText(request.headers.get("CF-Connecting-IP"), 64);
    const session = { sid: crypto.randomUUID().slice(0, 8), uid: null, ip };
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

  /* -------------------- conversations the hub vouches for ------------------- */
  // The hub always effectively owned the code → conversation mapping; it just
  // never wrote it down, which is why leaving a group revoked nothing. `dmcode:`
  // is that mapping, and the three answers below are the whole enforcement
  // story: what a code is, who is currently in it, and how to throw out someone
  // already inside.

  async registerCode(code, ref) {
    if (!CODE_RE.test(code || "")) return;
    const key = dmCodeKey(code);
    if (await this.state.storage.get(key)) return;
    await this.state.storage.put(key, ref);
  }

  // Answers ConcordServer's `hello`. `known:false` means this code predates the
  // registry and the hub has no opinion about it — never an implicit yes to a
  // code it *does* know.
  async dmMember(code, uid, token) {
    const storage = this.state.storage;
    const ref = CODE_RE.test(code) ? await storage.get(dmCodeKey(code)) : null;
    if (!ref) return { known: false };
    const acct = uid ? await storage.get(`user:${uid}`) : null;
    // The hub token is the only proof of a hub identity, so an unproven uid is
    // simply not that person — same rule as everywhere else in this file.
    if (!acct || acct.token !== token) return { known: true, ok: false };
    if (ref.kind === "gdm") {
      const group = await storage.get(groupKey(ref.id));
      return { known: true, ok: !!group && group.code === code && group.members.includes(uid) };
    }
    const other = ref.a === uid ? ref.b : ref.b === uid ? ref.a : "";
    if (!other) return { known: true, ok: false };
    // Read live rather than from the registry, so unfriending revokes on the
    // next connect with nothing to expire and nothing to re-key.
    const row = await storage.get(frKey(uid, other));
    return { known: true, ok: row?.state === "friend" && row.dm === code };
  }

  // Membership checked on `hello` alone would leave whoever is already
  // connected sitting inside the conversation they were removed from.
  async evict(code, uid) {
    if (!this.env.SERVERS || !CODE_RE.test(code || "") || !uid) return;
    try {
      await this.env.SERVERS.get(this.env.SERVERS.idFromName(code)).fetch(
        `https://do/internal/evict?uid=${encodeURIComponent(uid)}`
      );
    } catch {
      // A realm we cannot reach keeps them until their socket drops on its own.
    }
  }

  async isBlocked(by, who) {
    return !!(by && who && (await this.state.storage.get(blockKey(by, who))));
  }

  // Groups top out at ten people, so the naive pairwise walk is at most ninety
  // reads on an op nobody runs in a loop.
  async blockClash(uids) {
    for (const a of uids) {
      for (const b of uids) {
        if (a !== b && (await this.isBlocked(a, b))) return true;
      }
    }
    return false;
  }

  async blockList(uid) {
    const out = [];
    for (const key of (await this.state.storage.list({ prefix: `block:${uid}:` })).keys()) {
      out.push(key.slice(`block:${uid}:`.length));
    }
    return out;
  }

  // Ending a friendship has to take the conversation with it. The rows going
  // away is what `dmMember` reads, so the next connect is already refused; the
  // eviction is for whoever is sitting in there right now. The audit re-opened a
  // DM after being unfriended, read new messages and posted into it.
  async severFriendship(uid, other, row) {
    await this.state.storage.delete([
      frKey(uid, other),
      frKey(other, uid),
      unreadKey(uid, other),
      unreadKey(other, uid),
    ]);
    if (row?.dm) {
      await this.evict(row.dm, uid);
      await this.evict(row.dm, other);
    }
  }

  // Keyed on the account and on the source IP rather than on the socket, which
  // was free to replace: ten sockets answered 250 probes in a second and a half.
  // The account half lives in storage because an attacker can simply wait for
  // this object to hibernate and take the in-memory half with it.
  async probeBudget(s) {
    const now = Date.now();
    if (s.ip) {
      const hits = (this.probes.get(s.ip) || []).filter((t) => now - t < PROBE_WINDOW_MS);
      if (hits.length >= PROBES_PER_WINDOW) return false;
      hits.push(now);
      this.probes.set(s.ip, hits);
    }
    const key = `probe:${s.uid}`;
    const mine = ((await this.state.storage.get(key)) || []).filter((t) => now - t < PROBE_WINDOW_MS);
    if (mine.length >= PROBES_PER_WINDOW) return false;
    mine.push(now);
    await this.state.storage.put(key, mine);
    return true;
  }

  // Only `call-ring` spends from this. `call-end` deliberately doesn't: rate
  // limiting the retraction is exactly how you end up with a ring nobody can
  // take back down, and a frame whose whole job is to remove a notification
  // isn't worth defending against.
  ringBudget(uid) {
    const now = Date.now();
    const hits = (this.rings.get(uid) || []).filter((t) => now - t < RING_WINDOW_MS);
    this.rings.set(uid, hits);
    if (hits.length >= RINGS_PER_WINDOW) return false;
    hits.push(now);
    return true;
  }

  // `ipacct:` rows are not identities and nothing in the graph refers to them,
  // so unlike `user:` they can be swept — carefully, and never anything else.
  async sweepIpAccounts(now) {
    const doomed = [];
    for (const [key, stamps] of await this.state.storage.list({ prefix: "ipacct:" })) {
      if (!stamps?.length || now - stamps[stamps.length - 1] > IP_WINDOW_MS) doomed.push(key);
    }
    if (doomed.length) await this.state.storage.delete(doomed);
  }

  // Invisible is enforced here, not in the client. It used to be a rendering
  // rule — `online` and the real `presence` went out on the wire verbatim — so
  // any friend with devtools open saw the true dot. The custom status goes with
  // it: it's free text people put "at the dentist" and "in class" into, updated
  // live, which is exactly the feed the mode promises not to publish. So while
  // you're invisible the wire says offline, and says nothing else about you.
  publicUser(uid, acct) {
    const hidden = acct?.presence === "invisible";
    return {
      uid,
      tag: acct?.tag || "",
      name: acct?.name || "Wumpus",
      avatar: acct?.avatar || "🙂",
      color: acct?.color || "#5865f2",
      status: hidden ? "" : acct?.status || "",
      presence: hidden ? "offline" : acct?.presence || "online",
      online: this.isOnline(uid) && !hidden,
    };
  }

  // What you are allowed to know about yourself. Redacting your own presence
  // back at you would leave the settings menu unable to show which mode it is in.
  privateUser(uid, acct) {
    return {
      ...this.publicUser(uid, acct),
      status: acct?.status || "",
      presence: acct?.presence || "online",
      online: true,
    };
  }

  // Does the graph still name this uid, independently of its `user:` row? Only
  // consulted when a uid is claimed and the account row is missing, which today
  // means data loss or an attack — see the note at `hello`.
  async isRemembered(uid) {
    const storage = this.state.storage;
    if ((await storage.list({ prefix: `fr:${uid}:`, limit: 1 })).size) return true;
    return !!(await storage.list({ prefix: `ugdm:${uid}:`, limit: 1 })).size;
  }

  // Returns an error string when this IP has minted too many accounts in the
  // last hour, and "" when it hasn't. Without CF-Connecting-IP there is nothing
  // to key on, so it returns "" — a friend group behind one NAT would rather
  // have no limit than a locked front door.
  async mintBudget(s) {
    if (!s.ip) return "";
    const now = Date.now();
    const key = `ipacct:${s.ip}`;
    const recent = ((await this.state.storage.get(key)) || []).filter((t) => now - t < IP_WINDOW_MS);
    if (recent.length >= ACCOUNTS_PER_IP_HOUR) {
      return "That's a lot of new accounts from one place. Try again later.";
    }
    recent.push(now);
    await this.state.storage.put(key, recent);
    if (++this.newAccounts % IP_SWEEP_EVERY === 0) await this.sweepIpAccounts(now);
    return "";
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

        // The load-bearing invariant, written down where it can be broken:
        // NOTHING here ever deletes a `user:` row. No sweep, no LRU, no account
        // cap. That is the only reason the hub is immune to the identity
        // takeover ConcordServer had — the "wrong token" branch below cannot
        // fail when there is nothing to compare against, so the hub is safe
        // purely because the precondition is unreachable. Those rows therefore
        // grow forever, which makes capping them the obvious future maintenance
        // task, and doing it would hand an attacker the victim's tag, their
        // whole friend graph and every DM code they hold. The `isRemembered`
        // guard below is what has to hold instead if that day ever comes.
        const claimed = cleanText(m.uid, 40);
        const presented = cleanText(m.token, 64);
        let uid = claimed;
        let acct = uid ? await storage.get(`user:${uid}`) : null;
        if (acct && acct.token !== presented) {
          acct = null; // wrong token — you get a new account, not theirs
          uid = "";
        } else if (uid && !acct && (await this.isRemembered(uid))) {
          // No account row, but the graph still names this uid. That is a hole
          // in our own bookkeeping, never permission: an identity the server
          // remembers must not be claimable by someone who can't prove it.
          uid = "";
        }
        if (!acct) {
          const denial = await this.mintBudget(s);
          if (denial) {
            ws.send(JSON.stringify({ type: "hub-error", error: denial }));
            try {
              ws.close(4008, "too many accounts");
            } catch {}
            return;
          }
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
          // `set-tag` writes the new row before deleting the old one, so a crash
          // between the two leaves an account whose own tag resolves to nobody.
          // Heal only an *absent* row — one pointing elsewhere belongs to
          // whoever claimed it since.
          if (acct.tag && !(await storage.get(`tag:${acct.tag}`))) {
            await storage.put(`tag:${acct.tag}`, uid);
          }
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
            // Backfill for codes minted before the registry existed. The client
            // often opens a DM straight from this list without asking `dm-open`
            // first, so handing the code out is the last moment we are certain
            // to be holding it.
            if (row.dm) await this.registerCode(row.dm, dmRef(uid, other));
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
          await this.registerCode(group.code, { kind: "gdm", id: group.id });
          groups.push(await this.publicGroup(group));
        }

        const blocked = [];
        for (const key of (await storage.list({ prefix: `block:${uid}:` })).keys()) {
          blocked.push(key.slice(`block:${uid}:`.length));
        }

        ws.send(
          JSON.stringify({
            type: "hub-welcome",
            you: this.privateUser(uid, acct),
            token: acct.token,
            friends,
            incoming,
            outgoing,
            groups,
            dmUnread,
            blocked,
          })
        );
        // An invisible connect announces nothing. This used to fire
        // {online:true, presence:"invisible"} — the true state, on the wire, to
        // everyone, with only the client's rendering standing between it and
        // the person who chose not to be seen.
        if (cameOnline && acct.presence !== "invisible") {
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
        // Only give up a row we still own. These two writes cannot be made
        // atomic, so a crash between them already strands an orphan `tag:` row
        // that `friend-add` happily resolves and nobody can ever claim; deleting
        // unconditionally means a *retry* strands somebody else's row too.
        if (old && old !== tag && (await storage.get(`tag:${old}`)) === s.uid) {
          await storage.delete(`tag:${old}`);
        }
        ws.send(JSON.stringify({ type: "tag-changed", tag }));
        await this.notifyFriends(s.uid, { type: "friend-update", user: this.publicUser(s.uid, acct) });
        break;
      }

      case "presence": {
        if (!s.uid) return;
        const acct = await this.account(s.uid);
        if (!acct) return;
        const wasHidden = acct.presence === "invisible";
        if (m.name !== undefined) acct.name = cleanText(m.name, 32) || acct.name;
        if (m.avatar !== undefined) acct.avatar = cleanText(m.avatar, 8) || acct.avatar;
        if (m.color !== undefined) acct.color = cleanColor(m.color);
        if (m.status !== undefined) acct.status = cleanText(m.status, 60);
        if (m.presence !== undefined) acct.presence = cleanPresence(m.presence);
        acct.at = Date.now();
        await storage.put(`user:${s.uid}`, acct);
        await this.notifyFriends(s.uid, { type: "friend-update", user: this.publicUser(s.uid, acct) });
        // Going invisible has to look like going offline, because that is what
        // it claims to be. Switching used to send a `friend-update` still
        // carrying online:true, so the dot never moved. Coming back out has to
        // announce too, or you stay dark until you reconnect.
        const nowHidden = acct.presence === "invisible";
        if (wasHidden !== nowHidden) {
          await this.notifyFriends(s.uid, {
            type: "friend-presence",
            uid: s.uid,
            online: !nowHidden && this.isOnline(s.uid),
            presence: nowHidden ? "offline" : acct.presence,
          });
        }
        break;
      }

      case "friend-add": {
        if (!s.uid) return;
        const tag = cleanText(m.tag, 25).toLowerCase().replace(/^@/, "");
        if (!TAG_RE.test(tag)) {
          ws.send(JSON.stringify({ type: "hub-error", error: "That doesn't look like a tag. They look like @keith or @keith4821." }));
          return;
        }
        if (!(await this.probeBudget(s))) {
          ws.send(JSON.stringify({ type: "hub-error", error: "Slow down — try that again in a minute." }));
          return;
        }
        // The sender's own rows are read before anything is known about the
        // target, so the storage work either answer costs is roughly the same.
        // It is not constant time and doesn't pretend to be; it just stops the
        // *shape* of the reply from being a lookup.
        const rows = await this.friendRows(s.uid);
        const targetUid = await storage.get(`tag:${tag}`);
        if (targetUid === s.uid) {
          ws.send(JSON.stringify({ type: "hub-error", error: "You cannot add yourself. Touch grass." }));
          return;
        }
        // What a stranger gets back is the tag they typed and nothing else.
        // `friend-outgoing` used to echo publicUser — the target's whole
        // profile plus live presence — before the target had seen the request
        // and whether or not they ever accepted it. The `user` field survives
        // only so an older client's outgoing list still renders; it is a stub
        // built from what the sender already knew.
        const sent = () =>
          ws.send(
            JSON.stringify({
              type: "friend-outgoing",
              tag,
              user: outgoingStub(targetUid, tag),
            })
          );
        if (!targetUid) {
          sent(); // a tag that resolves and one that doesn't answer alike
          return;
        }
        const mine = await storage.get(frKey(s.uid, targetUid));
        // These three the sender already knows, so saying them plainly leaks
        // nothing they could not have worked out from their own friend list.
        if (mine?.state === "friend") {
          ws.send(JSON.stringify({ type: "hub-error", error: "You're already friends." }));
          return;
        }
        if (mine?.state === "out") {
          ws.send(JSON.stringify({ type: "hub-error", error: "Already asked. Give them a minute." }));
          return;
        }
        if (mine?.state === "in") {
          await this.becomeFriends(s.uid, targetUid); // they asked first; adding back accepts
          return;
        }
        // A block and a full inbox both answer like a delivered request. Naming
        // either one confirms the tag resolved, and "you are blocked" is
        // precisely the notification the person who blocked them declined to
        // send.
        if (await this.isBlocked(targetUid, s.uid)) {
          sent();
          return;
        }
        if (rows.filter(([, row]) => row.state === "friend").length >= FRIEND_CAP) {
          ws.send(JSON.stringify({ type: "hub-error", error: "That's a lot of friends. Prune some first." }));
          return;
        }
        const theirs = await this.friendRows(targetUid);
        if (theirs.filter(([, row]) => row.state === "in").length >= INCOMING_CAP) {
          sent();
          return;
        }
        const now = Date.now();
        await storage.put({
          [frKey(s.uid, targetUid)]: { state: "out", at: now },
          [frKey(targetUid, s.uid)]: { state: "in", at: now },
        });
        const myAcct = await this.account(s.uid);
        sent();
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
        // Declining left no record at all, so the requester could ask again
        // immediately and forever — there was no "no" anywhere in the product.
        // A decline is now a block, which `friend-unblock` undoes; a *removal*
        // is not, because ending a friendship is not the same as refusing one.
        if (m.type === "friend-decline" && row.state === "in") {
          await storage.put(blockKey(s.uid, other), { uid: other, at: Date.now() });
        }
        await this.severFriendship(s.uid, other, row);
        ws.send(JSON.stringify({ type: "friend-removed", uid: other }));
        this.sendToUser(other, { type: "friend-removed", uid: s.uid });
        break;
      }

      case "friend-block": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        if (!other || other === s.uid) return;
        await storage.put(blockKey(s.uid, other), { uid: other, at: Date.now() });
        const row = await storage.get(frKey(s.uid, other));
        if (row) {
          await this.severFriendship(s.uid, other, row);
          ws.send(JSON.stringify({ type: "friend-removed", uid: other }));
          this.sendToUser(other, { type: "friend-removed", uid: s.uid });
        }
        ws.send(JSON.stringify({ type: "blocks", list: await this.blockList(s.uid) }));
        break;
      }

      case "friend-unblock": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        if (other) await storage.delete(blockKey(s.uid, other));
        ws.send(JSON.stringify({ type: "blocks", list: await this.blockList(s.uid) }));
        break;
      }

      case "blocks": {
        if (!s.uid) return;
        ws.send(JSON.stringify({ type: "blocks", list: await this.blockList(s.uid) }));
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
          const mirror = await storage.get(frKey(other, s.uid));
          // This used to manufacture the missing half — `|| {state:"friend"}` —
          // which is exactly the mistake ConcordServer.hello was just patched
          // out of. Half a friendship means somebody's removal only half
          // landed, and healing it re-grants the access that removal took away.
          if (mirror?.state !== "friend") {
            throw new Error("That friendship is only half here. Remove them and add them again.");
          }
          code = newServerCode() + newServerCode().slice(0, 4);
          row.dm = code;
          mirror.dm = code;
          await storage.put({ [frKey(s.uid, other)]: row, [frKey(other, s.uid)]: mirror });
        }
        await this.registerCode(code, dmRef(s.uid, other));
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
            if (await this.isBlocked(uid, s.uid)) continue;
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
        if (await this.isBlocked(other, s.uid)) return;
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
        // Nobody gets dragged into a room with someone they blocked, in either
        // direction. `gdm-add` would be theatre without the same check here.
        if (await this.blockClash([s.uid, ...invited])) {
          ws.send(JSON.stringify({ type: "hub-error", error: "Someone in that list has blocked someone else in it." }));
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
        await this.registerCode(group.code, { kind: "gdm", id: group.id });
        const pub = await this.publicGroup(group);
        await this.tellGroup(group, { type: "gdm-added", group: pub });
        break;
      }

      case "gdm-open": {
        if (!s.uid) return;
        const group = await this.loadGroup(cleanText(m.id, 40));
        if (!group || !group.members.includes(s.uid)) return;
        await this.registerCode(group.code, { kind: "gdm", id: group.id });
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
        if (await this.blockClash([...group.members, uid])) {
          ws.send(JSON.stringify({ type: "hub-error", error: "They've blocked someone in this group, or the other way round." }));
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
          // The `dmcode:` row deliberately stays. It now points at a group that
          // no longer exists, which is what makes `dmMember` refuse everybody —
          // deleting it would make the code unknown to the hub again, and an
          // unknown code is one the realm grandfathers.
          const leftovers = group.members.map((u) => userGroupKey(u, group.id));
          await storage.delete([groupKey(group.id), ...leftovers]);
          for (const uid of [s.uid, ...group.members]) await this.evict(group.code, uid);
          await this.tellGroup(group, { type: "gdm-removed", id: group.id });
          break;
        }
        await storage.put(groupKey(group.id), group);
        // The remaining members' clients get a list without you and reasonably
        // believe the room is now private. Until this, that belief was wrong:
        // the code you were told still opened the room, and the audit read a
        // message posted after it left.
        await this.evict(group.code, s.uid);
        await this.tellGroup(group, { type: "gdm-added", group: await this.publicGroup(group) });
        break;
      }

      // Purely for fun: a friend-to-friend nudge that rattles their window.
      case "poke": {
        if (!s.uid) return;
        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") return;
        // A blocked poke reports the same "they're offline" it would if they
        // simply weren't there — a block that announces itself isn't one.
        if (await this.isBlocked(other, s.uid)) {
          ws.send(JSON.stringify({ type: "poke-sent", landed: false }));
          return;
        }
        const acct = await this.account(s.uid);
        const landed = this.sendToUser(other, { type: "poked", uid: s.uid, name: acct?.name || "Someone" });
        ws.send(JSON.stringify({ type: "poke-sent", landed }));
        break;
      }

      // Ringing someone who doesn't have that conversation open. A ring is
      // otherwise derived from the DM's own socket, and a DM you haven't opened
      // this session has no socket — which is every DM you own, immediately
      // after a reload. So nobody could call you until you happened to open the
      // conversation first, which is backwards.
      //
      // This relays and forgets. No unread key, no counter, nothing durable —
      // the same shape as `poke`, and for the same reason: it is a live
      // notification, and a phone that was switched off does not ring later for
      // a call that ended an hour ago. What it actually announces is "there is a
      // call in this conversation, go and look"; the realm's own voice
      // membership stays the only thing that decides whether you are being rung.
      // That is what makes it unstickable, and it is why a caller whose socket
      // simply dies needs nothing here: by then the recipient is connected to
      // the realm, which drops them from voice on its own.
      //
      // `call-end` is therefore a courtesy — it stops the recipient holding a
      // socket open for a call that has already ended — rather than the thing
      // correctness rests on.
      case "call-ring":
      case "call-end": {
        if (!s.uid) return;
        const ringing = m.type === "call-ring";
        if (ringing && !this.ringBudget(s.uid)) return;
        const chanId = cleanText(m.chanId, 20);
        const acct = ringing ? await this.account(s.uid) : null;

        // Group flavour: everyone else in it, one at a time rather than through
        // `tellGroup`, because each member's block has to be checked.
        if (m.gdm) {
          const group = await this.loadGroup(cleanText(m.gdm, 40));
          if (!group || !group.members.includes(s.uid)) return;
          for (const uid of group.members) {
            if (uid === s.uid) continue;
            if (await this.isBlocked(uid, s.uid)) continue;
            this.sendToUser(
              uid,
              ringing
                ? { type: "call-ring", gdm: group.id, uid: s.uid, name: acct?.name || "Someone", chanId }
                : { type: "call-end", gdm: group.id }
            );
          }
          break;
        }

        const other = cleanText(m.uid, 40);
        const row = await storage.get(frKey(s.uid, other));
        if (row?.state !== "friend") return;
        // Silent, like a blocked poke: a ring that goes nowhere and a ring
        // nobody was there to hear have to look identical from the caller's end.
        if (await this.isBlocked(other, s.uid)) return;
        this.sendToUser(
          other,
          ringing
            ? { type: "call-ring", uid: s.uid, name: acct?.name || "Someone", chanId }
            : { type: "call-end", uid: s.uid }
        );
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
    // Accepting is where a code first becomes a conversation, so it is where the
    // realm's membership question first has an answer.
    await this.registerCode(code, dmRef(a, b));
    // Becoming friends with someone you blocked is consent to hear from them.
    await storage.delete([blockKey(a, b), blockKey(b, a)]);
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

// The placeholder that stands where the target's profile used to go. A miss
// gets a throwaway uid so the frame a stranger sees is the same size and shape
// either way; nothing is written against it, and it never reaches the target.
function outgoingStub(uid, tag) {
  return {
    uid: uid || crypto.randomUUID(),
    tag,
    name: tag,
    avatar: "🙂",
    color: "#5865f2",
    status: "",
    presence: "offline",
    online: false,
  };
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
  const stripped = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return clip(stripped, max).trim();
}

// Truncates by code point, not by UTF-16 code unit, so a cut never lands in the
// middle of an emoji and leaves a lone surrogate behind — which, for the stored
// reply quote, meant a permanent replacement character in durable storage. It
// does mean every `max` in this file now counts characters rather than code
// units: a slightly more generous cap, and the more correct one. The limits
// didn't drift, the unit did.
function clip(v, max) {
  if (typeof v !== "string") return "";
  return v.length > max ? [...v].slice(0, max).join("") : v;
}

// One archive object is one message per line. A line that won't parse gets
// dropped: most of an archive beats none of it.
function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
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
