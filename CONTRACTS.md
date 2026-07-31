# Concord wire contract — v2

The one place the client and the Worker agree on what words mean. Everything
below is additive: **no existing message type changes shape**, so an old client
talking to a new Worker keeps working (it just never sees the new fields).

Transport is unchanged — one WebSocket per realm at `/ws?server=CODE`, plus the
hub singleton at `/ws?hub=1`. Uploads are the only thing that isn't WebSocket,
because you cannot stream 25 MB through a JSON message and shouldn't try.

---

## 1. Attachments (files, images, video)

### Why it's a three-step handshake

The Durable Object is the only thing that knows who you are — identity is
established by the `hello` on your socket. A plain `POST /api/upload` has no
socket and therefore no identity, so anyone who guessed a server code could
fill the bucket. So: **ask the DO for a ticket over the socket you're already
authenticated on, spend the ticket over HTTP, then reference the result in a
normal `msg`.**

```
        WS                        HTTP                      WS
client ─────▶ upload-ticket        │                         │
       ◀───── upload-tickets       │                         │
                                   │                         │
client ────────────────────────────▶ PUT /api/upload/<id>    │
       ◀──────────────────────────── {att:{key,…}}           │
                                                             │
client ──────────────────────────────────────────────────────▶ msg {attachments:[…]}
```

### 1.1 `upload-ticket` (client → server, WS)

```jsonc
{
  "type": "upload-ticket",
  "nonce": "u3f9k2",                                                       // correlates the reply
  "files": [ { "name": "cat.png", "size": 81234, "mime": "image/png" } ]   // 1..10
}
```

Server replies with one of:

```jsonc
{ "type": "upload-tickets", "nonce": "u3f9k2", "tickets": [ { "id": "…", "key": "a/CODE/uuid/cat.png", "max": 81234 } ] }
{ "type": "error", "error": "Files cap out at 25 MB.", "for": "upload-ticket", "nonce": "u3f9k2" }
```

Two fields here exist purely to stop one upload's reply landing on another's
request. **`nonce`** is echoed on both the success and the error: tickets are
minted for a specific list of files in a specific order, so a misrouted reply
hands a PNG the ticket cut for a video. The client ignores a *mismatched* nonce
but accepts a reply with none, so an older Worker still works.

**`for`** exists because the client otherwise cannot tell "your files were
refused" from "you hit the pin cap" — and the catch-all in `dispatch` turns any
thrown exception into a bare `error` frame. Without the tag, an unrelated error
mid-upload aborted the whole batch and stranded its tickets for their full TTL,
during which every retry was refused as over the pending-ticket cap.

`max` is the **declared size of that specific file**, clamped to the global
ceiling — not the ceiling itself. A ticket that reports the ceiling makes the
declared size decorative, and the size check at PUT time meaningless.

Server-side checks, all of which reject the whole batch:

| rule | value |
|---|---|
| files per request | 1–10 |
| bytes per file | ≤ 25 MB (`25 * 1024 * 1024`) |
| uploads per user | 30 per 10 minutes |
| total pending tickets per user | 10 |
| mime | must pass `safeMime()` below |

A ticket is stored as `tkt:<id>` = `{key, mime, max, userId, exp}` with
`exp = now + 5 min`, and is single-use.

### 1.2 `PUT /api/upload/<ticketId>?code=<CODE>`

Body is the raw bytes. `Content-Type` is ignored — the mime recorded on the
ticket wins, so a client cannot declare `image/png` and then upload HTML.

The Worker:
1. `env.SERVERS.get(idFromName(CODE)).fetch("https://do/internal/claim?ticket=<id>")`
   → `{ok:true, key, mime, max, userId}` (the DO deletes the ticket and writes
   `att:<key>` = `{userId, mime, exp: now + 30 min}` in the same step, so a
   ticket can never be spent twice).
2. Streams the body into R2 at `key` with `httpMetadata.contentType = mime`.
3. Rejects with 413 if `Content-Length` exceeds `max`.
4. Returns `{ok:true, att:{key, name, size, mime}}`.

### 1.3 `GET /f/<key>`

Streams the object back. **The response headers are not negotiable**, because
this origin also serves the app:

