// Concord archive + search tests.
// Usage: node test/archive.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// The 300-message ring used to be where history ended. These tests drive a
// channel well past the cap and prove the four things that make an archive an
// archive rather than a claim: everything past 300 is still readable, the
// order across the archive/live seam is the order it was written in,
// attachments inside archived messages still resolve, and deleting a channel
// takes its archive with it. Plus the search half: a server-wide search must
// examine every channel and must admit when it stopped early.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code =
  "AR" + Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

// One channel's ring is 300 deep; 14 sockets x 28 messages clears it with room
// for two archive batches. The split exists only because a single socket is
// rate-limited to 30 messages per 5 seconds and this would otherwise take a
// minute and a half.
const FLOOD_SOCKETS = 14;
const FLOOD_PER_SOCKET = 28;
const MSG_CAP = 300;
const HISTORY_PAGE = 60;

let passed = 0;
function ok(label) {
  passed++;
  console.log(`  PASS ${label}`);
}
function fail(label, detail) {
  console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  process.exit(1);
}

const watchdog = setTimeout(() => fail("archive suite", "whole suite timed out"), 180_000);
watchdog.unref?.();

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
    } else if (m.type !== "msg") {
      queue.push(m); // the flood broadcasts thousands of these; nothing waits on them
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
    open: () =>
      new Promise((res, rej) => (ws.on("open", res), ws.on("unexpected-response", (_r, resp) => rej(resp.statusCode)))),
  };
}

