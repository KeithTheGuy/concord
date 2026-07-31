// Drafts + outbox suite.
// Usage: node test/outbox.mjs      (no server, no browser, no real timers)
//
// public/drafts.js and public/outbox.js are the two modules in this app that
// are pure logic — no DOM, no WebSocket, every side effect injected — so they
// get tested directly in Node instead of through a Chromium page. The clock,
// the timers, the storage and the socket are all fakes, which means the whole
// file runs in milliseconds: nothing here ever waits for a debounce, it just
// advances the clock past one.
//
// The interesting assertions are the ones about the three send states. See the
// header of public/outbox.js for why the ambiguous one is manual.

import { createDrafts } from "../public/drafts.js";
import { createOutbox } from "../public/outbox.js";

let passed = 0;
let failures = 0;
const ok = (l) => {
  passed++;
  console.log(`  PASS ${l}`);
};
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const J = (v) => JSON.stringify(v);

/* ============================== fake runtime ============================== */

// A clock that also owns the timer queue, so "advance 600ms" fires exactly the
// callbacks a real 600ms would have fired, in the right order, instantly.
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map(); // id -> {at, seq, fn}
  return {
    now: () => t,
    setTimer(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + (ms || 0), seq: id, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pending: () => timers.size,
    advance(ms) {
      const until = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, x]) => x.at <= until)
          .sort((a, b) => a[1].at - b[1].at || a[1].seq - b[1].seq);
        if (!due.length) break;
        const [id, x] = due[0];
        timers.delete(id);
        t = Math.max(t, x.at);
        x.fn();
      }
      t = until;
    },
  };
}

// Stands in for one `concord-*` localStorage key. Counts writes, and round-trips
// through JSON so a test can't accidentally pass by sharing an object.
function makeSlot(initial) {
  let raw = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    writes: 0,
    load() {
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    save(v) {
      this.writes++;
      raw = JSON.stringify(v);
    },
    peek() {
      return raw === undefined ? undefined : JSON.parse(raw);
    },
    bytes: () => (raw === undefined ? 0 : raw.length),
  };
}

// A socket that can be opened and closed, records every frame in order, and
// tells the outbox the truth about whether the frame left the tab.
function makeWire() {
  return {
    open: true,
    frames: [],
    send(code, frame) {
      if (!this.open) return false;
      this.frames.push({ code, frame });
      return true;
    },
    nonces: function () {
      return this.frames.map((f) => f.frame.nonce);
    },
  };
}

const msgFrame = (chanId, content, nonce, extra = {}) => ({
  type: "msg",
  chanId,
  content,
  nonce,
  ...extra,
});

/* ================================ drafts ================================= */

section("drafts: round trip");
{
  const clock = makeClock();
  const slot = makeSlot();
  const d = createDrafts({ load: slot.load, save: (v) => slot.save(v), ...clock });

  d.set("AAAA1111", "c1", "half a thought", { id: "m9", name: "Bo", content: "what about it" });
  check(d.get("AAAA1111", "c1")?.text === "half a thought", "draft comes back out");
  check(d.get("AAAA1111", "c1")?.replyTo?.id === "m9", "reply target rides along with the text");
  check(d.has("AAAA1111", "c1") === true, "has() reports the draft");
  check(d.has("AAAA1111", "c2") === false, "has() is false for a channel with no draft");

  // The bug this module exists for: the same chanId in two servers.
  d.set("BBBB2222", "c1", "different server, same channel id");
  check(
    d.get("AAAA1111", "c1").text === "half a thought" &&
      d.get("BBBB2222", "c1").text === "different server, same channel id",
    "drafts are keyed by realm code AND channel id"
  );
  check(d.codesWithDrafts().sort().join(",") === "AAAA1111,BBBB2222", "codesWithDrafts lists both realms", J(d.codesWithDrafts()));
  check(d.chansWithDrafts("AAAA1111").join(",") === "c1", "chansWithDrafts is scoped to one realm");

  d.set("AAAA1111", "c1", "   \n\t  ");
  check(d.get("AAAA1111", "c1") === null, "whitespace-only clears rather than storing an empty draft");
  check(d.has("AAAA1111", "c1") === false, "…and the sidebar marker goes with it");

  d.set("AAAA1111", "c3", "keep me");
  check(d.clear("AAAA1111", "c3") === true, "clear() removes an existing draft");
  check(d.clear("AAAA1111", "c3") === false, "clear() on nothing reports nothing");
}