```
Content-Type:            the stored mime, after safeMime() a second time
Content-Disposition:     inline    for image/* video/* audio/* and application/pdf
                         attachment; filename="…"   for everything else
Cache-Control:           public, max-age=31536000, immutable
X-Content-Type-Options:  nosniff
```

`safeMime(mime)` — the allowlist. Anything not matching becomes
`application/octet-stream`, which the rule above then forces to `attachment`:

```
image/png  image/jpeg  image/gif  image/webp  image/avif  image/bmp
video/mp4  video/webm  video/quicktime
audio/mpeg audio/ogg   audio/wav   audio/webm  audio/mp4
application/pdf  text/plain  application/zip  application/json
```

**`image/svg+xml` is deliberately absent.** An SVG is a script-execution
vector on our own origin; it uploads fine, it just downloads instead of
rendering. Same reasoning for `text/html`.

### 1.4 Referencing them in a message

`msg` gains an optional `attachments` array (max 10):

```jsonc
{
  "type": "msg", "chanId": "c1", "content": "look at this", "nonce": "n…",
  "attachments": [
    { "key": "a/CODE/uuid/cat.png", "name": "cat.png", "size": 81234,
      "mime": "image/png", "w": 1200, "h": 800, "spoiler": false }
  ]
}
```

`w`/`h` (images/video) and `dur` (audio/video, seconds) are client-measured
hints for layout — they are cosmetic, so they're clamped, not trusted.

For each attachment the DO requires `att:<key>` to exist **with a matching
`userId`**, then deletes it (consumed). Anything that fails is dropped
silently from the array. The stored message carries the descriptor plus
`url: "/f/" + key`.

A message with no text but at least one attachment is legal — that's the whole
point of sending a picture.

### 1.5 Cleaning up

* `delete` → delete every attachment key from R2.
* The 300-message ring buffer → read the message about to be evicted and delete
  its keys first.
* `delete-channel` → walk the channel and delete keys as it goes.
* `att:` records older than 30 minutes that were never consumed get swept on
  the same schedule as `auth:`.

Orphans are still possible if a DO dies mid-write. That's acceptable: R2 free
tier is 10 GB and this is a friend group, not a CDN.

---

## 2. Persistent membership (the roster)

Today `members()` is derived from live sockets, so leaving the page erases you.
The roster is the durable half of that.

`roster:<userId>` = `{userId, name, color, avatar, tag, status, at, joinedAt}`
where `at` is last-seen. Written on `hello` and on `set-profile`.

* Cap: **200** entries, swept LRU by `at` (never sweeping anyone online).
* `welcome` gains `roster: [...]` and `owner: <userId>`.
* `{type:"roster", entry}` broadcast when someone joins or edits their profile.
* `{type:"roster-remove", userId}` when someone leaves or is kicked.

The client keeps `realm.roster` (Map userId → entry) *alongside* the existing
`realm.members` (Map sid → live session). **`members` stays keyed by sid** —
voice, WebRTC and typing all address people by sid and must not change. A
person is "online" iff some live member shares their userId; dedupe by userId
when rendering, because two tabs are one person.

### New ops

| op | who | effect |
|---|---|---|
| `{type:"leave-server"}` | anyone | deletes own roster row, broadcasts `roster-remove` |
| `{type:"kick", userId}` | owner | roster row deleted, sockets closed, `roster-remove` |
| `{type:"ban", userId}` / `{type:"unban", userId}` | owner | as kick, plus `ban:<userId>`; a banned `hello` is refused with `{type:"banned"}` |
| `{type:"bans"}` | owner | `{type:"bans", list:[…]}` |

`meta.owner` is set to the first userId that ever says `hello` when it's
absent. If the owner's roster row is removed, ownership passes to the oldest
remaining `joinedAt`. Owner-only ops are checked server-side; the client
hiding a button is a courtesy, not a control.

---

## 3. Threads

A thread is a channel with a parent. That's the whole trick — it means
`msg`, `history`, `react`, `pin`, `edit` and `delete` all work on threads with
no new code paths.

```jsonc
{ "type": "create-thread", "chanId": "c1", "msgId": 42, "name": "about that" }
```

→ broadcasts `channel-create` with

```jsonc
{ "id": "t7", "type": "thread", "name": "about that",
  "parent": "c1", "rootId": 42, "at": 1730000000000 }
```

and `msg-thread` so the source message can show its chip:

