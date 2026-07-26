# Concord 🎧

**It's like Discord, but agreeable.** A knockoff-Discord voice & text chat app for you and
your friends, small enough to fit in one Cloudflare Worker.

**Live at → https://concord.jeffnugget.workers.dev**

## How friends join (the whole onboarding)

1. You: click **Invite** in the app, copy the link (looks like `https://concord.jeffnugget.workers.dev/?join=XK4PQ2M9`).
2. Them: open the link, pick a name + avatar, done. They're in your server.
3. Everyone: click a voice channel to start talking.

No accounts, no emails, no phone verification, no Nitro upsell. The invite code *is* the key
to the server, so only share it with people you want in.

## Features

- **Servers** with invite codes; join as many as you want (left rail)
- **Text channels** — history, edit/delete, replies, emoji reactions, typing indicators,
  markdown (`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``, ``` ```blocks``` ```), links,
  unread badges + notification pings, emoji picker
- **Voice channels** — real-time group voice (WebRTC mesh), speaking indicators,
  mute / deafen, push-to-talk with a bindable key, per-user volume (right-click someone
  in voice), input-device picker, join/leave sounds
- **Screen share** — one click, shows as a tile above chat for everyone in voice
- **Profiles** — name, emoji avatar, color, custom status; channel create/rename/delete;
  server rename; it remembers everything in your browser

## Architecture

```
public/    static client (vanilla JS, no build step)
worker/    Cloudflare Worker + ConcordServer Durable Object
test/      protocol smoke test (node test/smoke.mjs [url])
```

One Durable Object per server holds channels, the last 300 messages per channel,
live presence and voice state, and relays WebRTC signaling. Voice audio itself is
peer-to-peer (mesh) — the server never hears you.

## Dev

```bash
npm install
npm run dev       # wrangler dev on http://localhost:4189
npm run smoke     # protocol test against the dev server
npm run deploy    # ship it
```

Note: this machine pins `wrangler` 3.x (Node 20). If you upgrade Node to 22+, wrangler 4 works too.

## Known limitations (a.k.a. the free tier speaks)

- **No TURN server** — on rare strict-NAT networks (some corporate/campus Wi-Fi, some
  mobile carriers) voice may fail to connect between two specific people. Everything
  else still works. A TURN service (e.g. Cloudflare Calls) is the fix if it ever matters.
- Voice is a full mesh: great for friend groups (~2–8 people), not for a 50-person raid.
- Anyone with the invite code is a full member — there are no roles/permissions. It's
  a clubhouse, not a moderation platform.
