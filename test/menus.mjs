// Right-click menus, message links, per-channel mute, and the settings nav.
//
// The load-bearing block is the last one. A call can now reach a DM you have
// not opened this session — which, after any page reload, is most of them —
// and the only honest way to test that is with a recipient who has genuinely
// never touched the conversation. So Bob's realm map is asserted empty right
// before Alice dials, and the ring that follows can only have come through the
// hub's wake-up.
//
// The rest is the review's other three findings: a message had no context menu
// and no shareable anchor, "unread" was a state you could leave four ways and
// enter none, mute was server-wide or nothing, and Settings was 1643px of
// content with nothing to steer by.
//
// Usage: node test/menus.mjs [baseUrl]   (default http://127.0.0.1:4189)

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

const allErrors = [];

async function newUser(name, { width = 1400, height = 900 } = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: ["microphone", "clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`${name}: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`${name}: ${e}`));
  allErrors.push(errors);
  return { ctx, page, name, errors };
}

async function onboard(u, url = base) {
  await u.page.goto(url);
  await u.page.waitForSelector("#onboard-modal:not(.hidden)");
  await u.page.fill("#ob-name", u.name);
  await u.page.click("#ob-done");
}

async function createServer(u, name) {
  await u.page.waitForSelector("#join-modal:not(.hidden)");
  await u.page.fill("#jm-create-name", name);
  await u.page.click("#jm-create");
  await u.page.waitForSelector("#invite-modal:not(.hidden)", { timeout: 20000 });
  const code = (await u.page.textContent("#invite-code")).trim();
  await u.page.click("#invite-modal .modal-close");
  await u.page.waitForSelector("#chat-view:not(.hidden)");
  return code;
}

async function say(page, text) {
  await page.fill("#input", text);
  await page.press("#input", "Enter");
  await page.waitForSelector(`.msg:has-text("${text}"):not(.pending)`, { timeout: 15000 });
}

// The document click handler closes menus, so every assertion about one has to
// read it while it is still up.
const menuLabels = (page) =>
  page.$$eval("#ctx-menu button", (bs) => bs.map((b) => b.textContent.trim()));

const clickMenu = (page, label) => page.click(`#ctx-menu button:has-text("${label}")`);

const lastToast = (page) =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll("#toasts .toast:not(.ring-toast)")];
    return all.length ? all[all.length - 1].textContent.trim() : "";
  });

const tagOf = (u) =>
  u.page
    .waitForFunction(() => window.__concord.hub.me?.tag || null, null, { timeout: 20000 })
    .then((h) => h.jsonValue());

async function befriend(a, b) {
  const tag = await tagOf(b);
  await a.page.click("#home-btn");
  await a.page.click('#fv-tabs button[data-tab="add"]');
  await a.page.fill(".add-friend-row input", tag);
  await a.page.click(".add-friend-row .primary-btn");
  await b.page.click("#home-btn");
  await b.page.waitForSelector("#fv-pending-badge:not(.hidden)", { timeout: 15000 });
  await b.page.click('#fv-tabs button[data-tab="pending"]');
  await b.page.click(`.friend-row:has-text("${a.name}") button:has-text("Accept")`);
  await a.page.waitForSelector(`.dm-row:has-text("${b.name}")`, { timeout: 15000 });
}