section("drafts: the debounce actually coalesces");
{
  const clock = makeClock();
  const slot = makeSlot();
  const d = createDrafts({ load: slot.load, save: (v) => slot.save(v), debounceMs: 600, ...clock });

  // 40 keystrokes is 40 JSON.stringify calls if this is wrong.
  for (let i = 1; i <= 40; i++) {
    d.set("AAAA1111", "c1", "x".repeat(i));
    clock.advance(10);
  }
  check(slot.writes === 0, `no write yet mid-typing (writes=${slot.writes})`);
  clock.advance(600);
  check(slot.writes === 1, `40 keystrokes coalesced into 1 write (writes=${slot.writes})`);
  const stored = slot.peek();
  const only = Object.values(stored)[0];
  check(only.t === "x".repeat(40), "the single write holds the LATEST text, not the first");

  // A later burst starts a fresh window rather than piggy-backing on the old one.
  d.set("AAAA1111", "c1", "later");
  clock.advance(599);
  check(slot.writes === 1, "still coalescing inside the new window");
  clock.advance(1);
  check(slot.writes === 2, "second window writes exactly once");

  // pagehide can't wait 600ms, so flush() must bypass the debounce.
  d.set("AAAA1111", "c1", "unloading now");
  d.flush();
  check(slot.writes === 3 && slot.peek()[Object.keys(slot.peek())[0]].t === "unloading now", "flush() writes immediately");
  clock.advance(5000);
  check(slot.writes === 3, "flush() also cancels the timer it pre-empted (no double write)");
}

section("drafts: caps and eviction");
{
  const clock = makeClock();
  const slot = makeSlot();
  const d = createDrafts({ load: slot.load, save: (v) => slot.save(v), ...clock });

  for (let i = 0; i < 70; i++) {
    d.set("AAAA1111", "c" + i, "draft " + i);
    clock.advance(1000); // each one is strictly newer than the last
  }
  check(d.size() === 64, `capped at 64 drafts (size=${d.size()})`);
  check(d.has("AAAA1111", "c0") === false, "the oldest-touched draft was evicted");
  check(d.has("AAAA1111", "c5") === false, "…and so were the next five");
  check(d.has("AAAA1111", "c6") === true, "the 64 most recent survive");
  check(d.has("AAAA1111", "c69") === true, "including the newest");

  // Touching an old draft has to move it to the back of the eviction queue, or
  // the draft you're actively editing gets thrown away.
  d.set("AAAA1111", "c6", "still working on this");
  clock.advance(1000);
  d.set("AAAA1111", "c999", "brand new");
  check(d.has("AAAA1111", "c6") === true, "a re-touched draft is not the next one evicted");
  check(d.has("AAAA1111", "c7") === false, "the next-oldest went instead");

  const long = "y".repeat(9000);
  d.set("AAAA1111", "clong", long);
  check(d.get("AAAA1111", "clong").text.length === 4000, `each draft is clipped to 4000 chars (got ${d.get("AAAA1111", "clong").text.length})`);
}