```jsonc
{ "type": "msg-thread", "chanId": "c1", "msgId": 42, "threadId": "t7", "name": "about that" }
```

Rules:
* `type: "thread"` counts as a text channel everywhere a message is validated.
* Threads live in `channels` like anything else — no separate list to sync.
* Deleting the parent channel deletes its threads and their messages.
* One thread per message. A second `create-thread` on the same message returns
  the existing one.
* Channel cap rises to 100 to leave room.

## 4. Categories

Purely a channel field — `chan.cat`, a string, ≤ 24 chars, set through the
existing `update-channel` or `create-channel`. No new storage, no new ops.
Grouping and collapse state are the client's business (collapse is local only,
because whether *you* folded a category away is nobody else's concern).

## 5. Slowmode

`chan.slow` = seconds, `0`–`300`, via `update-channel`. Enforced in the DO with
an in-memory `Map` keyed `userId:chanId`. Over-eager senders get:

```jsonc
{ "type": "slowmode", "chanId": "c1", "seconds": 4 }
```

The owner is exempt (Discord exempts moderators; here there's only one).

## 6. Custom emoji

`emoji:<name>` = `{name, key, by, at}`, cap 50 per server, name `[a-z0-9_]{2,20}`.

| op | payload |
|---|---|
| `emoji-add` | `{name, key}` — `key` from a spent upload ticket, must be `image/*` and ≤ 256 KB |
| `emoji-remove` | `{name}` (owner, or whoever added it) |

`welcome` gains `emoji: [{name, url}]`, and `{type:"emoji", list:[…]}` is
broadcast on change. `react` accepts `:name:` as an emoji value provided the
name resolves. In text, `:name:` renders as an inline image — the client does
that at render time, so stored content stays plain text and stays searchable.

## 7. Voice channels have text too

`msg` (and `history`, `react`, …) now accept a channel of type `voice`. No new
ops at all; the client just shows the chat pane when you click a voice channel.

## 8. Custom soundboard clips

`sound:<id>` = `{id, name, key, by, at}`, cap 20/server, ≤ 512 KB, `audio/*`.

| op | payload |
|---|---|
| `sound-add` | `{name, key}` |
| `sound-remove` | `{id}` |

`welcome` gains `sounds: [{id, name, url}]`. The existing `sound` relay accepts
a custom id alongside the twelve built-ins; receivers fetch and play the URL
instead of synthesising.

---

## 9. Client-only settings added this round

All live in `state.settings` and persist to `localStorage`. None are ever
transmitted.

```js
noiseGate: 0,          // 0 = off, else an RMS threshold 1..100
echoCancel: true,
noiseSuppress: true,
agc: true,
outputId: "",          // setSinkId target, "" = system default
shareQuality: "720p30", // "720p30" | "1080p30" | "1080p60"
shareAudio: false,      // include system audio in a screen share
stereo: false,          // stereo + 128kbps opus instead of 64k mono
saved: [],              // bookmarked messages [{code, chanId, msgId, preview, ts}]
notes: {},              // userId -> private note
collapsed: {},          // "CODE/category" -> true
```

---

## 10. Limits, in one place

```js
MAX_FILE_BYTES   = 25 * 1024 * 1024
MAX_FILES_PER_MSG = 10
UPLOADS_PER_10MIN = 30
TICKET_TTL_MS    = 5 * 60 * 1000
ATT_TTL_MS       = 30 * 60 * 1000
ROSTER_CAP       = 200
CHANNEL_CAP      = 100
EMOJI_CAP        = 50
EMOJI_MAX_BYTES  = 256 * 1024
SOUND_CAP        = 20
SOUND_MAX_BYTES  = 512 * 1024
SLOWMODE_MAX_S   = 300
```

---

## 11. The hub — accounts, friends, DMs, groups

Everything above is one server talking to one `ConcordServer`. The hub is the
other half: a **singleton** Durable Object at `/ws?hub=1` that owns the things
which can't belong to any single server. It never sees message content.

### 11.1 `hello`

```jsonc
{ "type": "hello", "uid": "…", "token": "…", "name": "Keith", "avatar": "🙂",
  "color": "#5865f2", "status": "", "presence": "online" }
```

→ `hub-welcome` carrying `you`, `token`, `friends` (each with its `dm` code),
`incoming`, `outgoing`, `groups` (each with its `code`), and `dmUnread`.

Identity is claimed once per socket. Present the wrong token for a known `uid`
and you are silently issued a **new** account rather than an error — same rule
as `ConcordServer`, for the same reason.

### 11.2 Ops

| op | payload | effect |
|---|---|---|
| `set-tag` | `{tag}` | claims `@tag`; refused if it points at someone else |
| `presence` | `{name, avatar, color, status, presence}` | updates the account, notifies friends |
| `friend-add` | `{tag}` | request, or auto-accept if they already asked you |
| `friend-accept` / `friend-decline` / `friend-remove` | `{uid}` | |
| `dm-open` | `{uid}` | → `dm-ready {uid, code, user}` |
| `dm-nudge` | `{uid \| gdm, preview}` | the thing that lights up a sidebar you aren't connected to |
| `dm-read` | `{uid}` | clears your own badge |
| `gdm-create` | `{uids[], name, icon}` | friends only, ≤ 10 members, ≤ 20 groups each |
| `gdm-open` / `gdm-add` / `gdm-rename` / `gdm-leave` | `{id, …}` | members only |
| `poke` | `{uid}` | rattles a friend's window |

Caps: `FRIEND_CAP` 250, `GDM_MAX_MEMBERS` 10, `GDM_CAP` 20, tags
`/^[a-z0-9_.]{2,20}$/`.

### 11.3 Why a DM has no storage of its own

When two people become friends the hub mints a random 12-character code and
tells only those two. **The conversation is an ordinary `ConcordServer` at that
code.** Groups work identically. That's what makes DM voice calls, history,
pins and reactions free — a DM call is literally joining a voice channel.

---

## 12. The security model, stated plainly

Read this before adding anything that removes a person from something.

### A code is a bearer capability

Possession of a server code **is** the authority to read and write that
conversation. There is no per-user access list on a `ConcordServer` — `hello`
establishes *who you are*, never *whether you're allowed in*. Consequences that
are easy to miss:

* Handing someone a code is irreversible by any mechanism the app currently has.
* The hub's membership list is **bookkeeping, not enforcement**. It decides who
  gets *told* a code. It cannot take one back.
* Therefore any UI that says "left the group" or "removed friend" is describing
  the hub's records, not the other person's access. If you add a `gdm-kick`, it
  will not kick anyone until the enforcement gap below is closed.

Closing that gap means membership has to be checked where the messages are: a
`ConcordServer` that knows it is a DM should verify with the hub, on `hello`,
that the connecting account is currently a member — checked live, so revocation
is immediate and there is no expiry window to reason about.

### Entropy

`newServerCode()` maps 8 random bytes through a 31-character alphabet, so there
is a small modulo bias: 8 symbols land with p=9/256 and 23 with p=8/256, giving
**4.83 bits of min-entropy per character** rather than log₂(31)=4.95.

* A **DM/group code is 12 characters ≈ 58 bits.** At 1000 guesses/second a
  specific code takes millions of years. Fine.
* A **guild invite code is 8 characters ≈ 38.6 bits.** Against a population of
  live servers that is *not* comfortable — expected probes to hit *some* server
  falls linearly with how many exist, and `/ws?server=CODE` without `create=1`
  answers 404 vs 101, which is a clean existence oracle.

The DM maths only works because of the extra four characters. Don't shorten it,
and think hard before treating the 8-character guild code as a secret.

### The load-bearing invariant nobody would guess

**Nothing anywhere deletes a `user:` row, and the hub has no sweep, no LRU and
no account cap. That is what keeps the hub safe.**

`ConcordServer` had an identity-takeover bug precisely because it *did* evict
dormant `auth:` rows: once a row was gone, `hello` with that userId and no token
succeeded, because the "wrong token" guard cannot fail when there is nothing to
compare against. The hub is immune only because the precondition is unreachable.

So if you ever add the obvious LRU cap to `user:` — and it is obvious, because
those rows grow forever — **you hand an attacker the victim's tag, their entire
friend graph, and every DM code they hold.** If you need that cap, add the
belt-and-braces check first: refuse a uid that has no `user:` row but still
appears anywhere in the graph. An identity the server still remembers must never
be claimable by someone who can't prove it.
