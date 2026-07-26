// Concord browser e2e: two real Chromium pages create/join a server through
// the actual UI, chat both directions, and both join a voice channel (fake
// mics) to exercise the WebRTC signaling path end to end.
// Usage: node test/e2e.mjs [baseUrl]   (default http://127.0.0.1:4189)

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

function track(page, name, errors) {
  page.on("pageerror", (e) => errors.push(`${name} pageerror: ${e.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${name} console: ${msg.text()}`);
  });
}

async function onboard(page, name) {
  await page.waitForSelector("#onboard-modal:not(.hidden)", { timeout: 10000 });
  await page.fill("#ob-name", name);
  await page.click("#ob-avatars button:nth-child(3)");
  await page.click("#ob-done");
}

const errorsA = [];
const errorsB = [];

try {
  // ---- Alice creates a server through the UI --------------------------------
  const ctxA = await browser.newContext({ permissions: ["microphone"] });
  const pageA = await ctxA.newPage();
  track(pageA, "A", errorsA);
  await pageA.goto(base);
  await onboard(pageA, "E2E Alice");
  await pageA.waitForSelector("#join-modal:not(.hidden)");
  await pageA.fill("#jm-create-name", "E2E Test Server");
  await pageA.click("#jm-create");
  await pageA.waitForSelector("#invite-modal:not(.hidden)", { timeout: 10000 });
  const invite = (await pageA.textContent("#invite-code")).trim();
  if (!/^[A-Z0-9]{4,12}$/.test(invite)) bad("invite code", invite);
  else ok(`server created via UI, invite code ${invite}`);
  await pageA.click("#invite-modal .modal-close");
  await pageA.waitForSelector("#app:not(.hidden)");
  const serverName = await pageA.textContent("#server-name");
  if (serverName !== "E2E Test Server") bad("server name in sidebar", serverName);
  else ok("server name renders in sidebar");

  // ---- Alice sends a markdown message ----------------------------------------
  await pageA.fill("#input", "hello **world** from e2e");
  await pageA.press("#input", "Enter");
  await pageA.waitForSelector("#messages .msg:not(.pending) strong", { timeout: 10000 });
  ok("message sent, acked (not pending), markdown bold rendered");

  // ---- Bob joins via the invite link ------------------------------------------
  const ctxB = await browser.newContext({ permissions: ["microphone"] });
  const pageB = await ctxB.newPage();
  track(pageB, "B", errorsB);
  await pageB.goto(`${base}/?join=${invite}`);
  await onboard(pageB, "E2E Bob");
  await pageB.waitForSelector("#app:not(.hidden)", { timeout: 10000 });
  await pageB.waitForFunction(
    () => document.querySelector("#messages")?.textContent.includes("hello"),
    { timeout: 10000 }
  );
  ok("Bob joined via ?join link and sees history");

  // ---- live chat B -> A ---------------------------------------------------------
  await pageB.fill("#input", "hey alice, bob here");
  await pageB.press("#input", "Enter");
  await pageA.waitForFunction(
    () => document.querySelector("#messages")?.textContent.includes("bob here"),
    { timeout: 10000 }
  );
  ok("live message B→A broadcast");

  // ---- member list shows both ----------------------------------------------------
  await pageA.waitForFunction(
    () => document.querySelector("#member-list")?.textContent.includes("E2E Bob"),
    { timeout: 5000 }
  );
  ok("member list shows both users");

  // ---- both join voice, mesh signaling completes ----------------------------------
  await pageA.click("#voice-channels .chan-row.voice");
  await pageA.waitForSelector("#voice-status:not(.hidden)", { timeout: 10000 });
  await pageB.click("#voice-channels .chan-row.voice");
  await pageB.waitForSelector("#voice-status:not(.hidden)", { timeout: 10000 });
  for (const [page, name] of [[pageA, "A"], [pageB, "B"]]) {
    await page.waitForFunction(() => document.querySelectorAll(".voice-user").length >= 2, {
      timeout: 15000,
    });
    ok(`${name} sees both users in the voice channel`);
  }
  // Give the mesh a beat, then verify a live peer connection got audio flowing:
  // remote audio elements exist on both sides once ontrack fired.
  for (const [page, name] of [[pageA, "A"], [pageB, "B"]]) {
    await page.waitForFunction(
      () => [...document.querySelectorAll("audio")].some((a) => a.srcObject),
      { timeout: 20000 }
    );
    ok(`${name} received a remote WebRTC audio track`);
  }

  // ---- typing indicator -------------------------------------------------------------
  await pageB.locator("#input").pressSequentially("still typing this out", { delay: 30 });
  await pageA.waitForFunction(
    () => document.querySelector("#typing-bar")?.textContent.includes("typing"),
    { timeout: 8000 }
  );
  ok("typing indicator shows on the other side");

  // ---- console/page errors ------------------------------------------------------------
  const realErrors = [...errorsA, ...errorsB].filter(
    (e) => !/favicon|Autoplay|net::ERR_/i.test(e)
  );
  if (realErrors.length) bad("zero console/page errors", realErrors.join(" | "));
  else ok("no console or page errors on either client");
} catch (err) {
  bad("e2e flow", err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nE2E: ALL CHECKS PASSED");