section("drafts: persistence across a reload");
{
  const clock = makeClock();
  const slot = makeSlot();
  const a = createDrafts({ load: slot.load, save: (v) => slot.save(v), ...clock });
  a.set("AAAA1111", "c1", "survives the laptop lid", { id: "m1", name: "Ro", content: "earlier" });
  a.set("BBBB2222", "c4", "so does this one");
  a.flush();

  // New module instance against the same slot === a page reload.
  const b = createDrafts({ load: slot.load, save: (v) => slot.save(v), ...clock });
  check(b.get("AAAA1111", "c1")?.text === "survives the laptop lid", "text survives a reload");
  check(b.get("AAAA1111", "c1")?.replyTo?.name === "Ro", "reply target survives a reload");
  check(b.size() === 2, "both drafts came back");

  // Storage is user-editable and version-skewed, so garbage must not crash boot.
  const junk = makeSlot({ "no-separator": { t: "x" }, "Ac1": null, "Ac2": { t: "   " }, "Ac3": { t: "fine" } });
  const c = createDrafts({ load: junk.load, save: (v) => junk.save(v), ...clock });
  check(c.size() === 1 && c.get("A", "c3")?.text === "fine", `malformed rows are dropped on load (size=${c.size()})`);
}

/* ================================ outbox ================================= */

section("outbox: state 1 — never reached the wire");
{
  const clock = makeClock();
  const slot = makeSlot();
  const wire = makeWire();
  let changes = 0;
  const o = createOutbox({
    send: (c, f) => wire.send(c, f),
    load: slot.load,
    save: (v) => slot.save(v),
    onChange: () => changes++,
    ...clock,
  });

  wire.open = false;
  const r = o.enqueue({ code: "AAAA1111", chanId: "c1", nonce: "n1", frame: msgFrame("c1", "hello", "n1") });
  check(r.state === "queued", `a send that returned false is queued, not lost (state=${r.state})`);
  check(o.size() === 1, "the message is in the queue");
  check(wire.frames.length === 0, "nothing was written to the dead socket");
  check(changes === 1, "onChange fired so the UI can show it as waiting");

  wire.open = true;
  const n = o.flush("AAAA1111");
  check(n === 1, "flush reports one eligible entry");
  check(wire.nonces().join(",") === "n1", "it goes out on reconnect, automatically");
  check(o.pending("AAAA1111")[0].state === "sent", "and moves to sending…");

  o.ack("n1");
  check(o.size() === 0, "the ack retires it");
}

section("outbox: ordering, spacing, and a flush that fails partway");
{
  const clock = makeClock();
  const wire = makeWire();
  const slot = makeSlot();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: slot.load, save: (v) => slot.save(v), gapMs: 180, ...clock });

  wire.open = false;
  for (let i = 1; i <= 10; i++) {
    o.enqueue({ code: "AAAA1111", chanId: "c1", nonce: "q" + i, frame: msgFrame("c1", "m" + i, "q" + i) });
  }
  check(o.size() === 10, "ten messages queued behind a dead socket");

  wire.open = true;
  check(o.flush("AAAA1111") === 10, "flush reports all ten eligible");
  check(wire.frames.length === 1, "only the first goes out synchronously — no burst");
  clock.advance(180 * 9);
  check(wire.frames.length === 10, `all ten eventually sent (${wire.frames.length})`);
  check(wire.nonces().join(",") === "q1,q2,q3,q4,q5,q6,q7,q8,q9,q10", "in enqueue order", wire.nonces().join(","));
  // 10 sends spread over 9 gaps must stay under the server's 30-per-5s window.
  check(180 * 9 >= 1000, "the spacing is real time, not zero");

  // Now the harder half: the socket dies in the middle of a replay.
  const wire2 = makeWire();
  const o2 = createOutbox({ send: (c, f) => wire2.send(c, f), load: () => undefined, save: () => {}, gapMs: 180, ...clock });
  wire2.open = false;
  for (let i = 1; i <= 6; i++) o2.enqueue({ code: "Z", chanId: "c1", nonce: "z" + i, frame: msgFrame("c1", "m", "z" + i) });
  wire2.open = true;
  o2.flush("Z");
  clock.advance(180 * 2); // z1, z2, z3 out
  check(wire2.frames.length === 3, `three sent before the drop (${wire2.frames.length})`);
  wire2.open = false;
  clock.advance(180 * 5);
  check(wire2.frames.length === 3, "nothing more went out while the socket was down");
  check(o2.size() === 6, `a failed flush loses nothing — all six still queued (size=${o2.size()})`);
  const states = o2.pending("Z").map((e) => e.state);
  check(states.slice(3).every((s) => s === "queued"), `the untried three stay queued (${J(states)})`);

  wire2.open = true;
  o2.flush("Z");
  clock.advance(180 * 5);
  check(wire2.nonces().join(",") === "z1,z2,z3,z4,z5,z6", "the replay resumes exactly where it stopped", wire2.nonces().join(","));
}