// One throwaway socket that says hello, fires `count` messages, and hands back
// what the server assigned them. Every message this suite sends is identifiable
// from its content alone, which is what makes the ordering check meaningful.
function flood(chanId, tag, count) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws?server=${code}`);
    const acks = [];
    let started = false;
    ws.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "welcome" && !started) {
        started = true;
        for (let i = 0; i < count; i++) {
          ws.send(JSON.stringify({ type: "msg", chanId, content: `${tag}#${i}`, nonce: `${tag}#${i}` }));
        }
      } else if (m.type === "msg-ack") {
        acks.push([m.msg.id, m.msg.content]);
        if (acks.length === count) {
          ws.close();
          resolve(acks);
        }
      }
    });
    ws.on("open", () =>
      ws.send(JSON.stringify({ type: "hello", name: tag, color: "#888888", avatar: "🤖" }))
    );
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Concord archive test → ${base}  (server code ${code})`);

// --- setup -------------------------------------------------------------------
const A = connect(`&create=1&name=ArchiveTest`);
await A.open();
A.send({ type: "hello", userId: "arch-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcome = await A.expect("Alice welcome", (m) => m.type === "welcome");
const chan = welcome.channels.find((c) => c.type === "text");
ok(`setup: server created (${welcome.channels.length} default channels)`);

// The very first message carries a real uploaded file, so that by the end of the
// flood the archive is holding a message with an attachment in it.
const bytes = Buffer.from("archived png bytes ".repeat(40));
A.send({ type: "upload-ticket", files: [{ name: "old.png", size: bytes.length, mime: "image/png" }] });
const tix = await A.expect("archive attachment ticket", (m) => m.type === "upload-tickets");
const put = await fetch(`${base}/api/upload/${tix.tickets[0].id}?code=${code}`, { method: "PUT", body: bytes });
if (put.status !== 200) fail("upload for archive test", `status ${put.status}`);
const attKey = (await put.json()).att.key;

A.send({
  type: "msg",
  chanId: chan.id,
  content: "the oldest message",
  nonce: "oldest",
  attachments: [{ key: attKey, name: "old.png", size: bytes.length, mime: "image/png" }],
});
const oldest = await A.expect("oldest message ack", (m) => m.type === "msg-ack" && m.nonce === "oldest");
if (!oldest.msg.attachments?.length) fail("oldest message should carry its attachment", JSON.stringify(oldest.msg));

// A token planted in a message that will end up *in the archive* — search reads
// the live window only, and has to be honest about that.
A.send({ type: "msg", chanId: chan.id, content: "deepneedlezq buried early", nonce: "deep" });
const deep = await A.expect("deep needle ack", (m) => m.type === "msg-ack" && m.nonce === "deep");

// Four more text channels, so the search budget has eight chattable channels to
// divide between (2 text + 2 voice by default; voice channels are chattable).
const extra = [];
for (let i = 0; i < 4; i++) {
  A.send({ type: "create-channel", name: `annex-${i}`, chanType: "text" });
  const made = await A.expect(`extra channel ${i}`, (m) => m.type === "channel-create" && m.channel.name === `annex-${i}`);
  extra.push(made.channel);
}
const lastChan = extra[extra.length - 1];
A.send({ type: "msg", chanId: lastChan.id, content: "lastchanneltokenzq over here", nonce: "last" });
await A.expect("last-channel token ack", (m) => m.type === "msg-ack" && m.nonce === "last");
ok(`setup: attachment + two search tokens planted across ${welcome.channels.length + 4} channels`);

// --- 1. drive the channel past the ring ---------------------------------------
const started = Date.now();
const floods = await Promise.all(
  Array.from({ length: FLOOD_SOCKETS }, (_, i) => flood(chan.id, `f${i}`, FLOOD_PER_SOCKET))
);
const sent = new Map([[oldest.msg.id, oldest.msg.content], [deep.msg.id, deep.msg.content]]);
for (const acks of floods) for (const [id, content] of acks) sent.set(id, content);
const total = sent.size;
if (total !== FLOOD_SOCKETS * FLOOD_PER_SOCKET + 2)
  fail("flood accounting", `${total} distinct ids for ${FLOOD_SOCKETS * FLOOD_PER_SOCKET + 2} messages`);
if (total <= MSG_CAP) fail("flood size", `${total} messages does not exceed the ${MSG_CAP} ring`);
ok(`ring: ${total} messages sent to one channel in ${((Date.now() - started) / 1000).toFixed(1)}s (${total - MSG_CAP} past the ${MSG_CAP} cap)`);

// The flush to R2 rides waitUntil rather than blocking the sender, so give it a
// moment before asserting on it. (Correctness doesn't depend on this — anything
// unflushed is still served out of the durable buffer — but the test wants to
// exercise the R2 path, not just the buffer.)
await sleep(1500);

// --- 2. everything past the cap is still readable, in order --------------------
await sleep(5200); // fresh rate-limit window before a burst of history pages
const seen = [];
let before = null;
let pages = 0;
let sawArchiveHint = false;
for (;;) {
  A.send(before ? { type: "history", chanId: chan.id, before } : { type: "history", chanId: chan.id });
  const page = await A.expect(`history page ${pages}`, (m) => m.type === "history" && m.chanId === chan.id);
  pages++;
  if (typeof page.hasArchive !== "boolean") fail("history carries a hasArchive hint", JSON.stringify(Object.keys(page)));
  if (page.hasArchive) sawArchiveHint = true;
  if (!page.messages.length) break;
  for (let i = 1; i < page.messages.length; i++) {
    if (page.messages[i].id <= page.messages[i - 1].id)
      fail("history page is ascending", `${page.messages[i - 1].id} then ${page.messages[i].id}`);
  }
  seen.unshift(...page.messages);
  before = page.messages[0].id;
  if (!page.hasArchive) break;
  if (pages > 20) fail("history paging", "never reached the beginning");
}
if (!sawArchiveHint) fail("hasArchive", "no page ever admitted there was an archive");

const ids = seen.map((x) => x.id);
if (ids.length !== total) fail("every message is retrievable", `paged back ${ids.length} of ${total}`);
for (let i = 0; i < ids.length; i++) {
  if (ids[i] !== i + 1) fail("archive/live order", `position ${i} holds id ${ids[i]}`);
  if (seen[i].content !== sent.get(ids[i]))
    fail("archived content", `id ${ids[i]} came back as "${seen[i].content}"`);
}
ok(`archive: all ${total} messages paged back over ${pages} pages, ids 1..${total} contiguous and in order`);
ok(`archive: the ${total - MSG_CAP} messages evicted past the ring survived, contents intact across the seam`);

// --- 3. attachments inside archived messages still resolve ----------------------
const archivedWithFile = seen.find((x) => x.id === oldest.msg.id);
if (!archivedWithFile) fail("oldest message survived", `id ${oldest.msg.id} missing`);
if (archivedWithFile.attachments?.[0]?.key !== attKey)
  fail("archived message kept its attachment descriptor", JSON.stringify(archivedWithFile.attachments));
const getArchived = await fetch(`${base}/f/${attKey}`);
if (getArchived.status !== 200) fail("archived attachment still resolves", `GET /f/<key> → ${getArchived.status}`);
if (getArchived.headers.get("content-type") !== "image/png")
  fail("archived attachment content-type", getArchived.headers.get("content-type"));
await getArchived.arrayBuffer();
ok("archive: an evicted message keeps its attachment — descriptor and R2 object both survive eviction");

// --- 4. search examines every channel and admits when it stopped -----------------
await sleep(5200);
A.send({ type: "search", q: "lastchanneltokenzq" });
const wide = await A.expect("server-wide search", (m) => m.type === "search-results");
if (!wide.hits.some((h) => h.chanId === lastChan.id))
  fail("server-wide search reaches the last channel", `${wide.hits.length} hits, none in ${lastChan.id}`);
if (wide.truncated !== true)
  fail("search admits a partial scan", "a channel at the ring cap was only partly read, truncated was false");
ok(`search: a token in the last of 8 channels is found even with a full channel ahead of it (truncated=${wide.truncated})`);

A.send({ type: "search", q: "deepneedlezq" });
const deepSearch = await A.expect("archived-token search", (m) => m.type === "search-results");
if (deepSearch.hits.length) fail("search scope", "search returned an archived message it never scanned");
if (deepSearch.truncated !== true) fail("search honesty", "missed an archived message without saying the scan was partial");
ok("search: a token that has fallen into the archive is reported as a partial scan, not as 'no results'");

A.send({ type: "search", q: "lastchanneltokenzq", chanId: lastChan.id });
const scoped = await A.expect("scoped search", (m) => m.type === "search-results");
if (scoped.hits.length !== 1) fail("scoped search", `${scoped.hits.length} hits`);
if (scoped.truncated !== false) fail("scoped search truncation", "a complete scan claimed to be truncated");
ok("search: a scoped search that read the whole channel reports truncated=false");

// --- 5. delete-channel purges the archive ------------------------------------------
A.send({ type: "delete-channel", chanId: chan.id });
await A.expect("channel-delete", (m) => m.type === "channel-delete" && m.chanId === chan.id);
await sleep(500);
const getPurged = await fetch(`${base}/f/${attKey}`);
if (getPurged.status !== 404)
  fail("delete-channel purges archived attachments", `GET /f/<key> → ${getPurged.status}, wanted 404`);
await getPurged.text();
A.send({ type: "history", chanId: chan.id });
const afterDelete = await A.expect("history after delete", (m) => m.type === "history" && m.chanId === chan.id);
if (afterDelete.messages.length) fail("archive survived a channel delete", `${afterDelete.messages.length} messages`);
if (afterDelete.hasArchive) fail("archive survived a channel delete", "hasArchive still true");
ok(`archive: delete-channel purged all ${total} messages, the R2 archive objects, and the attachments inside them`);

A.ws.close();
clearTimeout(watchdog);
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
