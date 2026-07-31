// Concord threads / slowmode / voice-text / custom-emoji protocol tests.
// Usage: node test/threads.mjs [baseUrl]   (default http://127.0.0.1:4189)
// Covers CONTRACTS.md §3 (threads), §5 (slowmode), §7 (voice channels have
// text too) and §6 (custom emoji). A thread is "just a channel with a
// parent", so most of this is proving the existing msg/history/react/pin
// code paths work unmodified on a thread channel.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rand = (n) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const code = "TH" + rand(6);

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

console.log(`Concord threads test → ${base}  (server code ${code})`);

// --- setup: Alice creates the server (owner), Bob joins ---------------------------
const A = connect(`&create=1&name=ThreadsTest`);
await A.open();
A.send({ type: "hello", userId: "user-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA = await A.expect("Alice welcome", (m) => m.type === "welcome");
const textChan = welcomeA.channels.find((c) => c.type === "text");
const voiceChan = welcomeA.channels.find((c) => c.type === "voice");

const B = connect("");
await B.open();
B.send({ type: "hello", userId: "user-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
await B.expect("Bob welcome", (m) => m.type === "welcome");
await A.expect("Alice sees Bob join", (m) => m.type === "member-join");
ok("setup: Alice (owner) creates server, Bob joins");

// --- 1. create-thread broadcasts channel-create + msg-thread on the source msg ----
A.send({ type: "msg", chanId: textChan.id, content: "root message", nonce: "root1" });
const rootAck = await A.expect("root message ack", (m) => m.type === "msg-ack" && m.nonce === "root1");
const rootMsgId = rootAck.msg.id;
await B.expect("Bob sees root message", (m) => m.type === "msg" && m.msg.id === rootMsgId);

A.send({ type: "create-thread", chanId: textChan.id, msgId: rootMsgId, name: "about that" });
const threadCreate = await B.expect("channel-create for thread", (m) => m.type === "channel-create" && m.channel.type === "thread");
if (threadCreate.channel.parent !== textChan.id) fail("thread.parent must be the source channel", JSON.stringify(threadCreate.channel));
if (threadCreate.channel.rootId !== rootMsgId) fail("thread.rootId must be the source message id", JSON.stringify(threadCreate.channel));
// The contract's example shows the raw name "about that"; the implementation
// runs every channel name (thread or not) through the same cleanChannelName()
// slugifier used by create-channel (see smoke.mjs's "Smoke Lounge" -> "smoke-lounge"
// assertion), so the wire value is normalized, not the literal string.
if (threadCreate.channel.name !== "about-that") fail("thread name normalized like any other channel name", threadCreate.channel.name);
const threadId = threadCreate.channel.id;

const msgThread = await B.expect("msg-thread chip on the source message", (m) => m.type === "msg-thread" && m.msgId === rootMsgId);
if (msgThread.chanId !== textChan.id || msgThread.threadId !== threadId)
  fail("msg-thread payload shape", JSON.stringify(msgThread));
ok("threads: create-thread broadcasts channel-create(type:thread, parent, rootId) + msg-thread chip");

// --- 2. messages, history, reactions and pins all work inside a thread ------------
B.send({ type: "msg", chanId: threadId, content: "thread reply", nonce: "treply1" });
const treplyAck = await B.expect("thread reply ack", (m) => m.type === "msg-ack" && m.nonce === "treply1");
await A.expect("Alice receives thread reply", (m) => m.type === "msg" && m.msg.chanId === threadId && m.msg.content === "thread reply");
const treplyId = treplyAck.msg.id;

A.send({ type: "history", chanId: threadId });
const threadHistory = await A.expect("thread history", (m) => m.type === "history" && m.chanId === threadId);
if (!threadHistory.messages.some((mm) => mm.id === treplyId)) fail("thread history contains the reply", JSON.stringify(threadHistory.messages));

A.send({ type: "react", chanId: threadId, msgId: treplyId, emoji: "🔥" });
const threadReact = await B.expect("thread reaction", (m) => m.type === "msg-react" && m.chanId === threadId && m.msgId === treplyId);
if (!threadReact.reactions["🔥"]?.includes("user-alice")) fail("thread reaction recorded", JSON.stringify(threadReact.reactions));

A.send({ type: "pin", chanId: threadId, msgId: treplyId });
await B.expect("thread pin broadcast", (m) => m.type === "msg-pin" && m.chanId === threadId && m.msgId === treplyId && m.pinned === true);
A.send({ type: "pins", chanId: threadId });
const threadPins = await A.expect("thread pins list", (m) => m.type === "pins" && m.chanId === threadId);
if (!threadPins.messages.some((mm) => mm.id === treplyId)) fail("pinned thread message shows in pins list", JSON.stringify(threadPins.messages));
ok("threads: msg, history, react and pin all work inside a thread (shared code path)");

// --- 3. a second create-thread on the same message returns the existing thread ----
A.send({ type: "create-thread", chanId: textChan.id, msgId: rootMsgId, name: "a different name" });
const dupeReply = await A.expect("duplicate create-thread reply", (m) => m.type === "msg-thread" && m.msgId === rootMsgId);
if (dupeReply.threadId !== threadId) fail("second create-thread must return the existing thread id", JSON.stringify(dupeReply));
// The existing-thread reply goes directly back to the requester, not broadcast —
// Bob must not see a second channel-create for the same root message.
await B.expectSilence("no duplicate channel-create broadcast to other members", (m) => m.type === "channel-create" && m.channel?.rootId === rootMsgId);
ok("threads: a second create-thread on the same message returns the existing thread, no duplicate broadcast");

// --- 4. deleting the parent channel takes its threads and their messages with it --
A.send({ type: "create-channel", name: "doomed-parent" });
const doomedParent = await B.expect("doomed-parent channel-create", (m) => m.type === "channel-create" && m.channel.name === "doomed-parent");
const doomedChanId = doomedParent.channel.id;

A.send({ type: "msg", chanId: doomedChanId, content: "parent message", nonce: "doomed-root" });
const doomedRootAck = await A.expect("doomed parent message ack", (m) => m.type === "msg-ack" && m.nonce === "doomed-root");
const doomedRootId = doomedRootAck.msg.id;

A.send({ type: "create-thread", chanId: doomedChanId, msgId: doomedRootId, name: "doomed thread" });
const doomedThreadCreate = await B.expect("doomed thread channel-create", (m) => m.type === "channel-create" && m.channel.parent === doomedChanId);
const doomedThreadId = doomedThreadCreate.channel.id;
await B.expect("doomed thread msg-thread chip", (m) => m.type === "msg-thread" && m.threadId === doomedThreadId);

B.send({ type: "msg", chanId: doomedThreadId, content: "message inside the doomed thread", nonce: "doomed-in-thread" });
await B.expect("doomed thread message ack", (m) => m.type === "msg-ack" && m.nonce === "doomed-in-thread");
await A.expect("Alice sees message inside doomed thread", (m) => m.type === "msg" && m.msg.chanId === doomedThreadId);

A.send({ type: "delete-channel", chanId: doomedChanId });
const deleteBroadcasts = [
  await B.expect("channel-delete #1", (m) => m.type === "channel-delete"),
  await B.expect("channel-delete #2", (m) => m.type === "channel-delete"),
];
const deletedIds = deleteBroadcasts.map((m) => m.chanId).sort();
if (JSON.stringify(deletedIds) !== JSON.stringify([doomedChanId, doomedThreadId].sort()))
  fail("deleting the parent must delete it and its thread", JSON.stringify(deletedIds));

A.send({ type: "history", chanId: doomedThreadId });
const historyAfterDelete = await A.expect("history of the deleted thread", (m) => m.type === "history" && m.chanId === doomedThreadId);
if (historyAfterDelete.messages.length) fail("deleted thread's messages must be gone", JSON.stringify(historyAfterDelete.messages));
ok("threads: deleting the parent channel deletes its threads and their messages");

// --- 5. slowmode: second quick message is bounced, owner is exempt ----------------
A.send({ type: "create-channel", name: "slow-lane", slow: 5 });
const slowChan = await B.expect("slow-lane channel-create", (m) => m.type === "channel-create" && m.channel.name === "slow-lane");
if (slowChan.channel.slow !== 5) fail("channel.slow must be set from create-channel", JSON.stringify(slowChan.channel));
const slowChanId = slowChan.channel.id;

B.send({ type: "msg", chanId: slowChanId, content: "first (non-owner)", nonce: "slow1" });
await B.expect("first message in slow channel is accepted", (m) => m.type === "msg-ack" && m.nonce === "slow1");
B.send({ type: "msg", chanId: slowChanId, content: "second, too fast", nonce: "slow2" });
const slowmodeMsg = await B.expect("slowmode bounce for non-owner", (m) => m.type === "slowmode" && m.chanId === slowChanId);
if (!(slowmodeMsg.seconds > 0 && slowmodeMsg.seconds <= 5)) fail("slowmode.seconds in range", JSON.stringify(slowmodeMsg));
await B.expectSilence("bounced message must not also produce a msg-ack", (m) => m.type === "msg-ack" && m.nonce === "slow2");

A.send({ type: "msg", chanId: slowChanId, content: "owner first", nonce: "slowOwner1" });
await A.expect("owner's first message accepted", (m) => m.type === "msg-ack" && m.nonce === "slowOwner1");
A.send({ type: "msg", chanId: slowChanId, content: "owner immediately again", nonce: "slowOwner2" });
await A.expect("owner's second immediate message is also accepted (exempt)", (m) => m.type === "msg-ack" && m.nonce === "slowOwner2");
ok("slowmode: a second quick message is bounced with {type:\"slowmode\"}, the owner is exempt");

// --- 6. voice channels accept text messages (CHATTABLE) ----------------------------
A.send({ type: "msg", chanId: voiceChan.id, content: "chatting in a voice channel", nonce: "voicetext1" });
const voiceTextAck = await A.expect("voice-channel message ack", (m) => m.type === "msg-ack" && m.nonce === "voicetext1");
await B.expect("Bob receives the voice-channel text message", (m) => m.type === "msg" && m.msg.id === voiceTextAck.msg.id);
ok("voice channels: text messages are accepted and broadcast (CHATTABLE)");

// --- 7. custom emoji: add, appears in broadcast + welcome, react by name ----------
A.send({ type: "upload-ticket", files: [{ name: "blob.png", size: 12, mime: "image/png" }] });
const emojiTicket = await A.expect("emoji upload ticket", (m) => m.type === "upload-tickets");
const ticket = emojiTicket.tickets[0];
const put = await fetch(`${base}/api/upload/${ticket.id}?code=${code}`, { method: "PUT", body: "twelve bytes" });
const putBody = await put.json();

A.send({ type: "emoji-add", name: "blob", key: putBody.att.key });
const emojiBroadcast = await B.expect("emoji broadcast after add", (m) => m.type === "emoji" && m.list.some((e) => e.name === "blob"));
const blobEntry = emojiBroadcast.list.find((e) => e.name === "blob");
if (blobEntry.url !== `/f/${putBody.att.key}`) fail("emoji url points at the uploaded key", JSON.stringify(blobEntry));

const I = connect("");
await I.open();
I.send({ type: "hello", userId: "user-ivy", name: "Ivy", color: "#665544", avatar: "🐝" });
const welcomeI = await I.expect("Ivy welcome", (m) => m.type === "welcome");
if (!welcomeI.emoji?.some((e) => e.name === "blob")) fail("welcome must carry existing custom emoji", JSON.stringify(welcomeI.emoji));
ok("custom emoji: emoji-add shows up in the emoji broadcast and in a later welcome");

B.send({ type: "msg", chanId: textChan.id, content: "emoji reaction target", nonce: "emojiTarget" });
const emojiTargetAck = await B.expect("emoji-target message ack", (m) => m.type === "msg-ack" && m.nonce === "emojiTarget");
const emojiTargetId = emojiTargetAck.msg.id;

I.send({ type: "react", chanId: textChan.id, msgId: emojiTargetId, emoji: ":blob:" });
const customReact = await B.expect("custom-emoji reaction accepted", (m) => m.type === "msg-react" && m.msgId === emojiTargetId && m.reactions[":blob:"]);
if (!customReact.reactions[":blob:"].includes("user-ivy")) fail("custom emoji reaction recorded the right user", JSON.stringify(customReact.reactions));

// A name that doesn't resolve to a real emoji must be rejected outright — the
// react handler returns before touching storage, so nothing is broadcast.
// This asserts an absence; kept short since it's a true no-op, not a timing race.
I.send({ type: "react", chanId: textChan.id, msgId: emojiTargetId, emoji: ":nope:" });
await B.expectSilence("unknown custom emoji name is rejected, not reflected in a reaction", (m) => m.type === "msg-react" && m.reactions?.[":nope:"], 500);
ok("custom emoji: :name: reactions work for real emoji, unknown names are rejected");

A.ws.close();
B.ws.close();
I.ws.close();
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
