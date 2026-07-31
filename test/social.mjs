// Smoke test for the social layer: two independent browsers create accounts on
// the hub, exchange a friend request, become friends, and DM each other.
// Also checks the things most likely to be silently broken by the rewrite:
// no console errors on boot, the emoji button is to the RIGHT of the textbox,
// and slash commands / mentions / spoilers actually render.
// Usage: node test/social.mjs [baseUrl]

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

const browser = await chromium.launch();

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(base);
  await page.waitForSelector("#onboard-modal:not(.hidden)");
  await page.fill("#ob-name", name);
  await page.click("#ob-done");
  return { ctx, page, errors };
}

try {
  const a = await newUser("Keith");
  const b = await newUser("Cole");

  // Both land on the join modal (no servers yet); close it and go home.
  for (const u of [a, b]) {
    await u.page.waitForSelector("#join-modal:not(.hidden)");
    await u.page.click("#join-modal .modal-close");
  }

  // --- accounts + tags ---------------------------------------------------
  const tagOf = async (u) => {
    await u.page.click("#home-btn");
    await u.page.click('#fv-tabs button[data-tab="add"]');
    await u.page.waitForSelector(".your-tag b");
    return (await u.page.textContent(".your-tag b")).replace("@", "").trim();
  };
  const tagA = await tagOf(a);
  const tagB = await tagOf(b);
  if (!tagA || tagA === "…") bad("hub issues a friend tag");
  else ok(`hub issued tags (@${tagA}, @${tagB})`);
  if (tagA === tagB) bad("tags are unique per account");
  else ok("tags are unique per account");

  // --- friend request ----------------------------------------------------
  await a.page.fill(".add-friend-row input", tagB);
  await a.page.click(".add-friend-row .primary-btn");

  await b.page.waitForSelector("#fv-pending-badge:not(.hidden)", { timeout: 8000 }).catch(() => {});
  await b.page.click('#fv-tabs button[data-tab="pending"]');
  const gotRequest = await b.page.locator(".friend-row", { hasText: "Keith" }).count();
  if (!gotRequest) bad("incoming request reaches the other account");
  else ok("incoming request reaches the other account");

  await b.page.click('.friend-row button:has-text("Accept")');

  for (const [u, who] of [[a, "Cole"], [b, "Keith"]]) {
    await u.page.waitForSelector(`.dm-row:has-text("${who}")`, { timeout: 8000 }).catch(() => {});
    const listed = await u.page.locator(`.dm-row:has-text("${who}")`).count();
    if (!listed) bad(`${who} appears in the DM list after accepting`);
    else ok(`${who} appears in the DM list after accepting`);
  }

  // --- DM round trip -----------------------------------------------------
  await a.page.click('.dm-row:has-text("Cole")');
  await a.page.waitForSelector("#chat-view:not(.hidden)");
  await a.page.fill("#input", "yo this actually works");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector('.msg-content:has-text("yo this actually works")', { timeout: 8000 });
  ok("DM sends from the first account");

  // B should get an unread badge without ever opening the conversation.
  await b.page.waitForSelector(".dm-row .chan-badge", { timeout: 8000 }).catch(() => {});
  if (!(await b.page.locator(".dm-row .chan-badge").count())) bad("unread badge appears for the recipient");
  else ok("unread badge appears for the recipient");

  await b.page.click('.dm-row:has-text("Keith")');
  await b.page.waitForSelector('.msg-content:has-text("yo this actually works")', { timeout: 10000 });
  ok("DM history loads for the recipient");

  await b.page.fill("#input", "it does. spooky");
  await b.page.press("#input", "Enter");
  await a.page.waitForSelector('.msg-content:has-text("it does. spooky")', { timeout: 8000 });
  ok("DM replies flow back live");

  // --- markdown / commands ----------------------------------------------
  await a.page.fill("#input", "||secret||");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector(".spoiler", { timeout: 8000 });
  ok("spoilers render");

  await a.page.fill("#input", "/shrug well");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector('.msg-content:has-text("¯")', { timeout: 8000 });
  ok("slash commands rewrite the message");

  await a.page.fill("#input", "hey @Cole look");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector(".mention", { timeout: 8000 });
  ok("mentions highlight");

  // --- dapmon's demand ---------------------------------------------------
  const geom = await a.page.evaluate(() => {
    const box = document.getElementById("input").getBoundingClientRect();
    const emoji = document.getElementById("btn-emoji").getBoundingClientRect();
    return { inputRight: box.right, emojiLeft: emoji.left };
  });
  if (geom.emojiLeft < geom.inputRight) bad("emoji button sits to the RIGHT of the textbox", JSON.stringify(geom));
  else ok("emoji button sits to the RIGHT of the textbox");

  // --- console cleanliness ----------------------------------------------
  for (const [u, who] of [[a, "Keith"], [b, "Cole"]]) {
    const real = u.errors.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js/i.test(e));
    if (real.length) bad(`${who} booted without console errors`, real.slice(0, 2).join(" | "));
    else ok(`${who} booted without console errors`);
  }
} catch (err) {
  bad("social flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSOCIAL: ALL CHECKS PASSED");
