// Concord call-relay tests.
// Usage: node test/callring.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// `call-ring` is the one hub op that writes nothing, so there is no row to
// inspect afterwards and every assertion here is about what did or did not
// arrive on somebody else's socket. That makes "nothing arrives" the most
// important shape in the file: a ring the recipient must not get is
// indistinguishable, from the caller's end, from one that simply landed
// nowhere — which is the point, and is what `silence()` is for.
//
// The gap it exists to close is worth restating: a ring is otherwise derived
// from the DM's own socket, and a DM you have not opened this session has no
// socket. Every check below is against a recipient who has never touched the
// conversation.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");

let passed = 0;
const ok = (label) => {
  passed++;
  console.log(`  PASS ${label}`);
};
function fail(label, detail) {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => fail("callring suite", "whole suite timed out"), 180_000);
watchdog.unref?.();

/* ------------------------------- plumbing -------------------------------- */

function socket(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("error", () => {});
  ws.on("message", (data) => {
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
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
    send: (obj) => {
      try {
        ws.send(JSON.stringify(obj));
      } catch {}
    },
    expect: (label, match, timeoutMs = 10000) =>
      new Promise((resolve) => {
        const i = queue.findIndex(match);
        if (i >= 0) return resolve(queue.splice(i, 1)[0]);
        const timer = setTimeout(() => fail(label, "timed out waiting for message"), timeoutMs);
        waiters.push({ match, resolve, timer });
      }),
    silence: (label, match, windowMs = 900) =>
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
    // How many of these are sitting unread. The rate-limit check needs a count
    // rather than a verdict, and `expect` is the wrong tool for that: it fails
    // the suite on a timeout, which is exactly what "fewer arrived than I asked
    // for" looks like.
    drain: (match) => {
      let n = 0;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (match(queue[i])) {
          queue.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    open: () =>
      new Promise((res, rej) => {
        ws.on("open", res);
        ws.on("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
        ws.on("error", rej);
      }),
  };
}

async function account(name, saved = null) {
  const c = socket(`${wsBase}/ws?hub=1`);
  await c.open();
  c.send({
    type: "hello",
    uid: saved?.uid || "",
    token: saved?.token || "",
    name,
    avatar: "🙂",
    color: "#5865f2",
    status: "",
    presence: "online",
  });
  const welcome = await c.expect(
    `${name} hub-welcome`,
    (m) => m.type === "hub-welcome" || m.type === "hub-error"
  );
  if (welcome.type !== "hub-welcome") fail(`${name} hub-welcome`, JSON.stringify(welcome));
  c.uid = welcome.you.uid;
  c.token = welcome.token;
  c.tag = welcome.you.tag;
  c.welcome = welcome;
  return c;
}

async function befriend(a, b) {
  a.send({ type: "friend-add", tag: b.tag });
  await b.expect("friend-request arrives", (m) => m.type === "friend-request" && m.user.uid === a.uid);
  b.send({ type: "friend-accept", uid: a.uid });
  const added = await a.expect("friend-added", (m) => m.type === "friend-added" && m.user.uid === b.uid);
  await b.expect("friend-added mirror", (m) => m.type === "friend-added" && m.user.uid === a.uid);
  return added.user.dm;
}

const isRing = (from) => (m) => m.type === "call-ring" && m.uid === from;
const isEnd = (from) => (m) => m.type === "call-end" && m.uid === from;

console.log(`Concord call relay test → ${base}`);

/* ========== 1. a friend can ring a DM that was never opened =============== */

{
  const caller = await account("Cal");
  const target = await account("Tess");
  await befriend(caller, target);

  // Neither side has ever connected to the conversation. That is the whole
  // reason this op exists — the DM's own socket cannot ring anybody here,
  // because there isn't one.
  caller.send({ type: "call-ring", uid: target.uid, chanId: "c2" });
  const ring = await target.expect("ring lands", isRing(caller.uid));
  if (ring.name !== "Cal") fail("the ring names the caller", JSON.stringify(ring));
  if (ring.chanId !== "c2") fail("the ring carries the voice channel", JSON.stringify(ring));
  ok("ring: a friend rings a DM neither party has opened this session, and it names the caller and the channel");

  // Reconnecting answers both remaining questions about that ring at once: a
  // fresh `hub-welcome` is what a reloaded tab actually gets.
  target.ws.close();
  await sleep(200);
  const back = await account("Tess", { uid: target.uid, token: target.token });

  // It already carries the conversation code, which is why the relay
  // deliberately doesn't repeat it. If this ever stopped being true the client
  // would need a `dm-open` round-trip before it could answer.
  const known = back.welcome.friends.find((f) => f.uid === caller.uid);
  if (!known?.dm) fail("hub-welcome already carries the DM code", JSON.stringify(known));
  ok("ring: the recipient already has the conversation code from hub-welcome, so the relay needn't repeat it");

  // And nothing was stored. A durable ring would have to surface in `dmUnread`,
  // and a missed call must not — that is the whole reason this isn't `dm-nudge`.
  if (Object.keys(back.welcome.dmUnread || {}).length) {
    fail("a ring stores nothing", `dmUnread is ${JSON.stringify(back.welcome.dmUnread)}`);
  }
  await back.silence("no replayed ring", (m) => m.type === "call-ring");
  ok("ring: it leaves no unread, no badge and nothing to replay — a missed call is simply missed");

  for (const c of [caller, back]) c.ws.close();
}

/* ========== 2. call-end retracts it ====================================== */

{
  const caller = await account("Cal2");
  const target = await account("Tess2");
  await befriend(caller, target);

  caller.send({ type: "call-ring", uid: target.uid, chanId: "c2" });
  await target.expect("ring lands", isRing(caller.uid));
  caller.send({ type: "call-end", uid: target.uid });
  const end = await target.expect("hang-up lands", isEnd(caller.uid));
  if (end.gdm) fail("a 1:1 call-end names the caller, not a group", JSON.stringify(end));
  ok("end: hanging up sends a matching call-end, so the ring is retractable rather than permanent");

  for (const c of [caller, target]) c.ws.close();
}

/* ========== 3. only friends, and never someone who blocked you ============ */

{
  const stranger = await account("Stranger");
  const victim = await account("Vic");

  stranger.send({ type: "call-ring", uid: victim.uid, chanId: "c2" });
  await victim.silence("a stranger cannot ring", (m) => m.type === "call-ring");
  ok("gate: a non-friend cannot ring you — the friend row is the whole permission");

  // Half a friendship is not a friendship: ask for a friend, then have it
  // declined, and the request state must not be enough to make a phone go off.
  stranger.send({ type: "friend-add", tag: victim.tag });
  await victim.expect("request arrives", (m) => m.type === "friend-request" && m.user.uid === stranger.uid);
  stranger.send({ type: "call-ring", uid: victim.uid, chanId: "c2" });
  await victim.silence("a pending request cannot ring", (m) => m.type === "call-ring");
  ok("gate: a pending friend request is not a friendship, and cannot ring");

  const pest = await account("Pest");
  const blocker = await account("Blocker");
  await befriend(pest, blocker);
  blocker.send({ type: "friend-block", uid: pest.uid });
  await blocker.expect("block applied", (m) => m.type === "blocks");
  await sleep(150);
  pest.send({ type: "call-ring", uid: blocker.uid, chanId: "c2" });
  await blocker.silence("a blocked person cannot ring", (m) => m.type === "call-ring");
  await pest.silence("and is not told so", (m) => m.type === "hub-error");
  ok("gate: blocking stops the ring, and says nothing back — a block that announces itself isn't one");

  for (const c of [stranger, victim, pest, blocker]) c.ws.close();
}

/* ========== 4. groups reach every member except the caller =============== */

{
  const host = await account("Host");
  const one = await account("Mem1");
  const two = await account("Mem2");
  const outsider = await account("Outsider");
  await befriend(host, one);
  await befriend(host, two);

  host.send({ type: "gdm-create", uids: [one.uid, two.uid], name: "Trio", icon: "👥" });
  const created = await host.expect("group created", (m) => m.type === "gdm-added");
  const gid = created.group.id;
  await one.expect("member 1 sees the group", (m) => m.type === "gdm-added" && m.group.id === gid);
  await two.expect("member 2 sees the group", (m) => m.type === "gdm-added" && m.group.id === gid);

  host.send({ type: "call-ring", gdm: gid, chanId: "c2" });
  const r1 = await one.expect("member 1 rings", (m) => m.type === "call-ring" && m.gdm === gid);
  const r2 = await two.expect("member 2 rings", (m) => m.type === "call-ring" && m.gdm === gid);
  if (r1.uid !== host.uid || r2.uid !== host.uid) fail("a group ring names the caller", JSON.stringify([r1, r2]));
  if (r1.name !== "Host") fail("a group ring carries the caller's name", JSON.stringify(r1));
  await host.silence("the caller is not rung by their own call", (m) => m.type === "call-ring");
  ok("group: a ring reaches every other member, names the caller, and never comes back at the caller");

  // Membership is the permission, so a non-member holding the id is nobody.
  outsider.send({ type: "call-ring", gdm: gid, chanId: "c2" });
  await one.silence("a non-member cannot ring a group", (m) => m.type === "call-ring");
  ok("group: knowing a group id is not being in it, and cannot ring its members");

  host.send({ type: "call-end", gdm: gid });
  const e1 = await one.expect("member 1 hears the hang-up", (m) => m.type === "call-end" && m.gdm === gid);
  if (e1.uid) fail("a group call-end names the group, not a person", JSON.stringify(e1));
  await two.expect("member 2 hears the hang-up", (m) => m.type === "call-end" && m.gdm === gid);
  ok("group: call-end fans out the same way, so a group ring is retractable too");

  for (const c of [host, one, two, outsider]) c.ws.close();
}

/* ========== 5. an offline recipient is a silent no-op ==================== */

{
  const caller = await account("Cal3");
  const away = await account("Away");
  await befriend(caller, away);
  away.ws.close();
  await sleep(300);

  // No error, no queue, no retry. The caller's own realm is what tells them
  // whether anybody turned up.
  caller.send({ type: "call-ring", uid: away.uid, chanId: "c2" });
  await caller.silence("ringing the absent is quiet", (m) => m.type === "hub-error");
  await sleep(200);

  const back = await account("Away", { uid: away.uid, token: away.token });
  await back.silence("nothing was held for them", (m) => m.type === "call-ring");
  if (Object.keys(back.welcome.dmUnread || {}).length) {
    fail("an unheard ring stores nothing", JSON.stringify(back.welcome.dmUnread));
  }
  ok("offline: ringing someone who isn't connected does nothing at all, and nothing waits for them");

  for (const c of [caller, back]) c.ws.close();
}

/* ========== 6. the ring budget bites, and the retraction still gets out === */

{
  const pest = await account("Pest2");
  const target = await account("Tess3");
  await befriend(pest, target);

  // RINGS_PER_WINDOW is 6 a minute, keyed on the account. Twelve attempts is a
  // person leaning on the call button; six of them are allowed to land.
  const ATTEMPTS = 12;
  for (let i = 0; i < ATTEMPTS; i++) {
    pest.send({ type: "call-ring", uid: target.uid, chanId: "c2" });
    await sleep(40);
  }
  await sleep(600);
  const landed = target.drain(isRing(pest.uid));
  if (landed >= ATTEMPTS) fail("the ring budget bites", `${landed} of ${ATTEMPTS} rings landed`);
  if (landed === 0) fail("the ring budget is not a wall", "no rings landed at all");
  ok(`limit: ${landed} of ${ATTEMPTS} rings landed — leaning on the call button is bounded, not free`);

  // The one frame that must never be rationed. A budget that swallows the
  // retraction is how you build a ring nobody can take back down.
  pest.send({ type: "call-end", uid: target.uid });
  await target.expect("call-end is never rate limited", isEnd(pest.uid));
  ok("limit: call-end is exempt from the budget, so a spent caller can still clear the ring they raised");

  // A second account is untouched by the first one's spending — the budget is
  // per caller, not a global ceiling on how often anybody may be called.
  const other = await account("Cal4");
  await befriend(other, target);
  other.send({ type: "call-ring", uid: target.uid, chanId: "c2" });
  await target.expect("a different caller still gets through", isRing(other.uid));
  ok("limit: the budget is per caller, so one pest cannot make you unreachable to everyone else");

  for (const c of [pest, target, other]) c.ws.close();
}

/* ========== 7. an old client is unaffected =============================== */

{
  const a = await account("Old1");
  const b = await account("Old2");
  await befriend(a, b);

  // Nothing about the existing ops changed shape. A client that never sends a
  // call frame and never understands one has to keep working exactly as it did.
  a.send({ type: "dm-nudge", uid: b.uid, preview: "hello?" });
  const nudge = await b.expect("dm-nudge still works", (m) => m.type === "dm-nudge" && m.uid === a.uid);
  if (nudge.count !== 1) fail("dm-nudge still counts", JSON.stringify(nudge));
  a.send({ type: "poke", uid: b.uid });
  await b.expect("poke still works", (m) => m.type === "poked" && m.uid === a.uid);
  await a.expect("poke still acks", (m) => m.type === "poke-sent");
  ok("compat: dm-nudge and poke are untouched — an old client never sees a call frame and never needs to");

  for (const c of [a, b]) c.ws.close();
}

clearTimeout(watchdog);
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
