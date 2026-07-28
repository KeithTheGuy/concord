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
  and **DM voice calls** (the 📞 button). Unread counts survive being offline
- **Servers** with invite codes; join as many as you want (left rail)
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
- **Voice channels** — real-time group voice (WebRTC mesh), speaking indicators,
  mute / deafen, push-to-talk with a bindable key, per-user volume (right-click someone
  in voice), input-device picker, join/leave sounds
- **Voice changer** — real-time pitch shifting on your mic before it reaches the
  call: Feminine, Anime girl, Chipmunk, Deeper, Demon, or dial any shift from
  -12 to +12 semitones. Hit 🎭 in the voice panel to swap mid-sentence
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
test/      smoke.mjs (protocol) · e2e.mjs (two-browser incl. live WebRTC audio)
           social.mjs (friends + DMs across two browsers) · desktop.mjs (Electron)
           shot.mjs (screenshots) · icons.mjs (app icons)
```

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
npm run smoke     # protocol test against the dev server
npm run e2e       # two-browser Playwright test (chat + voice + notifications)
npm run social    # two-browser test of friends, requests, DMs and DM unreads
npm run app       # run the desktop app from source
npm run dist      # build Windows installer + portable exe into dist/
npm run deploy    # ship the web app
```

Note: this machine pins `wrangler` 3.x (Node 20). If you upgrade Node to 22+, wrangler 4 works too.

## Known limitations (a.k.a. the free tier speaks)

- **No TURN server** — on rare strict-NAT networks (some corporate/campus Wi-Fi, some
  mobile carriers) voice may fail to connect between two specific people. Everything
  else still works. A TURN service (e.g. Cloudflare Calls) is the fix if it ever matters.
- Voice is a full mesh: great for friend groups (~2–8 people), not for a 50-person raid.
- Anyone with the invite code is a full member — there are no roles/permissions. It's
  a clubhouse, not a moderation platform.
- **Opening a DM steps out of the server you were in.** There's one live server socket,
  and a DM borrows it (which is exactly why DM calls work). You keep getting DM pings
  and friend presence from the hub the whole time, but not that server's channel pings
  until you click back. Two sockets would fix it; it hasn't been worth the complexity.
- Friend tags are global and first-come-first-served across everyone using the app.
