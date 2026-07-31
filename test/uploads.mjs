// Concord upload-protocol tests.
// Usage: node test/uploads.mjs [baseUrl]   (default http://127.0.0.1:4189)
// Walks the three-step handshake (upload-ticket over WS, PUT the bytes over
// HTTP, reference the key in a msg) plus the edges that would actually hurt
// if they broke: single-use tickets/keys, size caps at both checkpoints, the
// mime allowlist (svg/html must never render on our own origin), filename
// sanitisation, and R2 cleanup on delete.

import WebSocket from "ws";

const base = process.argv[2] || "http://127.0.0.1:4189";
const wsBase = base.replace(/^http/, "ws");
const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const code =
  "UP" + Array.from({ length: 6 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");

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

console.log(`Concord uploads test → ${base}  (server code ${code})`);

// --- setup: Alice creates the server, Bob joins --------------------------------
const A = connect(`&create=1&name=UploadsTest`);
await A.open();
A.send({ type: "hello", userId: "user-alice", name: "Alice", color: "#ff5555", avatar: "🦊" });
const welcomeA = await A.expect("Alice welcome", (m) => m.type === "welcome");
const textChan = welcomeA.channels.find((c) => c.type === "text");

const B = connect("");
await B.open();
B.send({ type: "hello", userId: "user-bob", name: "Bob", color: "#55ff88", avatar: "🐻" });
await B.expect("Bob welcome", (m) => m.type === "welcome");
await A.expect("Alice sees Bob join", (m) => m.type === "member-join");
ok("setup: Alice creates server, Bob joins");

// --- 1. happy path: ticket → PUT → msg → GET /f/<key> ---------------------------
const bytesHappy = Buffer.from("fake png bytes ".repeat(200));
A.send({ type: "upload-ticket", files: [{ name: "cat.png", size: bytesHappy.length, mime: "image/png" }] });
const tixHappy = await A.expect("happy-path tickets", (m) => m.type === "upload-tickets" || m.type === "error");
if (tixHappy.type !== "upload-tickets") fail("happy-path ticket issued", JSON.stringify(tixHappy));
const ticketHappy = tixHappy.tickets[0];
if (!ticketHappy.id || !ticketHappy.key || ticketHappy.max !== 25 * 1024 * 1024)
  fail("ticket shape", JSON.stringify(ticketHappy));

const putHappy = await fetch(`${base}/api/upload/${ticketHappy.id}?code=${code}`, {
  method: "PUT",
  body: bytesHappy,
});
if (putHappy.status !== 200) fail("PUT upload happy path", `status ${putHappy.status}`);
const putBodyHappy = await putHappy.json();
if (!putBodyHappy.ok || putBodyHappy.att.key !== ticketHappy.key || putBodyHappy.att.mime !== "image/png")
  fail("PUT response shape", JSON.stringify(putBodyHappy));
const keyHappy = putBodyHappy.att.key;

A.send({
  type: "msg",
  chanId: textChan.id,
  content: "look at this",
  nonce: "up1",
  attachments: [{ key: keyHappy, name: "cat.png", size: bytesHappy.length, mime: "image/png", w: 10, h: 10 }],
});
const ackHappy = await A.expect("msg-ack with attachment", (m) => m.type === "msg-ack" && m.nonce === "up1");
if (!ackHappy.msg.attachments || ackHappy.msg.attachments[0].key !== keyHappy)
  fail("attachment landed on message", JSON.stringify(ackHappy.msg));
if (ackHappy.msg.attachments[0].url !== `/f/${keyHappy}`) fail("attachment url field", ackHappy.msg.attachments[0].url);
await B.expect("Bob receives msg with attachment", (m) => m.type === "msg" && m.msg.attachments?.[0]?.key === keyHappy);
const happyMsgId = ackHappy.msg.id;

const getHappy = await fetch(`${base}/f/${keyHappy}`);
if (getHappy.status !== 200) fail("GET /f/<key> happy path", `status ${getHappy.status}`);
if (getHappy.headers.get("content-type") !== "image/png") fail("stored content-type", getHappy.headers.get("content-type"));
if (!(getHappy.headers.get("cache-control") || "").includes("immutable"))
  fail("cache-control immutable", getHappy.headers.get("cache-control"));
await getHappy.arrayBuffer(); // drain
ok("upload handshake: ticket → PUT → msg → GET /f/<key>, correct content-type + immutable cache");

// --- 2. a ticket is single-use ---------------------------------------------------
A.send({ type: "upload-ticket", files: [{ name: "once.txt", size: 10, mime: "text/plain" }] });
const tixOnce = await A.expect("single-use ticket issued", (m) => m.type === "upload-tickets");
const ticketOnce = tixOnce.tickets[0];
const putOnceFirst = await fetch(`${base}/api/upload/${ticketOnce.id}?code=${code}`, { method: "PUT", body: "0123456789" });
if (putOnceFirst.status !== 200) fail("first spend of ticket", `status ${putOnceFirst.status}`);
await putOnceFirst.json();
const putOnceSecond = await fetch(`${base}/api/upload/${ticketOnce.id}?code=${code}`, { method: "PUT", body: "0123456789" });
if (putOnceSecond.status !== 403) fail("re-spending a ticket must fail", `status ${putOnceSecond.status}`);
ok("uploads: a ticket can only be spent once (403 on replay)");

// --- 3. an attachment key can be consumed by exactly one message -----------------
A.send({ type: "upload-ticket", files: [{ name: "single-use-key.txt", size: 12, mime: "text/plain" }] });
const tixKey = await A.expect("key single-use tickets", (m) => m.type === "upload-tickets");
const ticketKey = tixKey.tickets[0];
const putKey = await fetch(`${base}/api/upload/${ticketKey.id}?code=${code}`, { method: "PUT", body: "hello world!" });
const putKeyBody = await putKey.json();
const attKey = putKeyBody.att.key;

A.send({ type: "msg", chanId: textChan.id, content: "first use", nonce: "key1", attachments: [{ key: attKey, name: "single-use-key.txt", size: 12, mime: "text/plain" }] });
const ackKey1 = await A.expect("first spend of key", (m) => m.type === "msg-ack" && m.nonce === "key1");
if (!ackKey1.msg.attachments || ackKey1.msg.attachments[0].key !== attKey) fail("first use of key attaches", JSON.stringify(ackKey1.msg));

A.send({ type: "msg", chanId: textChan.id, content: "second use", nonce: "key2", attachments: [{ key: attKey, name: "single-use-key.txt", size: 12, mime: "text/plain" }] });
const ackKey2 = await A.expect("second spend of key", (m) => m.type === "msg-ack" && m.nonce === "key2");
if (ackKey2.msg.attachments) fail("attachment key was reused across two messages", JSON.stringify(ackKey2.msg));
ok("uploads: an attachment key is consumed by exactly one message");

// --- 4. someone else's key is refused ---------------------------------------------
A.send({ type: "upload-ticket", files: [{ name: "alices-file.txt", size: 9, mime: "text/plain" }] });
const tixCross = await A.expect("cross-user tickets", (m) => m.type === "upload-tickets");
const ticketCross = tixCross.tickets[0];
const putCross = await fetch(`${base}/api/upload/${ticketCross.id}?code=${code}`, { method: "PUT", body: "alicedata" });
const putCrossBody = await putCross.json();
const aliceKey = putCrossBody.att.key;

// Bob (a different socket, different userId) tries to attach Alice's key.
B.send({ type: "msg", chanId: textChan.id, content: "stolen?", nonce: "steal1", attachments: [{ key: aliceKey, name: "alices-file.txt", size: 9, mime: "text/plain" }] });
const ackSteal = await B.expect("bob's steal attempt ack", (m) => m.type === "msg-ack" && m.nonce === "steal1");
if (ackSteal.msg.attachments) fail("Bob attached Alice's upload key", JSON.stringify(ackSteal.msg));
ok("uploads: an attachment key claimed by someone else is silently dropped, not attached");

// --- 5. over-size rejected at ticket time -----------------------------------------
A.send({ type: "upload-ticket", files: [{ name: "huge.bin", size: 26 * 1024 * 1024, mime: "application/zip" }] });
const overTicket = await A.expect("oversize ticket rejection", (m) => m.type === "error" || m.type === "upload-tickets");
if (overTicket.type !== "error") fail("26 MB declared file should be rejected at ticket time", JSON.stringify(overTicket));
ok(`uploads: declaring a 26 MB file at ticket time is rejected — "${overTicket.error}"`);

// --- 6. over-size rejected at PUT time (real bytes) --------------------------------
A.send({ type: "upload-ticket", files: [{ name: "small-declared.bin", size: 500, mime: "application/zip" }] });
const tixOversizePut = await A.expect("oversize-at-put ticket", (m) => m.type === "upload-tickets");
const ticketOversizePut = tixOversizePut.tickets[0];
const oversizeBytes = Buffer.alloc(25 * 1024 * 1024 + 1024); // over MAX_FILE_BYTES regardless of declared size
const putOversize = await fetch(`${base}/api/upload/${ticketOversizePut.id}?code=${code}`, { method: "PUT", body: oversizeBytes });
if (putOversize.status !== 413) fail("PUT exceeding the byte cap must 413", `status ${putOversize.status}`);
await putOversize.text();
ok("uploads: PUTting real bytes over the 25 MB cap is rejected with 413");

// --- 7. more than 10 files in one upload-ticket is refused --------------------------
const tooManyFiles = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, size: 10, mime: "text/plain" }));
A.send({ type: "upload-ticket", files: tooManyFiles });
const overCount = await A.expect("too-many-files rejection", (m) => m.type === "error" || m.type === "upload-tickets");
if (overCount.type !== "error") fail("11 files in one ticket request should be refused", JSON.stringify(overCount));
ok(`uploads: 11 files in one upload-ticket request is refused — "${overCount.error}"`);

