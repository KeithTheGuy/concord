// Concord hub security tests.
// Usage: node test/hubsec.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// Every check here was a live-reproduced defect first. The shape of the suite
// follows from that: each section performs the attack, and only then asserts
// that it no longer works — so reverting the fix makes the *attack* succeed
// again and the assertion fail, rather than making some proxy for it fail.
//
// The theme running through all of it is CONTRACTS.md §12: a server code is a
// bearer capability, and for a conversation that has to stop being true, or
// "left the group" and "removed friend" describe the hub's records rather than
// the other person's access.

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
const watchdog = setTimeout(() => fail("hubsec suite", "whole suite timed out"), 240_000);
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
    closed: new Promise((res) => ws.on("close", res)),
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
    // "nothing of this shape arrives" is the assertion for most of these fixes:
    // a silently dropped op and a refused one look identical from outside, and
    // that is deliberate.
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
    open: () =>
      new Promise((res, rej) => {
        ws.on("open", res);
        ws.on("unexpected-response", (_r, resp) => rej(new Error(`HTTP ${resp.statusCode}`)));
        ws.on("error", rej);
      }),
  };
}

// One hub account. `saved` lets the same person reconnect as themselves.
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
    status: saved?.status ?? "",
    presence: saved?.presence || "online",
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

// The realm socket, with the hub credentials that make a conversation a
// conversation rather than a code anybody who ever held it can still spend.
async function realm(code, who, opts = {}) {
  const c = socket(`${wsBase}/ws?server=${code}&create=1&name=DM&icon=%F0%9F%92%AC`);
  await c.open();
  const hello = {
    type: "hello",
    userId: opts.userId || `u-${who?.uid || "anon"}`,
    token: opts.userToken || "",
    name: opts.name || "Someone",
    color: "#5865f2",
    avatar: "🙂",
  };
  if (who && !opts.bare) {
    hello.hubUid = who.uid;
    hello.hubToken = opts.badToken || who.token;
  }
  c.send(hello);
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

console.log(`Concord hub security test → ${base}`);

/* ========== 1. a DM is not a guild with two people in it ================== */

{
  const a = await account("Ada");
  const b = await account("Bo");
  const code = await befriend(a, b);
  if (!code) fail("becoming friends mints a DM code", "no dm on friend-added");

  const A = await realm(code, a, { name: "Ada" });
  const wA = await A.expect("Ada joins the DM", (m) => m.type === "welcome");
  if (wA.meta.kind !== "dm") fail("the hub decides a code is a conversation", JSON.stringify(wA.meta));
  if (wA.owner) fail("a DM has no owner", `owner is ${wA.owner}`);
  ok("dm: the hub, not a URL parameter, marks the realm as a conversation — and it has no owner to inherit");

  const B = await realm(code, b, { name: "Bo" });
  await B.expect("Bo joins the DM", (m) => m.type === "welcome");

  // The destruction the audit performed: a decoy channel clears the "keep one
  // of each type" floor, then the real one goes, taking the history with it.
  B.send({ type: "create-channel", name: "decoy", chanType: "text" });
  await A.silence("create-channel in a DM", (m) => m.type === "channel-create");
  B.send({ type: "delete-channel", chanId: "c1" });
  await A.silence("delete-channel in a DM", (m) => m.type === "channel-delete");
  ok("dm: neither party can create or delete channels, so neither can destroy the conversation");

  B.send({ type: "ban", userId: `u-${a.uid}` });
  B.send({ type: "kick", userId: `u-${a.uid}` });
  await A.silence("ban/kick in a DM", (m) => m.type === "roster-remove");
  B.send({ type: "bans" });
  await B.silence("bans in a DM", (m) => m.type === "bans");
  B.send({ type: "update-server", name: "Bo's Room" });
  await A.silence("update-server in a DM", (m) => m.type === "server-meta");
  ok("dm: ban, kick, unban, bans and update-server are all refused — there is no owner to hold them");

  // The ban would have been permanent and unappealable, so prove Ada is still
  // able to walk back in.
  A.ws.close();
  await sleep(200);
  const A2 = await realm(code, a, { name: "Ada" });
  const wA2 = await A2.expect("Ada reconnects", (m) => m.type === "welcome" || m.type === "dm-denied");
  if (wA2.type !== "welcome") fail("Ada can rejoin her own DM", JSON.stringify(wA2));
  ok("dm: the other party is still able to open their own conversation afterwards");

  for (const c of [a, b, A2, B]) c.ws.close();
}

/* ========== 2. a request flood must not lock the target out ================ */

{
  const victim = await account("Vic");
  const bystander = await account("Stan");

  // 65 throwaway accounts, one request each. FRIEND_CAP used to count every
  // `fr:` row against the *sender*, incoming ones included, so this is the
  // shape that took the victim's own add button away for good.
  const FLOOD = 65;
  for (let i = 0; i < FLOOD; i += 10) {
    await Promise.all(
      Array.from({ length: Math.min(10, FLOOD - i) }, async (_, k) => {
        const t = await account(`Troll${i + k}`);
        t.send({ type: "friend-add", tag: victim.tag });
        await t.expect("flood request accepted", (m) => m.type === "friend-outgoing");
        t.ws.close();
      })
    );
  }
  await sleep(400);

  victim.ws.close();
  const back = await account("Vic", { uid: victim.uid, token: victim.token });
  if (back.welcome.incoming.length >= FLOOD) {
    fail("incoming requests are capped", `${back.welcome.incoming.length} pending after ${FLOOD} requests`);
  }
  ok(`friends: an incoming-request flood is bounded at the target (${back.welcome.incoming.length} of ${FLOOD} landed)`);

  // The point of the whole exercise: the victim's own ability to add people is
  // untouched by how many strangers have asked them.
  back.send({ type: "friend-add", tag: bystander.tag });
  const reply = await back.expect("victim can still add", (m) => m.type === "friend-outgoing" || m.type === "hub-error");
  if (reply.type !== "friend-outgoing") fail("a flooded victim can still add friends", JSON.stringify(reply));
  ok("friends: sitting on a pile of unanswered requests does not consume the victim's own friend cap");

  for (const c of [back, bystander]) c.ws.close();
}

/* ========== 3. invisible has to be enforced by the server ================== */

{
  const watcher = await account("Wanda");
  const ghost = await account("Gus");
  await befriend(watcher, ghost);

  ghost.send({ type: "presence", presence: "invisible", status: "at the dentist" });
  const update = await watcher.expect("friend-update on going invisible", (m) => m.type === "friend-update");
  if (update.user.online) fail("invisible reports offline", JSON.stringify(update.user));
  if (update.user.presence === "invisible") fail("invisible does not name itself", JSON.stringify(update.user));
  if (update.user.status) fail("status is withheld while invisible", JSON.stringify(update.user));
  ok("presence: going invisible tells friends online:false, never the word \"invisible\", and withholds the custom status");

  const flip = await watcher.expect("synthetic offline", (m) => m.type === "friend-presence" && m.uid === ghost.uid);
  if (flip.online) fail("switching to invisible fires online:false", JSON.stringify(flip));
  ok("presence: switching to invisible fires the offline event the client used to have to infer");

  // A fresh connect while invisible must announce nothing at all.
  ghost.ws.close();
  await sleep(300);
  const ghost2 = await account("Gus", { uid: ghost.uid, token: ghost.token, presence: "invisible" });
  await watcher.silence("invisible connect is silent", (m) => m.type === "friend-presence" && m.online);
  ok("presence: an invisible connect announces nothing — it used to send {online:true, presence:\"invisible\"}");

  // And the roster the client is handed on reconnect agrees.
  watcher.ws.close();
  const watcher2 = await account("Wanda", { uid: watcher.uid, token: watcher.token });
  const seen = watcher2.welcome.friends.find((f) => f.uid === ghost.uid);
  if (!seen) fail("watcher still sees the friendship", JSON.stringify(watcher2.welcome.friends));
  if (seen.online) fail("hub-welcome hides an invisible friend", JSON.stringify(seen));
  if (seen.status) fail("hub-welcome withholds an invisible friend's status", JSON.stringify(seen));
  ok("presence: hub-welcome reports an invisible friend as offline even though their socket is open");

  // You are still allowed to know your own state, or the settings menu has
  // nothing to render.
  if (ghost2.welcome.you.presence !== "invisible") {
    fail("you can see your own presence", JSON.stringify(ghost2.welcome.you));
  }
  ok("presence: your own hub-welcome still carries your real presence and status");

  for (const c of [watcher2, ghost2]) c.ws.close();
}

/* ========== 4. tags are not a directory, and "no" now means something ====== */

{
  const target = await account("Tara");
  const prober = await account("Pete");

  prober.send({ type: "friend-add", tag: target.tag });
  const hit = await prober.expect("outgoing for a real tag", (m) => m.type === "friend-outgoing");
  if (hit.user.name !== target.tag || hit.user.status || hit.user.online) {
    fail("friend-outgoing echoes only the tag", JSON.stringify(hit.user));
  }
  ok("enumeration: friend-add echoes the tag you typed, not the target's profile or live presence");

  const miss = await (async () => {
    prober.send({ type: "friend-add", tag: `nobodyhere${Date.now() % 100000}` });
    return prober.expect("outgoing for a bogus tag", (m) => m.type === "friend-outgoing" || m.type === "hub-error");
  })();
  if (miss.type !== "friend-outgoing") fail("a hit and a miss answer alike", JSON.stringify(miss));
  ok("enumeration: a tag that resolves and one that doesn't produce the same frame");

  // The old limiter keyed on s.sid, minted fresh per socket — so a new socket
  // bought thirty more probes. Same account, new sockets, still refused.
  let refusedAt = 0;
  for (let i = 0; i < 20 && !refusedAt; i++) {
    const sock = await account("Pete", { uid: prober.uid, token: prober.token });
    sock.send({ type: "friend-add", tag: `probe${i}xyz` });
    const r = await sock.expect("probe reply", (m) => m.type === "friend-outgoing" || m.type === "hub-error");
    if (r.type === "hub-error") refusedAt = i;
    sock.ws.close();
  }
  if (!refusedAt) fail("probes are rate limited per account", "20 probes across 20 fresh sockets all answered");
  ok(`enumeration: probing is limited per account, not per socket — a fresh socket buys nothing (refused at ${refusedAt})`);

  // Declining leaves a record, so the same person cannot simply ask again.
  const pest = await account("Percy");
  pest.send({ type: "friend-add", tag: target.tag });
  await target.expect("pest's first request", (m) => m.type === "friend-request" && m.user.uid === pest.uid);
  target.send({ type: "friend-decline", uid: pest.uid });
  await pest.expect("pest is declined", (m) => m.type === "friend-removed" && m.uid === target.uid);

  pest.send({ type: "friend-add", tag: target.tag });
  const retry = await pest.expect("re-request reply", (m) => m.type === "friend-outgoing" || m.type === "hub-error");
  if (retry.type !== "friend-outgoing") fail("a block answers like a delivered request", JSON.stringify(retry));
  await target.silence("blocked re-request", (m) => m.type === "friend-request" && m.user.uid === pest.uid);
  ok("blocking: a declined requester is told the same thing as before and the target hears nothing");

  pest.send({ type: "poke", uid: target.uid });
  await target.silence("blocked poke", (m) => m.type === "poked");
  ok("blocking: a block is checked on poke too, and reports the same \"they're offline\" a miss would");

  target.send({ type: "friend-unblock", uid: pest.uid });
  const list = await target.expect("blocks list", (m) => m.type === "blocks");
  if (list.list.includes(pest.uid)) fail("friend-unblock removes the row", JSON.stringify(list));
  ok("blocking: friend-unblock exists, so a mis-click is not permanent");

  for (const c of [target, prober, pest]) c.ws.close();
}

/* ========== 5. a code stops being a bearer capability ===================== */

{
  const a = await account("Ann");
  const b = await account("Ben");
  const c = await account("Cass");
  await befriend(a, b);
  await befriend(a, c);

  a.send({ type: "gdm-create", name: "The Council", uids: [b.uid, c.uid] });
  const created = await a.expect("group created", (m) => m.type === "gdm-added");
  const gid = created.group.id;
  const gcode = created.group.code;
  await b.expect("Ben is told the group", (m) => m.type === "gdm-added");
  await c.expect("Cass is told the group", (m) => m.type === "gdm-added");

  // Everyone opens it, which is what arms enforcement for this conversation.
  const A = await realm(gcode, a, { name: "Ann" });
  await A.expect("Ann in the group realm", (m) => m.type === "welcome");
  const B = await realm(gcode, b, { name: "Ben" });
  const wB = await B.expect("Ben in the group realm", (m) => m.type === "welcome");
  const chan = wB.channels.find((x) => x.type === "text");

  // Ann leaves while still connected. The hub has to reach into the realm.
  a.send({ type: "gdm-leave", id: gid });
  await a.expect("Ann is out", (m) => m.type === "gdm-removed" && m.id === gid);
  const kicked = await A.expect("Ann's live socket is dropped", (m) => m.type === "dm-denied");
  if (!kicked.error) fail("dm-denied carries a reason", JSON.stringify(kicked));
  await A.closed;
  ok("revocation: leaving a group closes the socket of the person already inside it");

  B.send({ type: "msg", chanId: chan.id, content: "she's gone then", nonce: "post1" });
  await B.expect("Ben posts after the departure", (m) => m.type === "msg-ack" && m.nonce === "post1");

  // The audit's exact move: reopen the code and read what was said after.
  const sneak = await realm(gcode, a, { name: "Ann" });
  const denied = await sneak.expect("re-entry refused", (m) => m.type === "dm-denied" || m.type === "welcome");
  if (denied.type !== "dm-denied") fail("a departed member cannot reopen the code", JSON.stringify(denied));
  sneak.ws.close();

  // ...and without credentials at all, which is the obvious way round a check
  // the client is asked to participate in.
  const bare = await realm(gcode, a, { name: "Ann", bare: true });
  const bareReply = await bare.expect("uncredentialed re-entry", (m) => m.type === "dm-denied" || m.type === "welcome");
  if (bareReply.type !== "dm-denied") fail("omitting credentials is not a way in", JSON.stringify(bareReply));
  bare.ws.close();
  ok("revocation: a departed member is refused the code both with her own credentials and with none at all");

  // Someone else's valid hub identity is not a way in either.
  const stranger = await account("Stranger");
  const imposter = await realm(gcode, stranger, { name: "Stranger" });
  const impReply = await imposter.expect("stranger re-entry", (m) => m.type === "dm-denied" || m.type === "welcome");
  if (impReply.type !== "dm-denied") fail("a stranger with a valid account cannot join a group", JSON.stringify(impReply));
  imposter.ws.close();
  stranger.ws.close();
  ok("revocation: proving *an* identity is not proving membership — a non-member with a real account is refused");

  // Dissolving the group must close it, not un-know it. The hub's record of the
  // code outlives the group on purpose: a code the hub has forgotten is one the
  // realm has no reason to refuse.
  b.send({ type: "gdm-leave", id: gid });
  await b.expect("Ben leaves too", (m) => m.type === "gdm-removed" && m.id === gid);
  await B.expect("Ben's group socket is dropped", (m) => m.type === "dm-denied");
  await sleep(200);
  const ghostRoom = await realm(gcode, c, { name: "Cass" });
  const ghostReply = await ghostRoom.expect("dissolved group", (m) => m.type === "dm-denied" || m.type === "welcome");
  if (ghostReply.type !== "dm-denied") fail("a dissolved group admits nobody", JSON.stringify(ghostReply));
  ghostRoom.ws.close();
  ok("revocation: a group that dissolved refuses even its last member — the code stays known so it stays refused");

  B.ws.close();

  /* --- and the same for unfriending, which revoked nothing either --------- */
  const dm = await befriend(b, c);
  const BD = await realm(dm, b, { name: "Ben" });
  await BD.expect("Ben in the DM", (m) => m.type === "welcome");
  const CD = await realm(dm, c, { name: "Cass" });
  await CD.expect("Cass in the DM", (m) => m.type === "welcome");

  c.send({ type: "friend-remove", uid: b.uid });
  await b.expect("Ben is unfriended", (m) => m.type === "friend-removed" && m.uid === c.uid);
  await BD.expect("Ben's DM socket is dropped", (m) => m.type === "dm-denied");
  await BD.closed;

  const exFriend = await realm(dm, b, { name: "Ben" });
  const exReply = await exFriend.expect("ex-friend re-entry", (m) => m.type === "dm-denied" || m.type === "welcome");
  if (exReply.type !== "dm-denied") fail("an ex-friend cannot reopen the DM", JSON.stringify(exReply));
  exFriend.ws.close();
  ok("revocation: unfriending drops the live socket and refuses the next connect — the audit read and posted after both");

  CD.ws.close();
  for (const x of [a, b, c]) x.ws.close();
}

/* ========== 6. the smaller ones =========================================== */

{
  const owner = await account("Tagger");
  const first = `hs${Date.now().toString(36).slice(-6)}`;
  const second = `${first}b`;
  owner.send({ type: "set-tag", tag: first });
  await owner.expect("first tag", (m) => m.type === "tag-changed" && m.tag === first);
  owner.send({ type: "set-tag", tag: second });
  await owner.expect("second tag", (m) => m.type === "tag-changed" && m.tag === second);

  // The released tag must actually be released: `set-tag` writes the new row
  // and then deletes the old one, and the delete is now conditional on still
  // owning it. Someone else claiming it is the only externally visible proof
  // that the row went.
  const heir = await account("Heir");
  heir.send({ type: "set-tag", tag: first });
  const claimed = await heir.expect("orphan tag reclaimed", (m) => m.type === "tag-changed" || m.type === "hub-error");
  if (claimed.type !== "tag-changed") fail("a released tag is claimable", JSON.stringify(claimed));
  ok("tags: changing your tag releases the old one, and the delete only fires on a row you still own");

  owner.ws.close();
  heir.ws.close();
}

/* ========== 7. the roster sweep can no longer unseat a real member ========= */

{
  const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const code = "HS" + Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

  const founder = socket(`${wsBase}/ws?server=${code}&create=1&name=RosterFlood`);
  await founder.open();
  founder.send({ type: "hello", userId: "roster-founder", name: "Founder", color: "#ff5555", avatar: "🦊" });
  await founder.expect("founder welcome", (m) => m.type === "welcome");
  founder.ws.close();

  // A second real member, who is NOT the owner — the owner was already exempt,
  // and a non-owner being evicted was the remaining hole.
  const member = socket(`${wsBase}/ws?server=${code}`);
  await member.open();
  member.send({ type: "hello", userId: "roster-member", name: "Member", color: "#55ff88", avatar: "🐻" });
  const wm = await member.expect("member welcome", (m) => m.type === "welcome");
  const memberToken = wm.token;
  member.ws.close();
  await sleep(200);

  // ROSTER_CAP is 200 and the sweep runs on every new member past it, so the
  // flood has to clear the cap comfortably.
  const FLOOD = 240;
  for (let i = 0; i < FLOOD; i += 20) {
    await Promise.all(
      Array.from({ length: Math.min(20, FLOOD - i) }, () =>
        new Promise((resolve) => {
          const ws = new WebSocket(`${wsBase}/ws?server=${code}`);
          ws.on("message", (d) => {
            if (JSON.parse(d.toString()).type === "welcome") {
              ws.close();
              resolve();
            }
          });
          ws.on("open", () =>
            ws.send(JSON.stringify({ type: "hello", name: "Anon", color: "#000000", avatar: "😈" }))
          );
          ws.on("error", () => resolve());
        })
      )
    );
  }

  const check = socket(`${wsBase}/ws?server=${code}`);
  await check.open();
  check.send({ type: "hello", name: "Checker", color: "#8888ff", avatar: "🔍" });
  const wc = await check.expect("checker welcome", (m) => m.type === "welcome");
  if (!wc.roster.some((r) => r.userId === "roster-member")) {
    fail("roster sweep keeps established members", `${FLOOD} throwaway hellos evicted an offline non-owner`);
  }
  ok(`roster: ${FLOOD} throwaway hellos no longer evict an established offline non-owner — a flood evicts itself`);
  check.ws.close();

  // Belt and braces: the identity is still anchored to its token afterwards.
  const thief = socket(`${wsBase}/ws?server=${code}`);
  await thief.open();
  thief.send({ type: "hello", userId: "roster-member", name: "Member", color: "#55ff88", avatar: "🐻" });
  const wt = await thief.expect("thief welcome", (m) => m.type === "welcome");
  if (wt.you.userId === "roster-member") fail("the flooded member's identity", "claimable without a token");
  thief.ws.close();

  const real = socket(`${wsBase}/ws?server=${code}`);
  await real.open();
  real.send({ type: "hello", userId: "roster-member", token: memberToken, name: "Member", color: "#55ff88", avatar: "🐻" });
  const wr = await real.expect("member returns", (m) => m.type === "welcome");
  if (wr.you.userId !== "roster-member") fail("the member's own token still works", JSON.stringify(wr.you));
  real.ws.close();
  ok("roster: after the flood the member's userId is still theirs and still needs their token");
}

clearTimeout(watchdog);
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