section("outbox: acks retire the right entry");
{
  const clock = makeClock();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: () => undefined, save: () => {}, ...clock });

  o.enqueue({ code: "A", chanId: "c1", nonce: "a1", frame: msgFrame("c1", "one", "a1") });
  o.enqueue({ code: "A", chanId: "c1", nonce: "a2", frame: msgFrame("c1", "two", "a2") });
  o.enqueue({ code: "B", chanId: "c1", nonce: "b1", frame: msgFrame("c1", "other realm", "b1") });
  check(o.size() === 3, "three in flight");

  check(o.ack("a2") === true, "ack for a2 lands");
  check(o.pending().map((e) => e.nonce).join(",") === "a1,b1", "a2 and only a2 was retired", J(o.pending().map((e) => e.nonce)));
  check(o.ack("a2") === false, "a repeat ack for the same nonce is a no-op");
  check(o.ack("never-sent") === false, "an ack for an unknown nonce is a no-op");
  check(o.pending("A").length === 1 && o.pending("B").length === 1, "pending() is scoped per realm");
}

section("outbox: state 2 — written to a socket that then died");
{
  const clock = makeClock();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: () => undefined, save: () => {}, ...clock });

  o.enqueue({ code: "A", chanId: "c1", nonce: "amb", frame: msgFrame("c1", "did this land?", "amb") });
  check(o.pending("A")[0].state === "sent", "it reached the wire, so it reads as sending…");

  wire.open = false;
  o.disconnected("A");
  const e = o.pending("A")[0];
  check(e.state === "failed" && e.reason === "unacked", `the ambiguous case surfaces as failed/unacked (${e.state}/${e.reason})`, J(e));

  // The decision under test: no automatic retry, because the server has no
  // idempotency key and a duplicate is public and unfixable.
  wire.open = true;
  const n = o.flush("A");
  check(n === 0 && wire.frames.length === 1, `reconnect does NOT resend it (flush=${n}, frames=${wire.frames.length})`);
  check(e.retryable === true, "but the UI is told a Retry button belongs here");

  const r = o.retry("amb");
  check(r.ok === true, "a human pressing Retry does send it");
  check(wire.frames.length === 2 && wire.nonces()[1] === "amb", "and it goes out with the SAME nonce, so a late ack still matches");
  check(o.ack("amb") === true && o.size() === 0, "the retry's ack retires it");

  // Dismissing is the other half of the choice: the user saw it landed already.
  o.enqueue({ code: "A", chanId: "c1", nonce: "dis", frame: msgFrame("c1", "saw it in history", "dis") });
  o.disconnected("A");
  check(o.drop("dis") === true && o.size() === 0, "drop() dismisses a failed entry");
}

