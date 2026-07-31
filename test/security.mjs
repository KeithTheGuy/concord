// Concord identity + upload-hardening tests.
// Usage: node test/security.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// The invite code is the only credential this app has, so the one thing that
// must hold is that an identity the server *remembers* cannot be assumed by
// someone who can't prove it. It used to be assumable: the auth sweep evicted
// dormant rows by last-seen while exempting only live sockets, so an offline
// owner could be flooded out of their own auth row and then claimed by name.
// This suite runs that attack and a few smaller ones on the upload path.

import WebSocket from "ws";
import http from "node:http";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rand = (n) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const code = "SE" + rand(6);
const code2 = "SF" + rand(6);

// AUTH_CAP is 300, and the sweep only counts rows whose socket is already gone,
// so the flood has to be comfortably above the cap and only modestly parallel —
// forty at a time and four hundred of them still leaves the sweep looking at
// fewer than 300 dormant rows, and nothing is ever evicted. This is the slowest
// part of the suite, which is why it happens exactly once.
const FLOOD = 440;
const FLOOD_BATCH = 20;

let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

// Generous on purpose. Proving the identity takeover needs ~440 sockets to
// force an eviction sweep, which takes about 8s on an idle machine and several
// times that when anything else is competing for the CPU. A watchdog that fires
// under load reports a security regression that isn't there, which is the worst
// possible false alarm to train yourself to ignore.
const watchdog = setTimeout(() => fail("security suite", "whole suite timed out"), 600_000);
watchdog.unref?.();

function connect(server, params = "") {
  const ws = new WebSocket(`${wsBase}/ws?server=${server}${params}`);
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
    expect: (label, match, timeoutMs = 10000) =>
      new Promise((resolve) => {
        const i = queue.findIndex(match);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        const timer = setTimeout(() => fail(label, "timed out waiting for message"), timeoutMs);
        waiters.push({ match, resolve, timer });
      }),
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
    open: () =>
      new Promise((res, rej) => (ws.on("open", res), ws.on("unexpected-response", (_r, resp) => rej(resp.statusCode)))),
  };
}

// One anonymous hello, then gone — exactly what an attacker minting throwaway
// identities does.
function anonHello(server) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws?server=${server}`);
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "welcome") {
        ws.close();
        resolve();
      }
    });
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", name: "Anon", color: "#000000", avatar: "😈" })));
    ws.on("error", () => resolve());
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Concord security test → ${base}  (server codes ${code}, ${code2})`);

/* ============================ identity anchoring ============================ */

