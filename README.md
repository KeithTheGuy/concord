# Concord 🎧

**It's like Discord, but agreeable.** A knockoff-Discord voice & text chat app for you and
your friends, small enough to fit in one Cloudflare Worker.

**Live at → https://concord.jeffnugget.workers.dev**

## Get the Windows app 🖥️

Grab it from [**Releases**](https://github.com/KeithTheGuy/concord/releases/latest):

- **Concord-Setup-x.x.x.exe** — installer (Start menu shortcut, one-click)
- **Concord-x.x.x-portable.exe** — no install, just run it

It's the same trick real Discord uses: a desktop shell around the live app, so it
updates itself every time you launch it. Native Windows toast notifications and
one-click screen share included.

> Windows SmartScreen will warn because the exe isn't code-signed (certificates
> cost money; this is a friends project). Click **More info → Run anyway**.
> If you'd rather not, the website is the exact same app — you lose nothing.

## How friends join (the whole onboarding)

1. You: click **Invite** in the app, copy the link (looks like `https://concord.jeffnugget.workers.dev/?join=XK4PQ2M9`).
2. Them: open the link, pick a name + avatar, done. They're in your server.
3. Everyone: click a voice channel to start talking.

No accounts, no emails, no phone verification, no Nitro upsell. The invite code *is* the key
to the server, so only share it with people you want in.

## Features

- **Friends** — every account gets a tag like `@keith`. Add people by tag, accept or
  ignore requests, see who's online (online / idle / DND / invisible), poke them
- **Direct messages** — full 1:1 chat with history, reactions, edits, replies, pins,
  and **DM voice calls** (the 📞 button). Unread counts survive being offline.
  Click anyone in a server's member list to see their profile and DM them
- **Calling someone actually rings them** — a toast with Join / Ignore that doesn't
  time out, the join sound, a desktop notification, a green pill on their row in
  your sidebar, and 📞 in the tab title. Do Not Disturb keeps the toast but drops
  the noise; a muted server stays silent entirely. Server voice channels
  deliberately don't ring — people wander in and out of those all day, and the
  sidebar already shows who's sitting in each one
- **Blocking**, and declining a friend request now means it. Invisible is
  enforced by the server rather than politely observed by the client
- **Group chats** — 👥 in the DM sidebar. Up to 10 people, rename it, add friends,
  leave whenever. Unnamed groups name themselves after whoever's in them. Group
  voice calls work identically, because a group is the same machinery as a 1:1
- **A call is independent of what you're looking at.** Every server keeps its own live
  connection, so you can browse other servers, read DMs and chat anywhere while a voice
  call carries on untouched. The rail shows a green ring on whichever server holds it,
  unread badges on the rest, and the voice panel clicks through to jump back
- **Servers** with invite codes; join as many as you want (left rail)
- **Drafts** — half a sentence survives switching channels, and the channel gets a
  pencil so you remember it's there. The reply you were writing to comes back too
- **Nothing is lost when your connection isn't** — a message sent while the socket
  is down waits and goes when you're back. One written to a socket that then died
  gets a Retry button rather than a guess, because there's no way to tell whether
  the server saw it and a silent retry would post it twice
- **Back up your identity** — Settings → Export writes a file (or a string you can
  paste into a note). It's the only thing standing between a cleared browser and
  losing every DM you have, so it's also on the welcome screen
- **History goes past 300 messages.** Older ones move to cold storage and page back
  in when you scroll, instead of being deleted
- **Files, images and video** — drag them in, paste a screenshot, or hit 📎. Images
  render inline in a grid that reserves its space so the chat never reflows under
  you as they load; video and audio get real players; anything else becomes a
  download card. Mark one as a spoiler and it stays blurred until clicked. 25 MB
  a file, ten files a message
- **People stick around** — the member list keeps everyone who has ever joined,
  split into Online and Offline with a last-seen line, instead of forgetting you
  the moment you close the tab. The first person in a server owns it and can kick
  or ban; everything else is a flat clubhouse
- **Threads** — 💬 on any message starts one. A thread is a channel underneath the
  hood, which is why history, reactions, pins and unread badges all just work in it
- **Channel categories** with collapsible headers, and **slowmode** per channel
  (the owner is exempt, as it should be)
- **Custom server emoji** — upload a picture, name it, `:name:` works in messages
  and as a reaction, and a message that's nothing but emoji renders them big