// --- 8. image/svg+xml and text/html download instead of rendering -------------------
// This is the security-relevant assertion: an SVG or HTML file uploaded through
// this pipe must never be served with a renderable Content-Type on our own
// origin, or it becomes a stored-XSS vector (script execution as if it were
// our own first-party content). safeMime() must force both to
// application/octet-stream, and the disposition rule must then force
// "attachment" rather than "inline".
A.send({ type: "upload-ticket", files: [{ name: "evil.svg", size: 40, mime: "image/svg+xml" }] });
const tixSvg = await A.expect("svg ticket", (m) => m.type === "upload-tickets");
const ticketSvg = tixSvg.tickets[0];
const putSvg = await fetch(`${base}/api/upload/${ticketSvg.id}?code=${code}`, {
  method: "PUT",
  body: '<svg onload="alert(1)"></svg>',
});
const putSvgBody = await putSvg.json();
const getSvg = await fetch(`${base}/f/${putSvgBody.att.key}`);
if (getSvg.status !== 200) fail("GET svg", `status ${getSvg.status}`);
if (getSvg.headers.get("content-type") !== "application/octet-stream")
  fail("SVG must be downgraded to octet-stream, not served as image/svg+xml", getSvg.headers.get("content-type"));
const svgDisposition = getSvg.headers.get("content-disposition") || "";
if (!svgDisposition.startsWith("attachment"))
  fail("SVG must download (attachment), never render (inline), on our own origin", svgDisposition);
