// Group DMs across three browsers: create, everyone receives it, messages
// reach all members, unread fans out, adding and leaving work. Plus the
// loading splash and the hover toolbar.
// Usage: node test/groups.mjs

import { chromium } from "playwright";

const base = "http://127.0.0.1:4189";
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
  return { ctx, page, errors, name };
}

async function onboard(u) {
  await u.page.waitForSelector("#onboard-modal:not(.hidden)");
  await u.page.fill("#ob-name", u.name);
  await u.page.click("#ob-done");
  await u.page.waitForSelector("#join-modal:not(.hidden)");
  await u.page.click("#join-modal .modal-close");
}

// The tag only exists once the hub socket has delivered hub-welcome, which is
// a separate connection from the server realm the UI is already showing. Read
// it once and you get undefined on a slow run, which then surfaces as a
// baffling page.fill type error rather than as the timeout it really is.
const tagOf = (u) =>
  u.page.waitForFunction(() => window.__concord.hub.me?.tag || null, null, { timeout: 15000 })
    .then((h) => h.jsonValue());

// A drives the friendship with B, from A's side.
async function befriend(a, b) {
  const tag = await tagOf(b);
  await a.page.click("#home-btn");
  await a.page.click('#fv-tabs button[data-tab="add"]');
  await a.page.fill(".add-friend-row input", tag);
  await a.page.click(".add-friend-row .primary-btn");
  await b.page.click("#home-btn");
  await b.page.waitForSelector("#fv-pending-badge:not(.hidden)", { timeout: 10000 });
  await b.page.click('#fv-tabs button[data-tab="pending"]');
  await b.page.click(`.friend-row:has-text("${a.name}") button:has-text("Accept")`);
  await a.page.waitForSelector(`.dm-row:has-text("${b.name}")`, { timeout: 10000 });
}

try {
  /* ------------------------------- splash -------------------------------- */
  const first = await newUser("Keith");
  // The splash is markup, so it exists before any script has run.
  if (!(await first.page.locator("#splash").count())) bad("splash renders on first paint");
  else ok("splash renders on first paint");
  const animated = await first.page.evaluate(() => {
    const n = document.querySelector(".splash-ring");
    return n ? getComputedStyle(n).animationName : "none";
  });
  if (!animated || animated === "none") bad("splash is animated", animated);
  else ok(`splash is animated (${animated})`);

  await onboard(first);
  await first.page.waitForFunction(
    () => !document.getElementById("splash") || document.getElementById("splash").classList.contains("gone"),
    undefined,
    { timeout: 12000 }
  );
  ok("splash clears once the app is ready");

  const b = await newUser("Cole");
  const c = await newUser("Dapmon");
  await onboard(b);
  await onboard(c);

  /* ----------------------------- friendships ----------------------------- */
  await befriend(first, b);
  await befriend(first, c);
  ok("two friendships established");

  /* ------------------------------- groups -------------------------------- */
  await first.page.click("#home-btn");
  await first.page.click("#dm-group-btn");
  await first.page.waitForSelector("#group-modal:not(.hidden)");
  await first.page.fill("#gdm-name", "The Council");
  const boxes = first.page.locator("#gdm-friends input[type=checkbox]");
  const n = await boxes.count();
  for (let i = 0; i < n; i++) await boxes.nth(i).check();
  await first.page.click("#gdm-create");

  for (const u of [first, b, c]) {
    await u.page.waitForSelector('.dm-row:has-text("The Council")', { timeout: 12000 }).catch(() => {});
    if (!(await u.page.locator('.dm-row:has-text("The Council")').count())) {
      bad(`${u.name} sees the group in their DM list`);
    } else ok(`${u.name} sees the group in their DM list`);
  }

  const size = await first.page.evaluate(
    () => [...window.__concord.hub.groups.values()][0]?.members.length
  );
  if (size !== 3) bad("group has all three members", `got ${size}`);
  else ok("group has all three members");

  /* --------------------------- messages fan out -------------------------- */
  await first.page.click('.dm-row:has-text("The Council")');
  await first.page.waitForSelector("#chat-view:not(.hidden)");
  const header = await first.page.textContent("#chan-name");
  if (!header.includes("The Council")) bad("group name shows in the header", header);
  else ok("group name shows in the header");

  await first.page.fill("#input", "council is now in session");
  await first.page.press("#input", "Enter");
  await first.page.waitForSelector('.msg-content:has-text("council is now in session")', { timeout: 10000 });

  // Both others get an unread badge without ever opening it.
  for (const u of [b, c]) {
    await u.page
      .waitForSelector('.dm-row:has-text("The Council") .chan-badge', { timeout: 12000 })
      .catch(() => {});
    if (!(await u.page.locator('.dm-row:has-text("The Council") .chan-badge').count())) {
      bad(`${u.name} gets an unread badge for the group`);
    } else ok(`${u.name} gets an unread badge for the group`);
  }

  await b.page.click('.dm-row:has-text("The Council")');
  await b.page.waitForSelector('.msg-content:has-text("council is now in session")', { timeout: 12000 });
  ok("group history loads for another member");

  await b.page.fill("#input", "seconded");
  await b.page.press("#input", "Enter");
  await first.page.waitForSelector('.msg-content:has-text("seconded")', { timeout: 12000 });
  ok("group messages flow between members live");

  // Only friends can be pulled in — the hub enforces that, not the UI.
  const rejected = await first.page.evaluate(async () => {
    const app = window.__concord;
    const group = [...app.hub.groups.values()][0];
    const before = group.members.length;
    app.hub.addToGroup(group.id, "totally-made-up-uid");
    await new Promise((r) => setTimeout(r, 1200));
    return [...app.hub.groups.values()][0].members.length === before;
  });
  if (!rejected) bad("a bogus member id is refused");
  else ok("a bogus member id is refused");

  /* -------------------------------- leaving ------------------------------ */
  await c.page.evaluate(() => {
    const app = window.__concord;
    app.hub.leaveGroup([...app.hub.groups.values()][0].id);
  });
  await c.page.waitForFunction(() => window.__concord.hub.groups.size === 0, undefined, { timeout: 10000 });
  ok("leaving removes the group for that member");

  await first.page.waitForFunction(
    () => [...window.__concord.hub.groups.values()][0]?.members.length === 2,
    undefined,
    { timeout: 10000 }
  );
  ok("remaining members see the updated roster");

  /* --------------------------- hover toolbar ----------------------------- */
  await first.page.hover(".msg >> nth=0");
  await first.page.waitForTimeout(250);
  const toolbar = await first.page.evaluate(() => {
    const bar = document.querySelector(".msg .msg-actions");
    if (!bar) return null;
    const cs = getComputedStyle(bar);
    return { opacity: Number(cs.opacity), buttons: bar.querySelectorAll("button").length };
  });
  if (!toolbar || toolbar.opacity < 0.9) bad("hover toolbar appears", JSON.stringify(toolbar));
  else ok(`hover toolbar appears (${toolbar.buttons} actions)`);
  if (!(await first.page.locator('.msg-actions button[aria-label="Copy text"]').count())) {
    bad("hover toolbar has copy text");
  } else ok("hover toolbar has copy text");

  /* ---------------------------- console clean ---------------------------- */
  for (const u of [first, b, c]) {
    const real = u.errors.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js|Notification|ytimg/i.test(e));
    if (real.length) bad(`${u.name} had no console errors`, real.slice(0, 2).join(" | "));
    else ok(`${u.name} had no console errors`);
  }
} catch (err) {
  bad("group flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nGROUPS: ALL CHECKS PASSED");
