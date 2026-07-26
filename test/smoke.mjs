// Concord backend smoke test.
// Usage: node test/smoke.mjs [baseUrl]   (default http://127.0.0.1:4189)
// Spins up two WebSocket clients on a fresh random server code and walks the
// whole protocol: create/join, presence, chat, history, edit, react, typing,
// voice join/leave, rtc relay, and bad-server rejection.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code =
  "SM" + Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

function connect(params) {
  const ws = new WebSocket(`${wsBase}/ws?server=${code}${params}`);
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    } else {
      queue.push(m);
    }
  });
  return {
    ws,
    send: (obj) => ws.send(JSON.stringify(obj)),
    expect: (label, match, timeoutMs = 5000) =>
      new Promise((resolve) => {
        const i = queue.findIndex(match);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        const timer = setTimeout(() => fail(label, `timed out waiting for message`), timeoutMs);
        waiters.push({ match, resolve, timer });
      }),
    // Assert a message matching `match` does NOT arrive within windowMs.
    expectSilence: (label, match, windowMs = 800) =>
      new Promise((resolve) => {
        if (queue.some(match)) return fail(label, "unexpected message already queued");
        const w = {
          match,
          resolve: () => fail(label, "unexpected message arrived"),
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(w), 1);
            resolve();
          }, windowMs),
        };
        waiters.push(w);
      }),
    open: () => new Promise((res, rej) => (ws.on("open", res), ws.on("unexpected-response", (_r, resp) => rej(resp.statusCode)))),
  };
}

console.log(`Concord smoke test → ${base}  (server code ${code})`);

// --- 0. joining a nonexistent server is rejected -----------------------------
{
  const bad = new WebSocket(`${wsBase}/ws?server=ZZZZ9999`);
  const status = await new Promise((resolve) => {
    bad.on("unexpected-response", (_req, resp) => resolve(resp.statusCode));
    bad.on("open", () => resolve("opened"));
    setTimeout(() => resolve("timeout"), 5000);
  });
  if (status !== 404) fail("reject unknown server", `got ${status}, wanted 404`);
  ok("joining unknown server code is rejected with 404");
}

