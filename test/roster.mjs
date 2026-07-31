// Concord roster (persistent membership) protocol tests.
// Usage: node test/roster.mjs [baseUrl]   (default http://127.0.0.1:4189)
// Covers CONTRACTS.md §2: roster rows outlive sockets, welcome carries
// roster+owner, profile edits and departures broadcast, owner-only
// moderation (kick/ban/unban/bans) is enforced server-side, and ownership
// succession when the owner leaves.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const rand = (n) => Array.from({ length: n }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
const code = "RO" + rand(6);

let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

function connect(serverCode, params) {
  const ws = new WebSocket(`${wsBase}/ws?server=${serverCode}${params}`);
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

console.log(`Concord roster test → ${base}  (server code ${code})`);

// --- setup: Alice creates the server (becomes owner), Bob joins ------------------
const A = connect(code, `&create=1&name=RosterTest`);
await A.open();
A.send({ type: "hello", userId: "user-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA = await A.expect("Alice welcome", (m) => m.type === "welcome");
if (welcomeA.owner !== "user-alice") fail("first hello becomes owner", JSON.stringify(welcomeA.owner));
if (!welcomeA.roster.some((r) => r.userId === "user-alice")) fail("Alice in her own roster", JSON.stringify(welcomeA.roster));
ok("welcome: owner is the first userId to ever say hello, roster carries them");

const B = connect(code, "");
await B.open();
B.send({ type: "hello", userId: "user-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
const welcomeB = await B.expect("Bob welcome", (m) => m.type === "welcome");
if (!welcomeB.roster.some((r) => r.userId === "user-alice")) fail("Bob sees Alice in roster", JSON.stringify(welcomeB.roster));
await A.expect("Alice sees Bob's roster entry", (m) => m.type === "roster" && m.entry.userId === "user-bob");
await A.expect("Alice sees Bob join (member-join)", (m) => m.type === "member-join" && m.member.name === "Bob");
ok("welcome.roster lists every member, roster broadcast on join");

// --- 1. a member stays in the roster after their socket closes -------------------
B.ws.close();
await A.expect("Alice sees Bob leave (member-leave)", (m) => m.type === "member-leave");
const C = connect(code, "");
await C.open();
C.send({ type: "hello", userId: "user-carol", name: "Carol", color: "#3355ff", avatar: "🐱" });
const welcomeC = await C.expect("Carol welcome", (m) => m.type === "welcome");
const bobRow = welcomeC.roster.find((r) => r.userId === "user-bob");
if (!bobRow) fail("Bob's roster row must survive his disconnect", JSON.stringify(welcomeC.roster));
ok("roster: a member's row survives their socket closing");

// --- 2. profile edits update the roster + broadcast {type:"roster", entry} -------
A.send({ type: "set-profile", name: "Alice II", status: "renamed" });
const rosterEdit = await C.expect("Carol sees Alice's roster update", (m) => m.type === "roster" && m.entry.userId === "user-alice");
if (rosterEdit.entry.name !== "Alice II" || rosterEdit.entry.status !== "renamed")
  fail("roster broadcast reflects the edit", JSON.stringify(rosterEdit.entry));
const D = connect(code, "");
await D.open();
D.send({ type: "hello", userId: "user-dave", name: "Dave", color: "#22aa22", avatar: "🐶" });
const welcomeD = await D.expect("Dave welcome", (m) => m.type === "welcome");
const aliceRowPersisted = welcomeD.roster.find((r) => r.userId === "user-alice");
if (aliceRowPersisted?.name !== "Alice II") fail("profile edit persisted in roster storage", JSON.stringify(aliceRowPersisted));
ok("roster: set-profile updates the stored entry and broadcasts {type:\"roster\", entry}");

// --- 3. two sockets sharing one userId produce exactly one roster entry -----------
const A2 = connect(code, "");
await A2.open();
A2.send({ type: "hello", userId: "user-alice", token: welcomeA.token, name: "Alice II", color: "#ff5555", avatar: "🦊" });
await A2.expect("Alice's second tab welcome", (m) => m.type === "welcome");
const E = connect(code, "");
await E.open();
E.send({ type: "hello", userId: "user-eve", name: "Eve", color: "#aa22aa", avatar: "🦉" });
const welcomeE = await E.expect("Eve welcome", (m) => m.type === "welcome");
const aliceRows = welcomeE.roster.filter((r) => r.userId === "user-alice");
if (aliceRows.length !== 1) fail("one roster row per userId, not per socket", JSON.stringify(aliceRows));
ok("roster: two sockets sharing one userId still produce exactly one roster entry");
A2.ws.close();

// --- 4. leave-server removes you and broadcasts roster-remove ---------------------
C.send({ type: "leave-server" });
await D.expect("Dave sees Carol's roster-remove", (m) => m.type === "roster-remove" && m.userId === "user-carol");
const F = connect(code, "");
await F.open();
F.send({ type: "hello", userId: "user-frank", name: "Frank", color: "#556677", avatar: "🐧" });
const welcomeF = await F.expect("Frank welcome", (m) => m.type === "welcome");
if (welcomeF.roster.some((r) => r.userId === "user-carol")) fail("Carol should be gone after leave-server", JSON.stringify(welcomeF.roster));
ok("roster: leave-server deletes the roster row and broadcasts roster-remove");
C.ws.close();

// --- 5. welcome.owner survives the owner disconnecting (no ownership change) ------
A.ws.close(); // Alice's original socket drops, but she never left-server/kicked/banned
const G = connect(code, "");
await G.open();
G.send({ type: "hello", userId: "user-george", name: "George", color: "#998877", avatar: "🐢" });
const welcomeG = await G.expect("George welcome", (m) => m.type === "welcome");
if (welcomeG.owner !== "user-alice") fail("owner must survive a mere disconnect (not a departure)", welcomeG.owner);
ok("roster: welcome.owner survives the owner simply disconnecting");

// Reconnect Alice as herself (owner) for the moderation checks below.
const A3 = connect(code, "");
await A3.open();
A3.send({ type: "hello", userId: "user-alice", token: welcomeA.token, name: "Alice II", color: "#ff5555", avatar: "🦊" });
await A3.expect("Alice reconnect welcome", (m) => m.type === "welcome");

// --- 6. owner-only enforcement: a non-owner's kick/ban/unban/bans do nothing ------
D.send({ type: "kick", userId: "user-frank" });
await F.expectSilence("kick from non-owner must be a no-op", (m) => m.type === "roster-remove" && m.userId === "user-frank");
D.send({ type: "ban", userId: "user-frank" });
await F.expectSilence("ban from non-owner must be a no-op", (m) => m.type === "roster-remove" && m.userId === "user-frank");
D.send({ type: "bans" });
await D.expectSilence("bans query from non-owner gets no reply", (m) => m.type === "bans");
D.send({ type: "unban", userId: "user-frank" });
await D.expectSilence("unban from non-owner gets no reply", (m) => m.type === "bans");
ok("roster: kick/ban/unban/bans from a non-owner are all silently ignored");

// --- 7. owner kick removes the target's roster row and broadcasts roster-remove ----
A3.send({ type: "kick", userId: "user-dave" });
await E.expect("Eve sees Dave's roster-remove after owner kick", (m) => m.type === "roster-remove" && m.userId === "user-dave");
const H = connect(code, "");
await H.open();
H.send({ type: "hello", userId: "user-hank", name: "Hank", color: "#334455", avatar: "🐸" });
const welcomeH = await H.expect("Hank welcome", (m) => m.type === "welcome");
if (welcomeH.roster.some((r) => r.userId === "user-dave")) fail("Dave should be gone after owner kick", JSON.stringify(welcomeH.roster));
ok("roster: owner kick deletes the target's roster row and broadcasts roster-remove");

// --- 8. ban refuses the next hello with {type:"banned"} and closes; unban restores -
A3.send({ type: "ban", userId: "user-frank" });
await E.expect("Eve sees Frank's roster-remove after ban", (m) => m.type === "roster-remove" && m.userId === "user-frank");
const FBanned = connect(code, "");
await FBanned.open();
// Must present Frank's real auth token to reclaim "user-frank" — without it
// the server hands out a fresh identity instead (see identity handling in
// the "hello" case), and the ban (keyed on userId) would never be hit.
FBanned.send({ type: "hello", userId: "user-frank", token: welcomeF.token, name: "Frank", color: "#556677", avatar: "🐧" });
const bannedMsg = await FBanned.expect("banned hello gets {type:\"banned\"}", (m) => m.type === "banned");
await new Promise((resolve) => FBanned.ws.on("close", resolve));
if (!bannedMsg) fail("banned() message must arrive before close");
ok("roster: a banned identity's next hello gets {type:\"banned\"} and the socket closes");

A3.send({ type: "unban", userId: "user-frank" });
await A3.expect("owner sees updated bans list after unban", (m) => m.type === "bans" && !m.list.some((b) => b.userId === "user-frank"));
const FUnbanned = connect(code, "");
await FUnbanned.open();
FUnbanned.send({ type: "hello", userId: "user-frank", token: welcomeF.token, name: "Frank", color: "#556677", avatar: "🐧" });
const welcomeFUnbanned = await FUnbanned.expect("Frank welcome after unban", (m) => m.type === "welcome" || m.type === "banned");
if (welcomeFUnbanned.type !== "welcome") fail("unban should let the identity back in", JSON.stringify(welcomeFUnbanned));
ok("roster: unban lets the identity back in");
FUnbanned.ws.close();

// --- 9. ownership succession when the owner leaves --------------------------------
// Isolated fresh server so joinedAt ordering isn't polluted by earlier kicks/bans.
const codeSucc = "RS" + rand(6);
const S1 = connect(codeSucc, `&create=1&name=SuccessionTest`);
await S1.open();
S1.send({ type: "hello", userId: "user-succ1", name: "Succ1", color: "#111111", avatar: "1️⃣" });
const welcomeS1 = await S1.expect("Succ1 welcome", (m) => m.type === "welcome");
if (welcomeS1.owner !== "user-succ1") fail("Succ1 should be owner of the fresh succession server", welcomeS1.owner);

const S2 = connect(codeSucc, "");
await S2.open();
S2.send({ type: "hello", userId: "user-succ2", name: "Succ2", color: "#222222", avatar: "2️⃣" });
await S2.expect("Succ2 welcome", (m) => m.type === "welcome");
await S1.expect("Succ1 sees Succ2 join", (m) => m.type === "member-join");

S1.send({ type: "leave-server" });
const metaAfterLeave = await S2.expect(
  "server-meta broadcasts new owner after the owner leaves",
  (m) => m.type === "server-meta"
);
if (metaAfterLeave.meta.owner !== "user-succ2")
  fail("ownership should pass to the oldest remaining joinedAt row", JSON.stringify(metaAfterLeave.meta));
const S3 = connect(codeSucc, "");
await S3.open();
S3.send({ type: "hello", userId: "user-succ3", name: "Succ3", color: "#333333", avatar: "3️⃣" });
const welcomeS3 = await S3.expect("Succ3 welcome", (m) => m.type === "welcome");
if (welcomeS3.owner !== "user-succ2") fail("welcome must reflect the succeeded owner", welcomeS3.owner);
ok("roster: ownership passes to the oldest remaining joinedAt row when the owner leaves");
S1.ws.close();
S2.ws.close();
S3.ws.close();

A3.ws.close();
D.ws.close();
E.ws.close();
G.ws.close();
H.ws.close();
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