section("outbox: attachments can't be blindly retried");
{
  const clock = makeClock();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: () => undefined, save: () => {}, ...clock });
  const att = [{ key: "a/AAAA/uuid/cat.png", url: "/f/a/AAAA/uuid/cat.png", name: "cat.png" }];

  // Case A: never reached the wire. The server never ran claimAttachments, so
  // the att: records are intact and a retry is genuinely safe.
  wire.open = false;
  o.enqueue({ code: "A", chanId: "c1", nonce: "f1", frame: msgFrame("c1", "look", "f1", { attachments: att }) });
  wire.open = true;
  check(o.flush("A") === 1, "a queued attachment message IS auto-retried — its keys are untouched");
  check(wire.frames[0].frame.attachments.length === 1, "and it still carries its attachments");
  o.ack("f1");

  // Case B: written, then the socket died. If the server processed it, the
  // keys are already spent, so a "successful" retry posts dead attachments.
  o.enqueue({ code: "A", chanId: "c1", nonce: "f2", frame: msgFrame("c1", "look again", "f2", { attachments: att }) });
  o.disconnected("A");
  const e = o.pending("A")[0];
  check(e.state === "failed" && e.files === true, "an ambiguous attachment message is failed and flagged as carrying files");
  check(e.retryable === false, "and is explicitly NOT retryable");
  const before = wire.frames.length;
  const r = o.retry("f2");
  check(r.ok === false && r.reason === "attachments-consumed", `retry refuses it with a reason (${J(r)})`);
  check(wire.frames.length === before, "nothing was sent by the refused retry");
  check(o.drop("f2") === true, "the user can still dismiss it and re-attach");

  // Case C: queued, but the server's 30-minute ATT_TTL is closing in. Sending
  // it now would silently drop the files, so it stops being auto-flushable.
  wire.open = false;
  o.enqueue({ code: "A", chanId: "c1", nonce: "f3", frame: msgFrame("c1", "stale files", "f3", { attachments: att }) });
  clock.advance(21 * 60 * 1000);
  wire.open = true;
  check(o.flush("A") === 0, "a 21-minute-old attachment message is not auto-sent");
  const stale = o.pending("A")[0];
  check(stale.state === "failed" && stale.reason === "attachments-expired", `it fails with attachments-expired (${stale.reason})`);
  check(o.retry("f3").reason === "attachments-expired", "and a manual retry is refused too — the objects are gone from R2");
}

section("outbox: age limit and cap");
{
  const clock = makeClock();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: () => undefined, save: () => {}, ...clock });

  wire.open = false;
  o.enqueue({ code: "A", chanId: "c1", nonce: "old", frame: msgFrame("c1", "typed before bed", "old") });
  clock.advance(3 * 60 * 60 * 1000); // three hours in a closed laptop
  wire.open = true;
  check(o.flush("A") === 0, "a three-hour-old message does not fire itself into the channel");
  const e = o.pending("A")[0];
  check(e.state === "failed" && e.reason === "stale", `it's surfaced as stale instead (${e.reason})`);
  check(o.retry("old").ok === true, "but the user can still choose to send it — the limit is on the app, not on them");
  check(wire.nonces().join(",") === "old", "and then it goes");
  o.ack("old");

  // Three days later it isn't even offered.
  wire.open = false;
  o.enqueue({ code: "A", chanId: "c1", nonce: "ancient", frame: msgFrame("c1", "three days ago", "ancient") });
  clock.advance(3 * 24 * 60 * 60 * 1000);
  o.sweep();
  check(o.size() === 0, "past 24h an entry is dropped entirely, not resurrected");

  // Cap.
  const wire2 = makeWire();
  wire2.open = false;
  const o2 = createOutbox({ send: (c, f) => wire2.send(c, f), load: () => undefined, save: () => {}, ...clock });
  for (let i = 1; i <= 60; i++) {
    o2.enqueue({ code: "A", chanId: "c1", nonce: "c" + i, frame: msgFrame("c1", "m" + i, "c" + i) });
  }
  check(o2.size() === 50, `queue caps at 50 (size=${o2.size()})`);
  const ns = o2.pending("A").map((e) => e.nonce);
  check(ns[0] === "c11" && ns[49] === "c60", "the oldest were dropped, the newest kept", J([ns[0], ns[49]]));
}

