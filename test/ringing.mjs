// Can you call a friend? Two real Chromium contexts, a real friendship, and a
// real WebRTC call — Alice hits 📞 and we check that Bob's screen actually
// lights up, that the ring survives longer than an ordinary toast, that Ignore
// hushes without locking him out, and that answering connects them.
//
// The last block is the negative half and matters just as much: a server voice
// channel must NOT ring. People wander in and out of those all day.
//
// Usage: node test/ringing.mjs [baseUrl]   (default http://127.0.0.1:4189)

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

async function newUser(name) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["microphone"],
  });
  const page = await ctx.newPage();
  // A stubbed Notification so the desktop path is observable rather than
  // silently skipped — notificationsReady() refuses to fire without it.
  await page.addInitScript(() => {
    localStorage.setItem("concord-settings", JSON.stringify({ notifs: true }));
    window.__notifs = [];
    window.Notification = class {
      constructor(title, opts) {
        this.title = title;
        this.opts = opts;
        this.closed = false;
        window.__notifs.push(this);
      }
      close() {
        this.closed = true;
      }
      static requestPermission() {
        return Promise.resolve("granted");
      }
    };
    window.Notification.permission = "granted";
  });
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

// The tag only exists once the hub socket has delivered hub-welcome, which is a
// different connection from the realm the UI is already showing.
const tagOf = (u) =>
  u.page
    .waitForFunction(() => window.__concord.hub.me?.tag || null, null, { timeout: 15000 })
    .then((h) => h.jsonValue());

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

const callTitle = (u) => u.page.getAttribute("#btn-call", "title");

