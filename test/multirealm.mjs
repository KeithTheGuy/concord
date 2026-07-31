// The point of the multi-realm refactor: a voice call must survive you
// wandering off to another server or into a DM. This drives that directly —
// two browsers get into a real WebRTC call, then one of them goes browsing
// and we assert the audio track is still flowing at the end.
// Also covers: per-user volume persisting across a reload, cross-server unread
// badges, and DMing someone straight from a server member list.
// Usage: node test/multirealm.mjs

import { chromium } from "playwright";

const base = "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

async function newUser(name) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    permissions: ["microphone"],
  });
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

// Counts remote audio tracks the voice engine currently has live.
const liveAudio = (page) =>
  page.evaluate(async () => {
    const app = window.__concord;
    if (!app) return -1;
    let n = 0;
    for (const peer of app.voice.peers.values()) {
      const receivers = peer.pc.getReceivers().filter((r) => r.track && r.track.kind === "audio");
      for (const r of receivers) if (r.track.readyState === "live") n++;
    }
    return n;
  });

try {
  const a = await newUser("Keith");
  const b = await newUser("Cole");

  // --- A makes two servers -------------------------------------------------
  await a.page.waitForSelector("#join-modal:not(.hidden)");
  await a.page.fill("#jm-create-name", "Main Hangout");
  await a.page.click("#jm-create");
  await a.page.waitForSelector("#invite-modal:not(.hidden)");
  const code1 = (await a.page.textContent("#invite-code")).trim();
  await a.page.click("#invite-modal .modal-close");

  await a.page.click("#add-server-btn");
  await a.page.fill("#jm-create-name", "Second Place");
  await a.page.click("#jm-create");
  await a.page.waitForSelector("#invite-modal:not(.hidden)");
  const code2 = (await a.page.textContent("#invite-code")).trim();
  await a.page.click("#invite-modal .modal-close");
  ok(`two servers created (${code1}, ${code2})`);

  // --- B joins the first ---------------------------------------------------
  await b.page.waitForSelector("#join-modal:not(.hidden)");
  await b.page.fill("#jm-code", code1);
  await b.page.click("#jm-join");
  await b.page.waitForSelector("#chat-view:not(.hidden)", { timeout: 15000 });
  await b.page.waitForSelector(".member-row", { timeout: 15000 });
  ok("second user joined the first server");

  // --- both into voice -----------------------------------------------------
  await a.page.click(`.server-bubble[title="Main Hangout"]`);
  await a.page.waitForTimeout(400);
  for (const u of [a, b]) {
    await u.page.click("#voice-channels .chan-row >> nth=0");
    await u.page.waitForSelector("#voice-status:not(.hidden)", { timeout: 15000 });
  }
  await a.page.waitForFunction(
    () => {
      const app = window.__concord;
      if (!app) return false;
      for (const p of app.voice.peers.values()) {
        if (p.pc.getReceivers().some((r) => r.track?.kind === "audio" && r.track.readyState === "live")) return true;
      }
      return false;
    },
    undefined,
    { timeout: 30000 }
  );
  const before = await liveAudio(a.page);
  if (before < 1) bad("live WebRTC audio established", `tracks=${before}`);
  else ok(`live WebRTC audio established (${before} track)`);

  // --- THE ASK: wander off and confirm the call survives --------------------
  await a.page.click(`.server-bubble[title="Second Place"]`);
  await a.page.waitForTimeout(800);
  if (!(await a.page.locator("#voice-status:not(.hidden)").count())) {
    bad("voice panel stays up after switching server");
  } else ok("voice panel stays up after switching server");

  const afterServer = await liveAudio(a.page);
  if (afterServer < 1) bad("call survives switching to another server", `tracks=${afterServer}`);
  else ok("call survives switching to another server");

  // Can we actually talk in the other server while the call runs?
  await a.page.fill("#input", "texting from the other server mid-call");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector('.msg-content:has-text("texting from the other server")', { timeout: 10000 });
  const afterTyping = await liveAudio(a.page);
  if (afterTyping < 1) bad("call survives chatting in another server", `tracks=${afterTyping}`);
  else ok("call survives chatting in another server");

  // The call's own server should still be marked as holding the call.
  if (!(await a.page.locator(".server-bubble.in-call").count())) {
    bad("rail marks which server holds the call");
  } else ok("rail marks which server holds the call");

  // --- unread badge on the server we left ----------------------------------
  await b.page.fill("#input", "hey are you still there");
  await b.page.press("#input", "Enter");
  await a.page.waitForSelector(".server-bubble.has-unread", { timeout: 10000 }).catch(() => {});
  if (!(await a.page.locator(".server-bubble.has-unread").count())) {
    bad("unread badge appears for a server you aren't viewing");
  } else ok("unread badge appears for a server you aren't viewing");

  // --- DM someone from the server member list ------------------------------
  await a.page.click(`.server-bubble[title="Main Hangout"]`);
  await a.page.waitForTimeout(500);
  // Become friends first (DMs are friends-only), via the member list profile.
  // Wait for it rather than sampling — the hub is a second socket, and on a
  // loaded machine hub-welcome can land well after the server realm is up.
  const tagB = await b.page
    .waitForFunction(() => window.__concord.hub.me?.tag || null, null, { timeout: 15000 })
    .then((h) => h.jsonValue());
  await a.page.click("#home-btn");
  await a.page.click('#fv-tabs button[data-tab="add"]');
  await a.page.fill(".add-friend-row input", tagB);
  await a.page.click(".add-friend-row .primary-btn");
  // The badge lives inside the friends pane, so go there before looking for it.
  await b.page.click("#home-btn");
  await b.page.waitForSelector("#fv-pending-badge:not(.hidden)", { timeout: 10000 });
  await b.page.click('#fv-tabs button[data-tab="pending"]');
  await b.page.click('.friend-row button:has-text("Accept")');
  await a.page.waitForSelector('.dm-row:has-text("Cole")', { timeout: 10000 });

  const stillUpAfterFriending = await liveAudio(a.page);
  if (stillUpAfterFriending < 1) bad("call survives the friends flow", `tracks=${stillUpAfterFriending}`);
  else ok("call survives the friends flow");

  // Now the actual ask: click them in the server member list -> Message.
  await a.page.click(`.server-bubble[title="Main Hangout"]`);
  await a.page.waitForTimeout(400);
  await a.page.click('.member-row:has-text("Cole")');
  await a.page.waitForSelector("#profile-pop:not(.hidden)", { timeout: 8000 });
  const hasMessage = await a.page.locator('#profile-pop button:has-text("Message")').count();
  if (!hasMessage) bad("profile popout offers Message for a friend in the server");
  else ok("profile popout offers Message for a friend in the server");
  await a.page.click('#profile-pop button:has-text("Message")');
  await a.page.waitForSelector("#chat-view:not(.hidden)", { timeout: 10000 });
  await a.page.fill("#input", "dm from inside the server");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector('.msg-content:has-text("dm from inside the server")', { timeout: 10000 });
  ok("DM opened straight from the server member list");

  const afterDm = await liveAudio(a.page);
  if (afterDm < 1) bad("call survives opening a DM", `tracks=${afterDm}`);
  else ok("call survives opening a DM");

  // --- per-user volume persists across reload ------------------------------
  await a.page.click(`.server-bubble[title="Main Hangout"]`);
  await a.page.waitForTimeout(400);
  await a.page.evaluate(() => {
    const app = window.__concord;
    const other = [...app.state.realms.get(app.state.voiceCode).members.values()].find(
      (m) => m.sid !== app.state.realms.get(app.state.voiceCode).me.sid
    );
    app.voice.setUserVolume(other.sid, 42);
  });
  const savedNow = await a.page.evaluate(() => Object.values(window.__concord.state.settings.userVolumes || {}));
  if (!savedNow.includes(42)) bad("per-user volume is written to settings", JSON.stringify(savedNow));
  else ok("per-user volume is written to settings");

  await a.page.reload();
  await a.page.waitForSelector("#app:not(.hidden)", { timeout: 20000 });
  await a.page.waitForTimeout(1500);
  const savedAfter = await a.page.evaluate(() =>
    Object.values(JSON.parse(localStorage.getItem("concord-settings") || "{}").userVolumes || {})
  );
  if (!savedAfter.includes(42)) bad("per-user volume survives a reload", JSON.stringify(savedAfter));
  else ok("per-user volume survives a reload");

  // --- console cleanliness -------------------------------------------------
  for (const [u, who] of [[a, "Keith"], [b, "Cole"]]) {
    const real = u.errors.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js|Notification/i.test(e));
    if (real.length) bad(`${who} had no console errors`, real.slice(0, 2).join(" | "));
    else ok(`${who} had no console errors`);
  }
} catch (err) {
  bad("multi-realm flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nMULTI-REALM: ALL CHECKS PASSED");