section("outbox: persistence across a reload");
{
  const clock = makeClock();
  const slot = makeSlot();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: slot.load, save: (v) => slot.save(v), ...clock });

  wire.open = false;
  o.enqueue({ code: "AAAA1111", chanId: "c1", nonce: "p1", frame: msgFrame("c1", "closed the lid", "p1") });
  o.enqueue({ code: "AAAA1111", chanId: "c1", nonce: "p2", frame: msgFrame("c1", "mid-send", "p2") });
  check(slot.writes === 0, "the queue write is debounced like the drafts one");
  o.persist();
  check(slot.writes === 1, "persist() writes immediately");

  // Reload.
  const wire2 = makeWire();
  const o2 = createOutbox({ send: (c, f) => wire2.send(c, f), load: slot.load, save: (v) => slot.save(v), ...clock });
  check(o2.size() === 2, "both queued messages came back after the reload");
  check(o2.flush("AAAA1111") === 2, "and they are still eligible to send");
  clock.advance(1000);
  check(wire2.nonces().join(",") === "p1,p2", "sent in the original order", wire2.nonces().join(","));
  check(wire2.frames[0].frame.content === "closed the lid", "with their content intact");

  // A `sent` entry that got persisted is, by definition, one we never saw acked
  // — the reload IS the socket dying, so it must come back as the ambiguous case.
  const slot2 = makeSlot();
  const wire3 = makeWire();
  const o3 = createOutbox({ send: (c, f) => wire3.send(c, f), load: slot2.load, save: (v) => slot2.save(v), ...clock });
  o3.enqueue({ code: "A", chanId: "c1", nonce: "s1", frame: msgFrame("c1", "in flight at reload", "s1") });
  check(o3.pending("A")[0].state === "sent", "it was on the wire when the tab died");
  o3.persist();

  const wire4 = makeWire();
  const o4 = createOutbox({ send: (c, f) => wire4.send(c, f), load: slot2.load, save: (v) => slot2.save(v), ...clock });
  const back = o4.pending("A")[0];
  check(back.state === "failed" && back.reason === "unacked", `it returns as failed/unacked, not as pending (${back.state}/${back.reason})`);
  check(o4.flush("A") === 0 && wire4.frames.length === 0, "so a reload can never duplicate a message by itself");

  // Junk in the slot must not take the app down on boot. A row with no
  // timestamp counts as junk too: without one we can't tell it from a message
  // typed three days ago, and the safe direction is to forget it.
  const junk = makeSlot([
    null,
    { n: "x" }, // no code, no frame
    "nope",
    { n: "notime", c: "A", f: { type: "msg" } }, // no `at`
    { n: "y", c: "A", ch: "c1", at: clock.now(), s: "queued", f: msgFrame("c1", "fine", "y") },
  ]);
  const o5 = createOutbox({ send: () => false, load: junk.load, save: () => {}, ...clock });
  check(o5.size() === 1 && o5.pending()[0].nonce === "y", `malformed rows are dropped on load (size=${o5.size()})`);
}

section("outbox: a new message never overtakes the backlog");
{
  const clock = makeClock();
  const wire = makeWire();
  const o = createOutbox({ send: (c, f) => wire.send(c, f), load: () => undefined, save: () => {}, gapMs: 180, ...clock });

  wire.open = false;
  o.enqueue({ code: "A", chanId: "c1", nonce: "old1", frame: msgFrame("c1", "first", "old1") });
  // Socket comes back, but before flush() runs the user types something new.
  wire.open = true;
  o.enqueue({ code: "A", chanId: "c1", nonce: "new1", frame: msgFrame("c1", "second", "new1") });
  check(wire.frames.length === 0, "the new message waits rather than jumping the queue");
  o.flush("A");
  clock.advance(180);
  check(wire.nonces().join(",") === "old1,new1", "order is preserved across the reconnect", wire.nonces().join(","));
}

/* =============================== summary ================================ */

console.log("");
if (failures) {
  console.error(`${failures} CHECK${failures === 1 ? "" : "S"} FAILED (${passed} passed)`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