await getSvg.arrayBuffer();

A.send({ type: "upload-ticket", files: [{ name: "evil.html", size: 40, mime: "text/html" }] });
const tixHtml = await A.expect("html ticket", (m) => m.type === "upload-tickets");
const ticketHtml = tixHtml.tickets[0];
const putHtml = await fetch(`${base}/api/upload/${ticketHtml.id}?code=${code}`, {
  method: "PUT",
  body: "<script>alert(document.cookie)</script>",
});
const putHtmlBody = await putHtml.json();
const getHtml = await fetch(`${base}/f/${putHtmlBody.att.key}`);
if (getHtml.status !== 200) fail("GET html", `status ${getHtml.status}`);
if (getHtml.headers.get("content-type") !== "application/octet-stream")
  fail("HTML must be downgraded to octet-stream, not served as text/html", getHtml.headers.get("content-type"));
const htmlDisposition = getHtml.headers.get("content-disposition") || "";
if (!htmlDisposition.startsWith("attachment"))
  fail("HTML must download (attachment), never render (inline), on our own origin", htmlDisposition);
await getHtml.arrayBuffer();
ok("uploads SECURITY: image/svg+xml and text/html always download as octet-stream/attachment, never render on our origin");

// --- 9. filename with ../ and spaces is sanitised into the key ----------------------
A.send({ type: "upload-ticket", files: [{ name: "../../etc/ pass word.txt", size: 10, mime: "text/plain" }] });
const tixName = await A.expect("sanitised-name ticket", (m) => m.type === "upload-tickets");
const ticketName = tixName.tickets[0];
// The server's cleanFileName() strips separators, collapses dot-dot runs, maps
// disallowed characters (including spaces) to "_", and strips leading dots —
// exact expected output verified against the implementation.
const expectedBase = "etc__pass_word.txt";
const actualBase = ticketName.key.split("/").pop();
if (actualBase !== expectedBase) fail("filename sanitisation", `got "${actualBase}", wanted "${expectedBase}"`);
if (ticketName.key.includes("..") || ticketName.key.includes(" "))
  fail("sanitised key still contains .. or a raw space", ticketName.key);