// --- setup: Alice creates the server and becomes its owner, then leaves --------
const A = connect(code, `&create=1&name=SecurityTest`);
await A.open();
A.send({ type: "hello", userId: "owner-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA = await A.expect("Alice welcome", (m) => m.type === "welcome");
if (welcomeA.owner !== "owner-alice") fail("first hello takes ownership", JSON.stringify(welcomeA.owner));
const aliceToken = welcomeA.token;
const textChan = welcomeA.channels.find((c) => c.type === "text");
A.send({ type: "msg", chanId: textChan.id, content: "mine, I think", nonce: "own1" });
const aliceMsg = await A.expect("Alice posts", (m) => m.type === "msg-ack" && m.nonce === "own1");
A.ws.close();
await sleep(300);
ok("setup: Alice owns the server, has a message to her name, and has closed her tab");

// --- 1. flooding the auth table must not unseat an offline owner ---------------
const floodStarted = Date.now();
for (let i = 0; i < FLOOD; i += FLOOD_BATCH) {
  await Promise.all(Array.from({ length: Math.min(FLOOD_BATCH, FLOOD - i) }, () => anonHello(code)));
}
ok(`attack: minted ${FLOOD} throwaway identities in ${((Date.now() - floodStarted) / 1000).toFixed(1)}s (AUTH_CAP is 300, so the sweep has run)`);

const thief = connect(code);
await thief.open();
thief.send({ type: "hello", userId: "owner-alice", name: "Alice", color: "#ff5555", avatar: "🦊" }); // no token
const thiefWelcome = await thief.expect("thief welcome", (m) => m.type === "welcome");
if (thiefWelcome.you.userId === "owner-alice")
  fail("identity takeover", "an untokened hello was handed the owner's userId");
if (thiefWelcome.owner !== "owner-alice")
  fail("ownership takeover", `owner is now ${thiefWelcome.owner}`);
ok("identity: after the flood, claiming the offline owner's userId without a token still gets you a stranger's id");

// The other half of the theft: whoever holds the userId inherits authorship.
thief.send({ type: "delete", chanId: textChan.id, msgId: aliceMsg.msg.id });
thief.send({ type: "edit", chanId: textChan.id, msgId: aliceMsg.msg.id, content: "signed, Alice" });
await sleep(400);
thief.send({ type: "history", chanId: textChan.id });
const afterThief = await thief.expect("history after theft attempt", (m) => m.type === "history");
const survivor = afterThief.messages.find((x) => x.id === aliceMsg.msg.id);
if (!survivor) fail("message authorship", "the thief deleted the owner's message");
if (survivor.content !== "mine, I think") fail("message authorship", `edited to "${survivor.content}"`);
ok("identity: the thief inherits neither the owner's messages nor the right to edit them");

// --- 2. the real owner comes back and is still the owner -----------------------
const A2 = connect(code);
await A2.open();
A2.send({ type: "hello", userId: "owner-alice", token: aliceToken, name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA2 = await A2.expect("Alice returns", (m) => m.type === "welcome");
if (welcomeA2.you.userId !== "owner-alice")
  fail("owner recovery", `Alice came back as ${welcomeA2.you.userId} — her identity was swept out from under her`);
if (welcomeA2.owner !== "owner-alice") fail("owner recovery", `owner is ${welcomeA2.owner}`);
A2.send({ type: "bans" });
await A2.expect("owner-only op still works for Alice", (m) => m.type === "bans");
ok("identity: the owner's own token still returns her userId, her ownership and her moderation powers");

thief.send({ type: "bans" });
await thief.expectSilence("thief cannot moderate", (m) => m.type === "bans");
ok("identity: the thief is refused owner-only ops server-side");
thief.ws.close();
A2.ws.close();

// --- 3. the last member leaving must not put the server up for grabs ------------
const B = connect(code2, `&create=1&name=LeaveTest`);
await B.open();
B.send({ type: "hello", userId: "owner-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
const welcomeB = await B.expect("Bob welcome", (m) => m.type === "welcome");
if (welcomeB.owner !== "owner-bob") fail("Bob owns his server", JSON.stringify(welcomeB.owner));
B.send({ type: "leave-server" });
await sleep(400);
B.ws.close();
await sleep(300);

const squatter = connect(code2);
await squatter.open();
squatter.send({ type: "hello", name: "Squatter", color: "#000000", avatar: "😈" });
const squatWelcome = await squatter.expect("squatter welcome", (m) => m.type === "welcome");
if (squatWelcome.owner !== "owner-bob")
  fail("ownership after the last member leaves", `owner became ${squatWelcome.owner}`);
squatter.send({ type: "bans" });
await squatter.expectSilence("squatter cannot moderate", (m) => m.type === "bans");
ok("identity: the last member leaving keeps the title rather than leaving an unowned server for the next hello");

squatter.send({ type: "hello", userId: "owner-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
await squatter.expectSilence("re-hello is still ignored", (m) => m.type === "welcome");
squatter.ws.close();

const impostor = connect(code2);
await impostor.open();
impostor.send({ type: "hello", userId: "owner-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
const impWelcome = await impostor.expect("impostor welcome", (m) => m.type === "welcome");
if (impWelcome.you.userId === "owner-bob") fail("departed owner's identity", "claimable without a token");
impostor.ws.close();
ok("identity: a member who left is still remembered — their userId is not free to take");

/* ============================== upload hardening ============================= */

const U = connect(code2);
await U.open();
U.send({ type: "hello", userId: "upload-user", name: "Up", color: "#8888ff", avatar: "📎" });
const welcomeU = await U.expect("upload user welcome", (m) => m.type === "welcome");
const upChan = welcomeU.channels.find((c) => c.type === "text");

// --- 4. the declared size is enforced, not decorative ---------------------------
U.send({ type: "upload-ticket", nonce: "nx1", files: [{ name: "tiny.txt", size: 10, mime: "text/plain" }] });
const tinyTix = await U.expect("tiny ticket", (m) => m.type === "upload-tickets");
if (tinyTix.nonce !== "nx1") fail("upload-tickets echoes the nonce", JSON.stringify(tinyTix.nonce));
const overrun = await fetch(`${base}/api/upload/${tinyTix.tickets[0].id}?code=${code2}`, {
  method: "PUT",
  body: Buffer.alloc(5000, 0x41),
});
if (overrun.status !== 413)
  fail("declared size enforced", `declared 10 bytes, uploaded 5000, got ${overrun.status} instead of 413`);
await overrun.text();
ok("uploads: a ticket declaring 10 bytes cannot be spent on 5000 (413), and the reply echoed the batch nonce");

// --- 5. upload errors are tagged so one failure can't sink the batch -------------
U.send({
  type: "upload-ticket",
  nonce: "nx2",
  files: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, size: 10, mime: "text/plain" })),
});
const tagged = await U.expect("tagged upload error", (m) => m.type === "error");
if (tagged.for !== "upload-ticket") fail("upload errors carry for:", JSON.stringify(tagged));
if (tagged.nonce !== "nx2") fail("upload errors echo the nonce", JSON.stringify(tagged));
ok(`uploads: a refusal is tagged for:"upload-ticket" and carries its nonce — "${tagged.error}"`);

// --- 6. an upload that never finished must not become a broken image -------------
// Declare a length, send a fraction of it, then hang up. The ticket has already
// been claimed at that point, so without a head-check the key attaches happily
// to a message and 404s forever after.
U.send({ type: "upload-ticket", nonce: "nx3", files: [{ name: "halfway.png", size: 5000, mime: "image/png" }] });
const halfTix = await U.expect("half-upload ticket", (m) => m.type === "upload-tickets");
const halfKey = halfTix.tickets[0].key;
await new Promise((resolve) => {
  const target = new URL(`${base}/api/upload/${halfTix.tickets[0].id}?code=${code2}`);
  const req = http.request(
    {
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: "PUT",
      headers: { "Content-Length": "5000" },
    },
    () => resolve()
  );
  req.on("error", () => resolve());
  req.write(Buffer.alloc(200, 0x42));
  setTimeout(() => {
    req.destroy();
    resolve();
  }, 700);
});
await sleep(500);

U.send({
  type: "msg",
  chanId: upChan.id,
  content: "did it land?",
  nonce: "half1",
  attachments: [{ key: halfKey, name: "halfway.png", size: 5000, mime: "image/png" }],
});
const halfAck = await U.expect("half-upload message ack", (m) => m.type === "msg-ack" && m.nonce === "half1");
if (halfAck.msg.attachments?.length) {
  // Attaching is only acceptable if the bytes are actually there to serve.
  const check = await fetch(`${base}/f/${halfKey}`);
  await check.arrayBuffer();
  if (check.status !== 200)
    fail("aborted upload", `a key with no object attached to a message and GET /f/<key> → ${check.status}`);
  ok("uploads: an interrupted upload either attaches with real bytes behind it, or not at all (bytes landed)");
} else {
  ok("uploads: an interrupted upload's key is refused at attach time rather than posting a permanent 404");
}

// --- 7. the upload budget is per person and survives a reconnect ------------------
// 30 uploads per 10 minutes. Spend them in batches of 10, reconnecting in the
// middle: a limiter that only lived in memory would still hold here, but one
// that only lived in *this socket* would not.
U.ws.close();
let spent = 0;
let U2 = connect(code2);
await U2.open();
U2.send({ type: "hello", userId: "budget-user", name: "Budget", color: "#8888ff", avatar: "📎" });
const welcomeBudget = await U2.expect("budget user welcome", (m) => m.type === "welcome");
for (let batch = 0; batch < 3; batch++) {
  if (batch === 2) {
    U2.ws.close();
    await sleep(200);
    U2 = connect(code2);
    await U2.open();
    U2.send({ type: "hello", userId: "budget-user", token: welcomeBudget.token, name: "Budget", color: "#8888ff", avatar: "📎" });
    const back = await U2.expect("budget user reconnect", (m) => m.type === "welcome");
    if (back.you.userId !== "budget-user") fail("budget user identity", JSON.stringify(back.you.userId));
  }
  U2.send({
    type: "upload-ticket",
    nonce: `b${batch}`,
    files: Array.from({ length: 10 }, (_, i) => ({ name: `b${batch}-${i}.txt`, size: 4, mime: "text/plain" })),
  });
  const got = await U2.expect(`budget batch ${batch}`, (m) => m.type === "upload-tickets" || m.type === "error");
  if (got.type !== "upload-tickets") fail(`budget batch ${batch}`, JSON.stringify(got));
  // Spend them all, or the pending-ticket cap answers before the budget does.
  for (const t of got.tickets) {
    const r = await fetch(`${base}/api/upload/${t.id}?code=${code2}`, { method: "PUT", body: "abcd" });
    if (r.status !== 200) fail("spending a budget ticket", `status ${r.status}`);
    await r.json();
    spent++;
  }
}
U2.send({ type: "upload-ticket", nonce: "over", files: [{ name: "one-too-many.txt", size: 4, mime: "text/plain" }] });
const overBudget = await U2.expect("budget exhausted", (m) => m.type === "error" || m.type === "upload-tickets");
if (overBudget.type !== "error") fail("upload budget", `${spent + 1} uploads in 10 minutes was allowed`);
if (overBudget.for !== "upload-ticket") fail("budget error tagging", JSON.stringify(overBudget));
ok(`uploads: the 31st upload in ten minutes is refused across a reconnect — "${overBudget.error}"`);

U2.ws.close();
clearTimeout(watchdog);
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