try {
  /* =================== 1. a message answers a right-click ================= */

  const keith = await newUser("Menu Keith");
  await onboard(keith);
  const code = await createServer(keith, "The Hangout");
  await say(keith.page, "remember this one");
  ok("a server with a message in it");

  await keith.page.click('.msg:has-text("remember this one")', { button: "right" });
  await keith.page.waitForSelector("#ctx-menu:not(.hidden)");
  const items = await menuLabels(keith.page);
  const WANTED = [
    "↩ Reply",
    "😀 Add Reaction…",
    "📌 Pin",
    "📋 Copy Text",
    "🔗 Copy Message Link",
    "📩 Mark As Unread",
    "✏ Edit Message",
    "🗑 Delete Message",
  ];
  const missing = WANTED.filter((w) => !items.includes(w));
  if (missing.length) bad("the message menu offers everything the toolbar does", missing.join(", "));
  else ok(`the message menu offers all ${WANTED.length} actions (${items.length} items)`);

  /* ====================== 2. a link to one message ======================= */

  const msgId = await keith.page.getAttribute('.msg:has-text("remember this one")', "data-id");
  await clickMenu(keith.page, "🔗 Copy Message Link");
  await keith.page.waitForTimeout(300);
  const link = await keith.page.evaluate(() => navigator.clipboard.readText());
  const expected = `${base}/?join=${code}&c=c1&m=${msgId}`;
  if (link !== expected) bad("the link names the server, the channel and the message", `${link} != ${expected}`);
  else ok(`copied ?join=${code}&c=c1&m=${msgId}`);
  const note = await lastToast(keith.page);
  if (!note.includes("opens right on this message")) bad("copying says what the link does", note);
  else ok(`the copy toast reads "${note}"`);

  /* ---- and a stranger who follows it lands on that message -------------- */

  const visitor = await newUser("Menu Visitor");
  await onboard(visitor, link);
  await visitor.page.waitForSelector("#chat-view:not(.hidden)", { timeout: 25000 });
  await visitor.page
    .waitForSelector(`.msg[data-id="${msgId}"]`, { timeout: 20000 })
    .catch(() => {});
  const landed = await visitor.page.evaluate(
    (id) => ({
      chan: window.__concord.R()?.activeChan,
      here: !!document.querySelector(`.msg[data-id="${id}"]`),
      code: window.__concord.R()?.code,
    }),
    msgId
  );
  if (landed.code !== code || landed.chan !== "c1" || !landed.here) {
    bad("following a message link lands on that message", JSON.stringify(landed));
  } else ok("a fresh browser follows the link: joins the server, opens #general, finds the message");

  /* ---- and says so plainly when the message has aged out ---------------- */

  const stale = await newUser("Menu Stale");
  await onboard(stale, `${base}/?join=${code}&c=c1&m=999999999`);
  await stale.page.waitForSelector("#chat-view:not(.hidden)", { timeout: 25000 });
  await stale.page.waitForTimeout(2500);
  const staleNote = await lastToast(stale.page);
  const staleChan = await stale.page.evaluate(() => window.__concord.R()?.activeChan);
  if (!staleNote.includes("aged out")) bad("a dead link says so", staleNote || "(no toast)");
  else if (staleChan !== "c1") bad("a dead link still lands in the right channel", staleChan);
  else ok("a link to a message that aged out still opens the channel, and says why it stopped there");
  await stale.ctx.close();

  /* ==================== 3. marking a message unread ====================== */

  await keith.page.click('.msg:has-text("remember this one")', { button: "right" });
  await keith.page.waitForSelector("#ctx-menu:not(.hidden)");
  await clickMenu(keith.page, "📩 Mark As Unread");
  await keith.page.waitForSelector(".unread-divider", { timeout: 5000 }).catch(() => {});
  const divider = await keith.page.textContent(".unread-divider").catch(() => "");
  if (divider !== "NEW MESSAGES") bad("the NEW MESSAGES line lands on it", divider || "(no divider)");
  else ok("Mark As Unread draws the NEW MESSAGES line on that message");
  const badge = await keith.page.textContent("#text-channels .chan-row .chan-badge").catch(() => "");
  if (!badge) bad("the channel gets its unread badge back");
  else ok(`the channel badge comes back reading ${badge}`);

  // The automatic line clears when you leave a channel. One you put there
  // yourself has to still be there when you come back, or it was pointless.
  // 💬 only appears on hover, so this has to be a real pointer, not a click at
  // a selector.
  const voiceRow = keith.page.locator("#voice-channels .chan-row.voice").first();
  await voiceRow.hover();
  await voiceRow.locator(".chan-chat").click();
  await keith.page.waitForTimeout(400);
  await keith.page.click("#text-channels .chan-row >> nth=0");
  await keith.page.waitForTimeout(500);
  if (!(await keith.page.locator(".unread-divider").count())) {
    bad("a deliberate unread survives leaving the channel and coming back");
  } else ok("the line is still there after leaving the channel and coming back");

  /* ================= 4. right-clicking a channel row ===================== */

  await keith.page.click("#text-channels .chan-row >> nth=0", { button: "right" });
  await keith.page.waitForSelector("#ctx-menu:not(.hidden)");
  const chanItems = await menuLabels(keith.page);
  const WANT_CHAN = ["Mark As Read", "🔕 Mute Channel", "Rename Channel", "Move to Category…", "Delete Channel"];
  const chanMissing = WANT_CHAN.filter((w) => !chanItems.includes(w));
  if (chanMissing.length) bad("the channel menu offers the gear's items plus the new two", chanMissing.join(", "));
  else ok(`right-clicking a channel offers all ${WANT_CHAN.length} items`);

  await clickMenu(keith.page, "🔕 Mute Channel");
  await keith.page.waitForTimeout(400);
  const muteNote = await lastToast(keith.page);
  if (muteNote !== "🔕 #general muted — still unread, just quiet.") bad("the channel mute copy", muteNote);
  else ok(`muting a channel says "${muteNote}"`);

  const muteState = await keith.page.evaluate(() => ({
    keys: Object.keys(window.__concord.state.settings.muted || {}),
    row: !!document.querySelector("#text-channels .chan-row.muted"),
  }));
  if (!muteState.keys.includes(`${code}/c1`)) bad("mute is keyed code/chanId", JSON.stringify(muteState.keys));
  else if (!muteState.row) bad("a muted channel row says so");
  else ok(`mute stored as "${code}/c1" and the row is dimmed — the server itself is untouched`);

  // Mark As Read is the other half, and it clears only this channel.
  await keith.page.click("#text-channels .chan-row >> nth=0", { button: "right" });
  await keith.page.waitForSelector("#ctx-menu:not(.hidden)");
  await clickMenu(keith.page, "Mark As Read");
  await keith.page.waitForTimeout(300);
  if (await keith.page.locator(".unread-divider").count()) bad("Mark As Read takes the line back down");
  else ok("Mark As Read on the same channel clears it again");

  // Unmuting is the same menu, saying the opposite.
  await keith.page.click("#text-channels .chan-row >> nth=0", { button: "right" });
  await keith.page.waitForSelector("#ctx-menu:not(.hidden)");
  const unmuteThere = (await menuLabels(keith.page)).includes("🔔 Unmute Channel");
  await clickMenu(keith.page, "🔔 Unmute Channel");
  await keith.page.waitForTimeout(300);
  const stillMuted = await keith.page.evaluate(
    (c) => !!window.__concord.state.settings.muted?.[`${c}/c1`],
    code
  );
  if (!unmuteThere || stillMuted) bad("a muted channel offers to unmute", `offered=${unmuteThere} muted=${stillMuted}`);
  else ok("a muted channel offers Unmute, and it takes");

  /* ==================== 5. Settings has somewhere to go ================== */

  await keith.page.click("#btn-settings");
  await keith.page.waitForSelector("#settings-modal:not(.hidden)");
  const nav = await keith.page.$$eval("#set-nav button", (bs) => bs.map((b) => b.textContent.trim()));
  const WANT_NAV = ["🙂 Profile", "🎙️ Voice & Video", "🔔 Notifications", "🎨 Appearance", "💾 Backup"];
  if (JSON.stringify(nav) !== JSON.stringify(WANT_NAV)) bad("five sections, in order", JSON.stringify(nav));
  else ok("Settings has a nav: Profile · Voice & Video · Notifications · Appearance · Backup");

  const onProfile = await keith.page.isVisible("#set-name");
  const gateHidden = !(await keith.page.isVisible("#set-gate"));
  if (!onProfile || !gateHidden) bad("it opens on Profile, one section at a time", `name=${onProfile} gateHidden=${gateHidden}`);
  else ok("it opens on Profile and shows only Profile");

  // voiceui.js injects into whichever section holds #set-mic, and every one of
  // those controls used to be below the fold of the second column.
  await keith.page.click('#set-nav button:has-text("Voice & Video")');
  await keith.page.waitForTimeout(200);
  const voiceBits = {};
  for (const id of ["set-mic", "set-gate", "set-meter", "set-output", "set-output-test", "set-share-q", "set-stereo"]) {
    voiceBits[id] = await keith.page.isVisible("#" + id);
  }
  const unseen = Object.entries(voiceBits).filter(([, v]) => !v).map(([k]) => k);
  if (unseen.length) bad("the Voice section carries voiceui's controls", unseen.join(", "));
  else ok("Voice & Video shows the noise gate, the live meter, output device, test tone, share quality and stereo");

  const tall = await keith.page.evaluate(() => document.getElementById("settings-modal").scrollHeight);
  if (tall > 1100) bad("a section fits in a modal", `${tall}px tall`);
  else ok(`the tallest visible section is ${tall}px, not 1643`);

  await keith.page.click("#settings-modal .modal-close");

  /* ============== 6. and works on a phone, as a strip ==================== */

  const phone = await newUser("Menu Phone", { width: 390, height: 844 });
  await onboard(phone);
  await createServer(phone, "Pocket");
  await phone.page.click("#nav-toggle");
  await phone.page.click("#btn-settings");
  await phone.page.waitForSelector("#settings-modal:not(.hidden)");
  const strip = await phone.page.evaluate(() => {
    const nav = document.getElementById("set-nav");
    const bs = [...nav.querySelectorAll("button")];
    return {
      horizontal: bs.length > 1 && bs[1].getBoundingClientRect().y === bs[0].getBoundingClientRect().y,
      reachable: bs.every((b) => b.getBoundingClientRect().width > 0),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  if (!strip.horizontal) bad("the nav is a horizontal strip at 390px");
  else if (!strip.reachable) bad("every section is reachable at 390px");
  else if (strip.overflow > 0) bad("the strip doesn't push the page sideways", `${strip.overflow}px`);
  else ok("at 390px the nav is a swipeable strip and nothing overflows");

  await phone.page.click('#set-nav button:has-text("Voice & Video")');
  await phone.page.waitForTimeout(200);
  if (!(await phone.page.isVisible("#set-gate"))) bad("the noise gate is reachable on a phone");
  else ok("two taps from anywhere in the app to the noise gate, on a phone");
  await phone.ctx.close();

  /* ================ 7. a call reaches a DM nobody opened ================= */

  const alice = await newUser("Wake Alice");
  const bob = await newUser("Wake Bob");
  await onboard(alice);
  await alice.page.waitForSelector("#join-modal:not(.hidden)");
  await alice.page.click("#join-modal .modal-close");
  await onboard(bob);
  await bob.page.waitForSelector("#join-modal:not(.hidden)");
  await bob.page.click("#join-modal .modal-close");
  await befriend(alice, bob);
  ok("Alice and Bob are friends");

  // A reload is what makes this the ordinary case rather than an exotic one:
  // after it Bob has the friendship and the DM code, and no socket to the
  // conversation at all.
  await bob.page.reload();
  await bob.page.waitForSelector("#app:not(.hidden)", { timeout: 20000 });
  await bob.page.waitForFunction(() => window.__concord.hub.friends.size > 0, null, { timeout: 20000 });
  const dmCode = await bob.page.evaluate(() => [...window.__concord.hub.dmCodes.values()][0] || null);
  const cold = await bob.page.evaluate(
    (c) => !window.__concord.state.realms.has(c),
    dmCode
  );
  if (!dmCode) bad("Bob has the DM code from hub-welcome");
  else if (!cold) bad("Bob has never opened the DM", "a realm for it already exists");
  else ok(`Bob knows the DM code (${dmCode}) and has no connection to it — nothing there can ring him`);

  await alice.page.click(`.dm-row:has-text("${bob.name}")`);
  await alice.page.waitForSelector("#chat-view:not(.hidden)");
  await alice.page.waitForFunction(
    () => window.__concord.R()?.channels.some((c) => c.type === "voice"),
    undefined,
    { timeout: 20000 }
  );
  await alice.page.click("#btn-call");
  await alice.page.waitForSelector("#voice-status:not(.hidden)", { timeout: 20000 });

  await bob.page.waitForSelector(".ring-toast", { timeout: 25000 }).catch(() => {});
  const ring = await bob.page.textContent(".ring-toast").catch(() => "");
  if (!ring.includes(`${alice.name} is calling`)) bad("Bob rings for a DM he never opened", ring || "(no ring)");
  else ok("Bob rings, by name — the hub woke the conversation and the ring came off its own membership");

  const woke = await bob.page.evaluate((c) => {
    const r = window.__concord.state.realms.get(c);
    return { open: r?.wsState, woken: !!r?.wokenAt, peer: r?.peer?.name || null };
  }, dmCode);
  if (woke.open !== "open" || !woke.woken) bad("the wake-up is what opened it", JSON.stringify(woke));
  else if (woke.peer !== alice.name) bad("the woken realm knows who it is with", JSON.stringify(woke));
  else ok("the realm was opened by the wake-up and carries Alice, which is what the toast reads");

  // And it must not have dragged him anywhere or eaten anything.
  const undisturbed = await bob.page.evaluate(() => ({
    view: window.__concord.state.view,
    active: window.__concord.state.activeCode,
  }));
  if (undisturbed.active === dmCode) bad("waking a DM doesn't yank your view into it", JSON.stringify(undisturbed));
  else ok(`waking it left Bob where he was (view "${undisturbed.view}")`);

  /* ---- the panel gear goes to Voice, not to the top of Settings --------- */

  await alice.page.waitForSelector("#vs-settings", { timeout: 10000 });
  await alice.page.click("#vs-settings");
  await alice.page.waitForSelector("#settings-modal:not(.hidden)");
  await alice.page.waitForTimeout(300);
  const onVoice = await alice.page.evaluate(() => ({
    pane: document.querySelector(".set-pane.active")?.dataset.sec,
    gate: !!document.getElementById("set-gate")?.offsetParent,
  }));
  if (onVoice.pane !== "voice" || !onVoice.gate) bad("the voice panel's ⚙ lands on the noise gate", JSON.stringify(onVoice));
  else ok("the ⚙ on the voice panel opens Settings already on Voice & Video");
  await alice.page.click("#settings-modal .modal-close");

  /* ---- hanging up retracts it ------------------------------------------ */

  await alice.page.click("#btn-call");
  await bob.page.waitForTimeout(2000);
  if (await bob.page.locator(".ring-toast").count()) bad("hanging up takes the ring down");
  else ok("Alice hanging up takes Bob's ring down — the last one out retracts it");

  /* ========================= 8. console clean ============================ */

  for (const list of allErrors) {
    const real = list.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js|Notification|ytimg|Autoplay|net::ERR_/i.test(e));
    if (real.length) bad("no console errors", real.slice(0, 2).join(" | "));
  }
  ok("no console or page errors in any context");
} catch (err) {
  bad("menus flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nMENUS: ALL CHECKS PASSED");