ok(`uploads: "../../etc/ pass word.txt" sanitises to "${actualBase}"`);

// --- 10. deleting the message deletes the object ------------------------------------
A.send({ type: "delete", chanId: textChan.id, msgId: happyMsgId });
await B.expect("Bob sees delete", (m) => m.type === "msg-delete" && m.msgId === happyMsgId);
const getAfterDelete = await fetch(`${base}/f/${keyHappy}`);
if (getAfterDelete.status !== 404) fail("GET /f/<key> after delete must 404", `status ${getAfterDelete.status}`);
await getAfterDelete.text();
ok("uploads: deleting a message deletes its R2 object (GET /f/<key> → 404)");

// --- 11. a message with no text but one attachment is accepted -----------------------
A.send({ type: "upload-ticket", files: [{ name: "picture-only.png", size: 20, mime: "image/png" }] });
const tixOnlyPic = await A.expect("picture-only ticket", (m) => m.type === "upload-tickets");
const ticketOnlyPic = tixOnlyPic.tickets[0];
const putOnlyPic = await fetch(`${base}/api/upload/${ticketOnlyPic.id}?code=${code}`, { method: "PUT", body: "twenty bytes of png!" });
const putOnlyPicBody = await putOnlyPic.json();

A.send({
  type: "msg",
  chanId: textChan.id,
  content: "",
  nonce: "noText1",
  attachments: [{ key: putOnlyPicBody.att.key, name: "picture-only.png", size: 20, mime: "image/png" }],
});
const ackNoText = await A.expect("no-text picture-only ack", (m) => m.type === "msg-ack" && m.nonce === "noText1");
if (ackNoText.msg.content) fail("expected empty content", JSON.stringify(ackNoText.msg));
if (!ackNoText.msg.attachments?.length) fail("picture-only message should still carry the attachment", JSON.stringify(ackNoText.msg));
await B.expect("Bob sees picture-only message", (m) => m.type === "msg" && m.msg.id === ackNoText.msg.id);
ok("uploads: a message with no text but one attachment is accepted");

A.ws.close();
B.ws.close();
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