- **Text channels** — history, edit/delete, replies, emoji reactions, typing indicators,
  markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, ``` ```blocks``` ```,
  `||spoilers||`), links, unread badges + notification pings, emoji picker
- **@mentions** — autocomplete as you type, highlighted in chat, and they ping you even
  in the channel you're already looking at. `@everyone` and `@here` too
- **Pinned messages** (📌 on any message), **message search** (Ctrl+F, one channel or the
  whole server), and a **quick switcher** (Ctrl+K) for jumping to any channel, server or friend
- **Slash commands** — `/shrug` `/tableflip` `/me` `/spoiler` `/mock` `/clap` `/roll` `/flip`
  `/8ball` `/big` `/nick` `/status` `/sound` `/shout` `/help`
- **Soundboard** — 🎵 next to the message box. Twelve clips, all synthesized in the browser
  (no audio files to download), played to everyone in your voice channel
- **Unread handling** — a red "new messages" line where you left off, jump-to-present,
  per-server mute (🔕, still counts unread, just quiet), Mark As Read, and Shift+Esc
- **Inline previews** for image links and YouTube, **auto-idle** after 6 minutes (never
  overrides an explicit DND/Invisible), optional **read-aloud** for incoming messages,
  and per-person volume that's remembered forever, keyed to the person not the session
- **Themes** — Midnight, Synthwave, Vaporwave, Nord, Matrix, Gold, Blossom. Every colour
  in the app comes from a custom property, so a theme is just a different set of them
- **⚡ TURBO MODE** — opt-in aurora background, glass panels, glowing speaking rings,
  messages that slide in, and a burst of light every time you hit send. Purely
  decorative, and the whole thing stands down under `prefers-reduced-motion`
- **Polls** — `/poll Pizza tonight? | Yes | Absolutely` renders a real poll with live
  bars. Voting is the reaction system underneath, so there's no new storage and one
  vote each; switching your answer moves it rather than adding another
- **Levels & achievements** — 23 of them, from First Word to Hydro Homicide. Entirely
  local: your XP is never transmitted, so nobody can farm it, rank it, or judge you by it
- **Voice channels** — real-time group voice (WebRTC mesh), speaking indicators,
  mute / deafen, push-to-talk with a bindable key, per-user volume (right-click someone
  in voice), input-device picker, join/leave sounds
- **Audio settings that earn their name** — an adjustable noise gate with a live
  meter that draws the threshold on the same axis, so you can watch your own
  voice cross the line instead of guessing at a number. Echo cancellation, noise
  suppression and auto-gain toggles, an output device picker with a test tone,
  screen-share quality (720p30 / 1080p30 / 1080p60), **share system audio**, a
  stereo + 128kbps mode, and a live call-quality readout with real ping, packet
  loss and bitrate
- **Voice changer** — a full FX rack on your mic before it reaches the call, not
  just a pitch knob. **FredsVoice (ASMR)** is the headline: pitched down slightly,
  presence-lifted around 8kHz, heavily compressed so breaths come up to meet the
  loud bits, with a 17ms stereo ping-pong that puts it beside your head rather
  than in a hallway. Also CB Radio, Telephone, Robot, Megaphone, Underwater,
  Alien, Cavern, Ghost, Demon, Feminine, Anime, Chipmunk, Deeper — plus a pitch
  slider that nudges any preset without losing its character. Hit 🎭 to swap
  mid-sentence; nothing renegotiates, so nobody hears a gap
- **Video** — 📹 turns your camera on, 🖥 shares your screen. Click any tile to
  make it fill the stage
- **Screen share** — one click, shows as a tile above chat for everyone in voice
- **Profiles** — name, emoji avatar, color, custom status; channel create/rename/delete;
  server rename; it remembers everything in your browser
- **🃏 Gremlin Mode** — hit the 🃏 button, pick a victim (or EVERYONE), pick a crime:
  Earthquake, Upside Down, Vaporwave, Emoji Rain, Fake Kick, Air Horn, Drunk Mode,
  Butter Fingers, Cursed Cursor, Blue Screen, Tiny Mode, Spin Cycle. Every prank is
  cosmetic, wears off on its own, and tells the victim exactly who did it. 15 second
  cooldown per gremlin; anyone can opt out in Settings (cowards welcome)

## Architecture