// --- 1. Alice creates the server ---------------------------------------------
const A = connect(`&create=1&name=SmokeServer`);
await A.open();
A.send({ type: "hello", userId: "user-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA = await A.expect("Alice welcome", (m) => m.type === "welcome");
if (welcomeA.meta.name !== "SmokeServer") fail("server name", JSON.stringify(welcomeA.meta));
if (!Array.isArray(welcomeA.channels) || welcomeA.channels.length < 4)
  fail("default channels", JSON.stringify(welcomeA.channels));
const textChan = welcomeA.channels.find((c) => c.type === "text");
const voiceChan = welcomeA.channels.find((c) => c.type === "voice");
const aliceSid = welcomeA.you.sid;
ok(`create+welcome (channels: ${welcomeA.channels.map((c) => c.name).join(", ")})`);

// --- 2. Bob joins, both see each other ----------------------------------------
const B = connect("");
await B.open();
B.send({ type: "hello", userId: "user-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
const welcomeB = await B.expect("Bob welcome", (m) => m.type === "welcome");
const bobSid = welcomeB.you.sid;
if (!welcomeB.members.some((mm) => mm.name === "Alice")) fail("Bob sees Alice");
await A.expect("Alice sees member-join", (m) => m.type === "member-join" && m.member.name === "Bob");
ok("presence: both members see each other");

// --- 3. chat message + ack + broadcast ----------------------------------------
A.send({ type: "msg", chanId: textChan.id, content: "hello **world**", nonce: "n1" });
const ackA = await A.expect("msg-ack", (m) => m.type === "msg-ack" && m.nonce === "n1");
const gotB = await B.expect("Bob receives msg", (m) => m.type === "msg" && m.msg.content === "hello **world**");
if (gotB.msg.author.name !== "Alice") fail("author attribution");
const msgId = ackA.msg.id;
ok("chat: send, author ack with nonce, broadcast");

// --- 4. history ----------------------------------------------------------------
B.send({ type: "history", chanId: textChan.id });
const hist = await B.expect("history", (m) => m.type === "history" && m.chanId === textChan.id);
if (!hist.messages.some((mm) => mm.id === msgId && mm.content === "hello **world**"))
  fail("history contains message", JSON.stringify(hist.messages));
ok("history: persisted message fetched");

// --- 5. edit + react + typing ----------------------------------------------------
A.send({ type: "edit", chanId: textChan.id, msgId, content: "hello *edited*" });
await B.expect("msg-edit", (m) => m.type === "msg-edit" && m.msg.content === "hello *edited*");
B.send({ type: "react", chanId: textChan.id, msgId, emoji: "👍" });
const react = await A.expect("msg-react", (m) => m.type === "msg-react" && m.msgId === msgId);
if (!react.reactions["👍"] || react.reactions["👍"][0] !== "user-bob") fail("reaction users");
B.send({ type: "typing", chanId: textChan.id });
await A.expect("typing", (m) => m.type === "typing" && m.name === "Bob");
ok("edit, reaction toggle, typing indicator");

// --- 6. voice join/peers/state ---------------------------------------------------
A.send({ type: "voice-join", chanId: voiceChan.id });
const peersA = await A.expect("Alice voice-peers", (m) => m.type === "voice-peers");
if (peersA.peers.length !== 0) fail("Alice should be first in voice");
B.send({ type: "voice-join", chanId: voiceChan.id });
const peersB = await B.expect("Bob voice-peers", (m) => m.type === "voice-peers");
if (peersB.peers.length !== 1 || peersB.peers[0] !== aliceSid)
  fail("Bob's peer list should be [Alice]", JSON.stringify(peersB.peers));
await A.expect(
  "Alice sees Bob in voice",
  (m) => m.type === "member-update" && m.member.sid === bobSid && m.member.voice?.chanId === voiceChan.id
);
A.send({ type: "voice-state", muted: true });
await B.expect(
  "Bob sees Alice muted",
  (m) => m.type === "member-update" && m.member.sid === aliceSid && m.member.voice?.muted === true
);
ok("voice: join, peer discovery, state broadcast");

// --- 7. rtc relay is addressed, not broadcast --------------------------------------
B.send({ type: "rtc", to: aliceSid, data: { kind: "offer", sdp: "fake-sdp" } });
const rtc = await A.expect("rtc relayed", (m) => m.type === "rtc" && m.data.sdp === "fake-sdp");
if (rtc.from !== bobSid) fail("rtc from field");
await B.expectSilence("rtc not echoed to sender", (m) => m.type === "rtc");
B.send({ type: "rtc", to: "nobody99", data: { kind: "offer" } });
await B.expect("rtc-gone for missing peer", (m) => m.type === "rtc-gone" && m.sid === "nobody99");
ok("rtc: addressed relay + rtc-gone for dead peers");

// --- 7b. rtc must not cross voice channels ------------------------------------
const otherVoice = welcomeA.channels.find((c) => c.type === "voice" && c.id !== voiceChan.id);
B.send({ type: "voice-join", chanId: otherVoice.id });
await B.expect("Bob switches voice channel", (m) => m.type === "voice-peers" && m.chanId === otherVoice.id);
B.send({ type: "rtc", to: aliceSid, data: { kind: "offer", sdp: "cross-channel" } });
await B.expect("cross-channel rtc rejected", (m) => m.type === "rtc-gone" && m.sid === aliceSid);
await A.expectSilence("Alice never gets cross-channel rtc", (m) => m.type === "rtc" && m.data?.sdp === "cross-channel");
ok("rtc: relay refused across different voice channels");

// --- 8. channel create --------------------------------------------------------------
A.send({ type: "create-channel", name: "Smoke Lounge", chanType: "voice" });
const created = await B.expect("channel-create", (m) => m.type === "channel-create");
if (created.channel.name !== "smoke-lounge" || created.channel.type !== "voice")
  fail("channel normalized name", JSON.stringify(created.channel));
ok("channel create broadcast (name normalized)");

// --- 8b. distinct-reaction cap -----------------------------------------------------
await new Promise((r) => setTimeout(r, 5200)); // fresh rate-limit window
const REACTS = "abcdefghijklmnopqrs".split(""); // +👍 from earlier = 20 keys
for (const e of REACTS) B.send({ type: "react", chanId: textChan.id, msgId, emoji: "r" + e });
await A.expect(
  "20th reaction key lands",
  (m) => m.type === "msg-react" && m.msgId === msgId && Object.keys(m.reactions).length === 20
);
B.send({ type: "react", chanId: textChan.id, msgId, emoji: "overflow" });
await A.expectSilence(
  "21st distinct reaction rejected",
  (m) => m.type === "msg-react" && m.reactions && m.reactions["overflow"]
);
ok("reactions: capped at 20 distinct keys per message");

// --- 8c. Gremlin Mode prank relay ----------------------------------------------------
A.send({ type: "prank", to: bobSid, kind: "earthquake" });
const pranked = await B.expect("Bob gets pranked", (m) => m.type === "pranked");
if (pranked.kind !== "earthquake" || pranked.name !== "Alice")
  fail("prank payload", JSON.stringify(pranked));
await A.expect("Alice gets prank-sent ack", (m) => m.type === "prank-sent" && m.kind === "earthquake");
await A.expectSilence("pranker never pranks themselves", (m) => m.type === "pranked");
A.send({ type: "prank", to: bobSid, kind: "bluescreen" });
const cd = await A.expect("cooldown enforced", (m) => m.type === "prank-cooldown");
if (!(cd.seconds > 0 && cd.seconds <= 15)) fail("cooldown seconds", JSON.stringify(cd));
await B.expectSilence("second prank blocked by cooldown", (m) => m.type === "pranked");
B.send({ type: "prank", to: aliceSid, kind: "not-a-real-prank" });
await A.expectSilence("unknown prank kinds rejected", (m) => m.type === "pranked");
ok("gremlin: prank relay, self-exclusion, 15s cooldown, unknown-kind rejection");

// --- 9. disconnect cleanup ------------------------------------------------------------
B.ws.close();
await A.expect("member-leave", (m) => m.type === "member-leave" && m.sid === bobSid);
ok("disconnect: member-leave broadcast");

A.ws.close();
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