try {
  const alice = await newUser("Ring Alice");
  const bob = await newUser("Ring Bob");
  await onboard(alice);
  await onboard(bob);
  await befriend(alice, bob);
  ok("Alice and Bob are friends");

  /* ------------------- Bob has the DM open, then wanders off ---------------- */
  // The realistic case: he opened it earlier, so the socket is live, but he's
  // looking at the friends list when the call lands.
  await bob.page.click(`.dm-row:has-text("${alice.name}")`);
  await bob.page.waitForSelector("#chat-view:not(.hidden)");
  await bob.page.waitForFunction(
    () => window.__concord.R()?.channels.some((c) => c.type === "voice"),
    undefined,
    { timeout: 12000 }
  );
  await bob.page.click("#home-btn");

  const idleTitle = await callTitle(bob);
  if (idleTitle !== "Start a voice call") bad("an empty DM offers to start a call", idleTitle);
  else ok("an empty DM offers to start a call");

  /* -------------------------------- the call ------------------------------- */
  await alice.page.click(`.dm-row:has-text("${bob.name}")`);
  await alice.page.waitForSelector("#chat-view:not(.hidden)");
  await alice.page.waitForFunction(
    () => window.__concord.R()?.channels.some((c) => c.type === "voice"),
    undefined,
    { timeout: 12000 }
  );
  await alice.page.click("#btn-call");
  await alice.page.waitForSelector("#voice-status:not(.hidden)", { timeout: 15000 });
  ok("Alice is in the call");

  await bob.page.waitForSelector(".ring-toast", { timeout: 15000 }).catch(() => {});
  const ringText = await bob.page.textContent(".ring-toast").catch(() => "");
  if (!ringText.includes(`${alice.name} is calling`)) bad("Bob sees a ring toast", ringText || "(none)");
  else ok("Bob sees a ring toast naming the caller");

  for (const label of ["Join", "Ignore"]) {
    if (!(await bob.page.locator(`.ring-toast button:has-text("${label}")`).count())) {
      bad(`ring toast offers ${label}`);
    } else ok(`ring toast offers ${label}`);
  }

  const notif = await bob.page.evaluate(() => window.__notifs.map((n) => n.title));
  if (!notif.some((t) => t.includes("is calling"))) bad("a desktop notification fired", JSON.stringify(notif));
  else ok("a desktop notification fired");

  const pill = bob.page.locator(`.dm-row:has-text("${alice.name}") .dm-call`);
  if (!(await pill.count())) bad("a call pill appears on Bob's DM row");
  else {
    const txt = (await pill.textContent()).trim();
    if (txt !== "🔊 1") bad("call pill counts the people in the call", txt);
    else ok("a green 🔊 1 pill appears on Bob's DM row");
  }

  const badge = await bob.page.evaluate(() => {
    const b = document.getElementById("home-badge");
    return { text: b.textContent, hidden: b.classList.contains("hidden"), ring: b.classList.contains("ringing") };
  });
  if (badge.hidden || badge.text !== "📞" || !badge.ring) bad("home badge rings", JSON.stringify(badge));
  else ok("home badge shows 📞");

  const title = await bob.page.title();
  if (title !== "(📞) Concord") bad("tab title flies the call flag", title);
  else ok("tab title reads (📞) Concord");

  /* --------------------------- it must not time out ------------------------ */
  // Every other toast in the app dies at 4s. A missed call is worse than noise.
  await bob.page.waitForTimeout(6000);
  if (!(await bob.page.locator(".ring-toast").count())) bad("the ring is persistent (survives 6s)");
  else ok("the ring is persistent — still up after 6s");

  /* ------------------------------ the button ------------------------------- */
  await bob.page.click(`.dm-row:has-text("${alice.name}")`);
  await bob.page.waitForSelector("#chat-view:not(.hidden)");
  const joinTitle = await callTitle(bob);
  if (joinTitle !== "Join call · 1") bad('#btn-call reads "Join call · 1"', joinTitle);
  else ok('#btn-call reads "Join call · 1"');

  /* -------------------------------- Ignore --------------------------------- */
  await bob.page.click('.ring-toast button:has-text("Ignore")');
  await bob.page.waitForTimeout(400);
  if (await bob.page.locator(".ring-toast").count()) bad("Ignore takes the ring down");
  else ok("Ignore takes the ring down");
  if ((await bob.page.title()) === "(📞) Concord") bad("Ignore clears the tab flag");
  else ok("Ignore clears the tab flag");
  if (!(await bob.page.locator(`.dm-row:has-text("${alice.name}") .dm-call`).count())) {
    bad("the call pill survives Ignore — the call is still happening");
  } else ok("the call pill survives Ignore");
  if ((await callTitle(bob)) !== "Join call · 1") bad("Ignore leaves the button able to join");
  else ok("Ignore leaves the button able to join");

  /* -------------------------------- answering ------------------------------ */
  await bob.page.click("#btn-call");
  await bob.page.waitForSelector("#voice-status:not(.hidden)", { timeout: 20000 });
  ok("Bob joins the call from the button");

  // Two people in one call, as seen from both ends — the count comes off the
  // member list, so this is the server agreeing they're in the same room.
  for (const u of [alice, bob]) {
    await u.page
      .waitForFunction(() => document.getElementById("btn-call").title.endsWith("· 2"), undefined, {
        timeout: 15000,
      })
      .catch(() => {});
    const t = await callTitle(u);
    if (t !== "Leave the call · 2") bad(`${u.name} sees both people in the call`, t);
    else ok(`${u.name} sees both people in the call`);
  }

  // And real audio actually flowed, so "joined" isn't just bookkeeping.
  for (const u of [alice, bob]) {
    await u.page
      .waitForFunction(() => [...document.querySelectorAll("audio")].some((a) => a.srcObject), undefined, {
        timeout: 25000,
      })
      .catch(() => {});
    if (!(await u.page.evaluate(() => [...document.querySelectorAll("audio")].some((a) => a.srcObject)))) {
      bad(`${u.name} received a remote audio track`);
    } else ok(`${u.name} received a remote audio track`);
  }

  /* ------------------------------- hanging up ------------------------------ */
  await bob.page.click("#btn-call");
  await bob.page.waitForTimeout(1200);
  if ((await callTitle(bob)) !== "Join call · 1") bad("leaving puts Bob back to Join", await callTitle(bob));
  else ok("leaving puts Bob back to Join");
  // Leaving must not ring you straight back at the person still sitting in it.
  if (await bob.page.locator(".ring-toast").count()) bad("leaving a call doesn't ring you back into it");
  else ok("leaving a call doesn't ring you back into it");

  await alice.page.click("#btn-call");
  await bob.page
    .waitForFunction(() => document.getElementById("btn-call").title === "Start a voice call", undefined, {
      timeout: 15000,
    })
    .catch(() => {});
  if ((await callTitle(bob)) !== "Start a voice call") bad("an empty call resets the button", await callTitle(bob));
  else ok("an empty call resets the button");
  if (await bob.page.locator(`.dm-row:has-text("${alice.name}") .dm-call`).count()) {
    bad("the pill goes away when everyone hangs up");
  } else ok("the pill goes away when everyone hangs up");

  /* ------------------------- a hushed call rings again --------------------- */
  // Ignore silenced *that* call, not Alice forever.
  await alice.page.click("#btn-call");
  await bob.page.waitForSelector(".ring-toast", { timeout: 15000 }).catch(() => {});
  if (!(await bob.page.locator(".ring-toast").count())) bad("a later call rings again after an Ignore");
  else ok("a later call rings again after an Ignore");
  await bob.page.click('.ring-toast button:has-text("Ignore")');
  await alice.page.click("#btn-call"); // Alice hangs up
  await bob.page.waitForTimeout(1200);

  /* ---------------------------------- DND ---------------------------------- */
  // Do Not Disturb drops the noise, not the news: no desktop notification and
  // no cue, but the toast and pill stay so you can still tell you were called.
  await bob.page.evaluate(() => {
    window.__concord.state.settings.presence = "dnd";
    window.__notifs.length = 0;
  });
  await alice.page.click("#btn-call");
  await bob.page.waitForSelector(".ring-toast", { timeout: 15000 }).catch(() => {});
  if (!(await bob.page.locator(".ring-toast").count())) bad("DND still shows the ring");
  else ok("DND still shows the ring");
  if (!(await bob.page.locator(`.dm-row:has-text("${alice.name}") .dm-call`).count())) {
    bad("DND still shows the pill");
  } else ok("DND still shows the pill");
  if (await bob.page.evaluate(() => window.__notifs.length)) {
    bad("DND suppresses the desktop notification");
  } else ok("DND suppresses the desktop notification");
  await bob.page.click('.ring-toast button:has-text("Ignore")');
  await alice.page.click("#btn-call"); // Alice hangs up again
  await bob.page.evaluate(() => (window.__concord.state.settings.presence = "online"));
  await bob.page.waitForTimeout(1200);

  /* --------------------- server voice must stay quiet ---------------------- */
  await alice.page.evaluate(() => {
    document.getElementById("home-btn").click();
  });
  await alice.page.waitForTimeout(300);
  await alice.page.click("#add-server-btn");
  await alice.page.waitForSelector("#join-modal:not(.hidden)", { timeout: 10000 });
  await alice.page.fill("#jm-create-name", "Ring Test Server");
  await alice.page.click("#jm-create");
  await alice.page.waitForSelector("#invite-modal:not(.hidden)", { timeout: 15000 });
  const invite = (await alice.page.textContent("#invite-code")).trim();
  await alice.page.click("#invite-modal .modal-close");

  await bob.page.goto(`${base}/?join=${invite}`);
  await bob.page.waitForSelector("#app:not(.hidden)", { timeout: 20000 });
  await bob.page.waitForFunction(
    () => document.querySelector("#voice-channels .chan-row.voice"),
    undefined,
    { timeout: 15000 }
  );
  await alice.page.click("#voice-channels .chan-row.voice");
  await alice.page.waitForSelector("#voice-status:not(.hidden)", { timeout: 15000 });
  await bob.page.waitForTimeout(2500);
  if (await bob.page.locator(".ring-toast").count()) bad("a server voice channel does not ring");
  else ok("a server voice channel does not ring");
  if ((await bob.page.title()).includes("📞")) bad("a server voice channel doesn't flag the tab");
  else ok("a server voice channel doesn't flag the tab");

  /* ---------------------------- console clean ------------------------------ */
  for (const u of [alice, bob]) {
    const real = u.errors.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js|Notification|ytimg/i.test(e));
    if (real.length) bad(`${u.name} had no console errors`, real.slice(0, 2).join(" | "));
    else ok(`${u.name} had no console errors`);
  }
} catch (err) {
  bad("ringing flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nRINGING: ALL CHECKS PASSED");