```
public/    static client (vanilla JS, no build step) — also an installable PWA
worker/    Cloudflare Worker + ConcordServer and ConcordHub Durable Objects
electron/  Windows desktop shell (loads the live site, like real Discord)
CONTRACTS.md        the wire protocol — read this before touching either half
public/voicefx.js   the voice FX rack — presets are plain descriptions of a
                    signal chain, and buildFxGraph turns them into WebAudio
public/voicelab.js  noise gate, level meter, device routing, call statistics
public/voiceui.js   the audio half of Settings; builds its own markup
public/uploads.js   the upload handshake and attachment rendering
public/customemoji.js  the :name: registry and its render pass
public/flair.js     themes, turbo effects, XP curve, achievements
test/      run-all.mjs (every suite, one verdict) · smoke.mjs (protocol)
           uploads.mjs · roster.mjs · threads.mjs (the 2026-07-30 round)
           e2e.mjs (two-browser incl. live WebRTC audio)
           social.mjs (friends + DMs) · groups.mjs (group chats across three
           browsers) · multirealm.mjs (a call surviving you wandering off)
           flair.mjs (offline-renders every voice preset to prove it changes
           the signal) · voicefx.mjs (measures actual pitch) · desktop.mjs
           (Electron) · shot.mjs · icons.mjs
```

A **group chat** is the same shape as a 1:1: the hub owns the membership list and
mints one secret code, and the conversation is an ordinary ConcordServer that only
members are ever told the code for. Membership is enforced hub-side — you can only
add people you're actually friends with, and a bogus id is refused regardless of
what the UI sends.

One **ConcordServer** Durable Object per server holds channels, the last 300 messages
per channel, pins, live presence and voice state, and relays WebRTC signaling. Voice
audio itself is peer-to-peer (mesh) — the server never hears you.

One **ConcordHub** Durable Object for the whole app holds the things that can't belong
to any single server: accounts, friend tags, the friend graph, and DM unread counts.

A **DM is just a ConcordServer** at a random 12-character code that the hub mints when
two people become friends and tells only those two. That's what makes DM voice calls
work with no extra machinery — a DM call is literally joining a voice channel. The hub
never sees message content.

## Dev

```bash
npm install
npm run dev       # wrangler dev on http://localhost:4189
npm test          # every suite, one verdict (starts a server if none is up)
npm test protocol # just the fast ones — seconds, not minutes
npm run e2e       # two-browser Playwright test (chat + voice + notifications)
npm run app       # run the desktop app from source
npm run dist      # build Windows installer + portable exe into dist/
npm run deploy    # ship the web app
```

Uploads need an R2 bucket. It's simulated locally, so `npm run dev` works with no
setup, but the first real deploy needs it to exist:

```bash
npx wrangler r2 bucket create concord-files
```

Note: this machine pins `wrangler` 3.x (Node 20). If you upgrade Node to 22+, wrangler 4 works too.

## Known limitations (a.k.a. the free tier speaks)

- **Your identity lives only in this browser.** Your `@tag`, your friend graph, the
  secret code behind every DM, and who you are on each server are all in
  `localStorage` and nowhere else. There is no email, no password, no recovery
  code. Clear your browser storage and every DM becomes permanently unreachable
  and everyone has to re-friend you. Use **Settings → Export** and keep the file
  somewhere; it's also how you get onto a second device.
- **No TURN server** — voice is peer-to-peer, and some pairs of people can't reach
  each other directly. Carrier-grade NAT on mobile and symmetric NAT on
  corporate/campus Wi-Fi make this maybe 5–15% of pairs, so in a group of six
  there's a real chance one specific pair can't hear each other while everyone
  else is fine. That's a baffling thing to debug, so the app now says so out loud
  when it happens, naming the person it couldn't reach. A TURN service
  (Cloudflare Calls sells one) is the actual fix.
- **A guild invite code is a permanent key.** Anyone you give it to is in until
  the server is abandoned; there is no un-inviting. DMs and groups are different —
  leaving or unfriending genuinely revokes access there.
- Voice is a full mesh: great for friend groups (~2–8 people), not for a 50-person raid.
  Screen share is the tighter constraint, since one sharer sends an independent
  video encode to every single person in the call.
- Anyone with the invite code is a full member — there are no roles/permissions. It's
  a clubhouse, not a moderation platform.
- Friend tags are global and first-come-first-served across everyone using the app.
- Every server you're in holds an open WebSocket for the whole session. That's what
  makes cross-server unread badges and background pings work, and it's nothing for a
  handful of servers — but it isn't a design that would scale to hundreds.
