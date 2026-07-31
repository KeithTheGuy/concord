// Concord GET /api/invite/<CODE> tests.
// Usage: node test/invite.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// /api/invite/<CODE> exists so an invite link can say "The Hangout" instead of
// the raw code before anyone has picked a name — see CONTRACTS.md §12 for why
// an 8-character guild code (≈38.6 bits) is not comfortable against a
// population of live servers, and why /ws?server=CODE turning that guess into
// a 404-vs-101 oracle is already accepted. This endpoint makes the same
// question reachable over a bare GET with no upgrade to complete, so every
// check here is a boundary it has to hold on its own: name a real server,
// 404 an unknown one, never name a DM, leak nothing past name/icon/owner,
// leave no storage behind either way, and not fall over when the rate
// limiter has no CF-Connecting-IP to key on — exactly the case under
// `wrangler dev`, which is what this suite runs against.

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

const watchdog = setTimeout(() => fail("invite suite", "whole suite timed out"), 60_000);
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
    open: () =>
      new Promise((res, rej) => {
        ws.on("open", res);
        ws.on("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
        ws.on("error", rej);
      }),
  };
}

// One hub account, just enough of it to mint a DM code with.
async function account(name) {
  const c = socket(`${wsBase}/ws?hub=1`);
  await c.open();
  c.send({ type: "hello", uid: "", token: "", name, avatar: "🙂", color: "#5865f2", status: "", presence: "online" });
  const welcome = await c.expect(`${name} hub-welcome`, (m) => m.type === "hub-welcome");
  c.uid = welcome.you.uid;
  c.token = welcome.token;
  c.tag = welcome.you.tag;
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

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const randomCode = () =>
  "IV" + Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

console.log(`Concord invite-peek test → ${base}`);

/* ===== 1. a real server's name comes back, a probe leaves nothing behind === */

{
  const code = randomCode();

  const miss = await fetch(`${base}/api/invite/${code}`);
  if (miss.status !== 404) fail("unknown code 404s", `got ${miss.status}`);
  ok("invite: an unknown code 404s");

  // If that probe had written anything, creating the server right after with
  // different values would either fail or come back with the probe's
  // leftovers instead of these — so the values landing exactly as sent is
  // proof the miss above left no storage behind.
  const founder = socket(
    `${wsBase}/ws?server=${code}&create=1&name=${encodeURIComponent("The Hangout")}&icon=%F0%9F%8E%AE`
  );
  await founder.open();
  founder.send({ type: "hello", name: "Keith", color: "#5865f2", avatar: "🙂" });
  const w = await founder.expect("founder welcome", (m) => m.type === "welcome");
  if (w.meta.name !== "The Hangout" || w.meta.icon !== "🎮") {
    fail("the probe left no meta behind", JSON.stringify(w.meta));
  }
  ok("invite: probing a code before it exists writes nothing — creating it right after gets the real values");

  const hit = await fetch(`${base}/api/invite/${code}`);
  if (hit.status !== 200) fail("a real server's name comes back", `got ${hit.status}`);
  const data = await hit.json();
  if (data.name !== "The Hangout" || data.icon !== "🎮") {
    fail("the response carries the server's real name and icon", JSON.stringify(data));
  }
  ok(`invite: a real server answers with its name and icon (${JSON.stringify(data)})`);

  const allowed = new Set(["name", "icon", "owner"]);
  const extra = Object.keys(data).filter((k) => !allowed.has(k));
  if (extra.length) fail("no extra fields leak", JSON.stringify(data));
  ok("invite: the response carries nothing beyond name, icon and (optionally) owner — no roster, no member count");

  // Keith's `hello` above wrote his roster row before the welcome was even
  // sent, so the owner's name is exactly the "cheaply available" case.
  if (data.owner !== "Keith") fail("the owner's name rides along when it's cheap", JSON.stringify(data));
  ok("invite: the owner's name is included because it cost nothing beyond a roster read");

  if (!/max-age=\d+/.test(hit.headers.get("cache-control") || "")) {
    fail("the response is cacheable", hit.headers.get("cache-control"));
  }
  ok("invite: a hit carries a Cache-Control that blunts repeat probing of the same code");

  // Repeated peeks after the server exists must not accumulate anything
  // either — same "leaves no trace" property, checked from the other side.
  for (let i = 0; i < 5; i++) await fetch(`${base}/api/invite/${code}`);
  const checker = socket(`${wsBase}/ws?server=${code}`);
  await checker.open();
  checker.send({ type: "hello", name: "Checker", color: "#5865f2", avatar: "🔍" });
  const wc = await checker.expect("checker welcome", (m) => m.type === "welcome");
  // Keith (the founder) plus the checker itself, from saying hello just now —
  // and nothing contributed by the five peeks in between.
  if (wc.roster.length !== 2) fail("repeated peeks leave the roster alone", `roster has ${wc.roster.length} entries`);
  ok("invite: five more peeks after the server exists add nothing to the roster beyond its real members");
  checker.ws.close();

  founder.ws.close();
}

/* ========== 2. a malformed code is refused the same way an unknown one is == */

{
  const tooShort = await fetch(`${base}/api/invite/AB`);
  if (tooShort.status !== 404) fail("a too-short code 404s", `got ${tooShort.status}`);
  const badChars = await fetch(`${base}/api/invite/bad!code`);
  if (badChars.status !== 404) fail("a code with bad characters 404s", `got ${badChars.status}`);
  ok("invite: a malformed code 404s exactly like an unknown one, not a 400 that would confirm the shape check ran");
}

/* ================= 3. a DM code is not exposed — it's a conversation ====== */

{
  const a = await account("Ada");
  const b = await account("Bo");
  const code = await befriend(a, b);
  if (!code) fail("becoming friends mints a DM code", "no dm on friend-added");

  // `meta.kind` is settled the moment the realm is first opened — the hub's
  // dmcode: row decides it via hubOwnsCode, not a URL parameter — so open it
  // for real rather than asserting anything about the code in isolation.
  const dm = socket(`${wsBase}/ws?server=${code}&create=1&name=DM&icon=%F0%9F%92%AC`);
  await dm.open();
  dm.send({
    type: "hello",
    userId: `u-${a.uid}`,
    name: "Ada",
    color: "#5865f2",
    avatar: "🙂",
    hubUid: a.uid,
    hubToken: a.token,
  });
  const w = await dm.expect("dm welcome", (m) => m.type === "welcome" || m.type === "dm-denied");
  if (w.type !== "welcome" || w.meta.kind !== "dm") fail("the dm realm actually opened", JSON.stringify(w));

  const peek = await fetch(`${base}/api/invite/${code}`);
  if (peek.status !== 404) fail("a DM code is not exposed", `got ${peek.status}: ${await peek.text()}`);
  ok("invite: a DM code answers exactly like an unknown one — a conversation is not something a link 'joins'");

  dm.ws.close();
  for (const c of [a, b]) c.ws.close();
}

/* ===== 4. no CF-Connecting-IP (as under wrangler dev) degrades to no limit = */

{
  const code = randomCode();
  const results = await Promise.all(Array.from({ length: 30 }, () => fetch(`${base}/api/invite/${code}`)));
  const bad = results.filter((r) => r.status !== 404);
  if (bad.length) fail("a burst degrades to no limit without CF-Connecting-IP", `${bad.length} non-404 responses`);
  ok("invite: without CF-Connecting-IP the rate limiter degrades to no limit rather than 429ing real traffic or crashing");
}

clearTimeout(watchdog);
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
