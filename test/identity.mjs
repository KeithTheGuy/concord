// Identity must be stable for one person in one browser, even across two
// tabs on the same invite link and across reloads. If it isn't, you silently
// lose the ability to edit/delete your own messages and un-toggle your own
// reactions — the app looks fine and just stops obeying you.
// Usage: node test/identity.mjs [baseUrl]

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

// The edit button is only rendered on messages the client believes are its own.
const ownsLastMessage = (page) =>
  page.evaluate(() => {
    const msgs = [...document.querySelectorAll("#messages .msg")];
    const last = msgs[msgs.length - 1];
    return !!last && !!last.querySelector('.msg-actions button[aria-label="Edit"]');
  });

const browser = await chromium.launch();
// One context = one localStorage = one person.
const ctx = await browser.newContext();

try {
  const tab1 = await ctx.newPage();
  await tab1.goto(base);
  await tab1.waitForSelector("#onboard-modal:not(.hidden)", { timeout: 10000 });
  await tab1.fill("#ob-name", "Twin Tabs");
  await tab1.click("#ob-done");
  await tab1.waitForSelector("#join-modal:not(.hidden)");
  await tab1.fill("#jm-create-name", "Identity Test");
  await tab1.click("#jm-create");
  await tab1.waitForSelector("#invite-modal:not(.hidden)", { timeout: 10000 });
  const code = (await tab1.textContent("#invite-code")).trim();
  await tab1.click("#invite-modal .modal-close");
  await tab1.waitForSelector("#app:not(.hidden)");

  // Second tab, same browser, same invite link — the double-click case.
  const tab2 = await ctx.newPage();
  await tab2.goto(`${base}/?join=${code}`);
  await tab2.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  ok("second tab joined the same server in the same browser");

  await tab1.bringToFront();
  await tab1.fill("#input", "posted from tab one");
  await tab1.press("#input", "Enter");
  await tab1.waitForSelector("#messages .msg:not(.pending)", { timeout: 10000 });
  if (!(await ownsLastMessage(tab1))) bad("tab 1 owns the message it just sent");
  else ok("tab 1 owns the message it just sent");

  await tab2.waitForFunction(
    () => document.querySelector("#messages")?.textContent.includes("posted from tab one"),
    { timeout: 10000 }
  );
  if (!(await ownsLastMessage(tab2)))
    bad("tab 2 recognises the same person's message as its own", "second tab was given a different identity");
  else ok("tab 2 recognises the same person's message as its own");

  await tab1.reload();
  await tab1.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  await tab1.waitForFunction(
    () => document.querySelector("#messages")?.textContent.includes("posted from tab one"),
    { timeout: 10000 }
  );
  if (!(await ownsLastMessage(tab1)))
    bad("identity survives a reload", "the user can no longer edit their own message");
  else ok("identity survives a reload");

  // And the stored identity is the one the server assigned, not a stale one.
  const stored = await tab1.evaluate((c) => {
    const ids = JSON.parse(localStorage.getItem("concord-identities") || "{}");
    return ids[c] || null;
  }, code);
  if (!stored?.userId || !stored?.token) bad("per-server identity is stored", JSON.stringify(stored));
  else ok("per-server identity {userId, token} is persisted");
} catch (err) {
  bad("identity flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nIDENTITY: ALL CHECKS PASSED");
