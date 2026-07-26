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
  // Pre-enable desktop notifications and stub the Notification API so we can
  // observe notifications fired for background-channel messages.
  await pageA.addInitScript(() => {
    localStorage.setItem("concord-settings", JSON.stringify({ notifs: true }));
    window.__notifs = [];
    window.Notification = class {
      constructor(title, opts) {
        this.title = title;
        this.opts = opts;
        window.__notifs.push(this);
      }
      close() {}
      static requestPermission() {
        return Promise.resolve("granted");
      }
    };
    window.Notification.permission = "granted";
  });
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

  // ---- service worker registered -------------------------------------------------------
  const swReg = await pageA.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? "registered" : "none";
  });
  if (swReg !== "registered") bad("service worker registered", swReg);
  else ok("service worker registered");

  // ---- desktop notification for background-channel message -----------------------------
  await pageA.click("#text-channels .chan-row:nth-child(2)"); // switch A to #random
  await pageB.fill("#input", "psst, notification test");
  await pageB.press("#input", "Enter");
  await pageA.waitForFunction(() => window.__notifs.length > 0, { timeout: 8000 });
  const notif = await pageA.evaluate(() => ({
    title: window.__notifs[0].title,
    body: window.__notifs[0].opts?.body,
  }));
  if (!/E2E Bob/.test(notif.title) || !/notification test/.test(notif.body))
    bad("notification content", JSON.stringify(notif));
  else ok("desktop notification fired for background channel message");
  await pageA.evaluate(() => window.__notifs[0].onclick && window.__notifs[0].onclick());
  const backTo = (await pageA.textContent("#chan-name")).trim();
  if (backTo !== "general") bad("notification click switches channel", backTo);
  else ok("notification click switches to that channel");

  // ---- notification for the CURRENT channel while window is unfocused ------------------
  // Playwright can't take real OS focus from Chromium, so stub hasFocus.
  await pageA.evaluate(() => {
    window.__notifs.length = 0;
    document.hasFocus = () => false;
  });
  await pageB.fill("#input", "unfocused window test");
  await pageB.press("#input", "Enter");
  await pageA.waitForFunction(() => window.__notifs.length > 0, { timeout: 8000 });
  const unfocused = await pageA.evaluate(() => window.__notifs[0].opts?.body);
  if (!/unfocused window test/.test(unfocused)) bad("unfocused notification", unfocused);
  else ok("notification fires for active channel when window is unfocused");
  await pageA.evaluate(() => {
    delete document.hasFocus;
  });

  // ---- Gremlin Mode: prank travels A -> B and actually renders -------------------------
  await pageA.click("#btn-gremlin");
  await pageA.waitForSelector("#gremlin-modal:not(.hidden)");
  const cards = await pageA.locator(".gm-card").count();
  if (cards < 10) bad("prank cards rendered", String(cards));
  else ok(`gremlin modal lists ${cards} pranks`);
  await pageA.selectOption("#gm-target", { index: 1 }); // the single other member (Bob)
  await pageA.click('.gm-card:has(.gm-label:text-is("Emoji Rain"))');
  await pageB.waitForFunction(() => document.querySelectorAll("#gq-layer .gq-drop").length > 3, {
    timeout: 8000,
  });
  ok("prank fired: emoji rain rendered in the victim's client");
  await pageB.waitForFunction(
    () => [...document.querySelectorAll(".toast")].some((t) => /E2E Alice/.test(t.textContent)),
    { timeout: 5000 }
  );
  ok("victim is told who pranked them");
  const prankSentAt = Date.now();
  // Effects must clean themselves up.
  await pageB.waitForFunction(() => document.querySelectorAll("#gq-layer .gq-drop").length === 0, {
    timeout: 20000,
  });
  ok("prank auto-expires (no lingering DOM)");

  // Flash safety: sample the real rendered opacity over the element's whole
  // life (including after the animation ends, where it used to snap to solid
  // white) and assert both peak brightness and flashes-per-second.
  // Fire THREE overlapping air horns through the real code path: a single
  // probe element can't see layers compositing or running at separate phase,
  // which is exactly how the rate and brightness got past an earlier check.
  const flashProbe = await pageB.evaluate(async () => {
    const mod = await import("/prank.js");
    const samples = [];
    const started = performance.now();
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        try {
          mod.runPrank("airhorn", "Tester");
        } catch {}
      }, i * 110);
    }
    await new Promise((resolve) => {
      const t = setInterval(() => {
        const layers = [...document.querySelectorAll(".gq-flash")];
        // Alpha of stacked translucent white layers.
        const composite =
          1 - layers.reduce((acc, el) => acc * (1 - parseFloat(getComputedStyle(el).opacity)), 1);
        samples.push([performance.now() - started, composite, layers.length]);
        if (performance.now() - started > 2000) {
          clearInterval(t);
          resolve();
        }
      }, 16);
    });
    const values = samples.map((s) => s[1]);
    let peaks = 0;
    for (let i = 1; i < values.length; i++) {
      if (values[i] > 0.15 && values[i - 1] <= 0.15) peaks++;
    }
    return {
      max: Math.max(...values),
      layers: Math.max(...samples.map((s) => s[2])),
      peaks,
      spanSeconds: samples[samples.length - 1][0] / 1000,
    };
  });
  if (flashProbe.layers > 1)
    bad("air horn flashes never stack", `${flashProbe.layers} concurrent flash layers`);
  const perSecond = flashProbe.peaks / flashProbe.spanSeconds;
  if (flashProbe.max > 0.4)
    bad("flash never approaches full white", `peak opacity ${flashProbe.max}`);
  else if (perSecond > 3)
    bad("flash rate under 3/sec", `${perSecond.toFixed(2)} flashes/sec`);
  else
    ok(
      `3 stacked air horns: ${flashProbe.layers} flash layer, ${flashProbe.peaks} flashes over ` +
        `${flashProbe.spanSeconds.toFixed(1)}s (${perSecond.toFixed(1)}/sec, WCAG limit 3), ` +
        `peak composite white ${flashProbe.max.toFixed(3)}`
    );

  // Cole Mode: hands must render, never intercept a click, and clean up.
  const cole = await pageB.evaluate(async () => {
    const mod = await import("/prank.js");
    mod.runPrank("colemode", "Cole");
    await new Promise((r) => setTimeout(r, 900));
    const hands = [...document.querySelectorAll(".gq-hand")];
    const blocking = hands.filter((h) => getComputedStyle(h).pointerEvents !== "none").length;
    // What the browser would hand a click to where a hand is drawn.
    let hitsHand = false;
    if (hands[0]) {
      const box = hands[0].getBoundingClientRect();
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      hitsHand = !!at && at.classList.contains("gq-hand");
    }
    mod.runPrank("colemode", "Cole"); // must not stack a second set
    await new Promise((r) => setTimeout(r, 300));
    return { hands: hands.length, blocking, hitsHand, after: document.querySelectorAll(".gq-hand").length };
  });
  if (!cole.hands) bad("Cole Mode renders hands", "no .gq-hand elements appeared");
  else if (cole.blocking || cole.hitsHand) bad("Cole Mode never eats clicks", "a hand was hit-testable");
  else if (cole.after > 1) bad("Cole Mode does not stack", `${cole.after} hands after a second trigger`);
  else ok(`Cole Mode: ${cole.hands} hand(s) poking, click-through, no stacking`);
  await pageB.waitForFunction(() => !document.querySelector(".gq-hand, .gq-boop"), { timeout: 20000 });
  ok("Cole Mode cleans up after itself");

  // Butter Fingers must never corrupt a message the victim actually sends.
  await pageB.click("#btn-gremlin");
  await pageB.waitForSelector("#gremlin-modal:not(.hidden)");
  await pageB.selectOption("#gm-target", { index: 1 });
  await pageB.click('.gm-card:has(.gm-label:text-is("Butter Fingers"))');
  await pageA.waitForFunction(
    () => [...document.querySelectorAll(".toast")].some((t) => /Butter Fingers/.test(t.textContent)),
    { timeout: 8000 }
  );
  await pageA.locator("#input").pressSequentially("integrity check one two", { delay: 15 });
  // Emoji-picker insert writes .value programmatically — the path that used
  // to silently drop characters from the delivered message.
  await pageA.click("#btn-emoji");
  await pageA.click("#emoji-picker .emoji-btn");
  const shown = (await pageA.textContent(".gq-mirror")).trim();
  const realValue = await pageA.inputValue("#input");
  if (shown === realValue) bad("butterfingers scrambles the display", `mirror matched the real text`);
  else ok(`butter fingers display is scrambled ("${shown}")`);

  await pageA.press("#input", "Enter");
  await pageB.waitForFunction(
    () => document.querySelector("#messages").textContent.includes("integrity check"),
    { timeout: 8000 }
  );
  const landed = await pageB.evaluate(() => {
    const nodes = [...document.querySelectorAll(".msg-content")];
    return nodes.map((n) => n.textContent.trim()).find((t) => t.includes("integrity check"));
  });
  if (landed !== realValue)
    bad("butterfingers corrupted a sent message", `sent "${landed}", composer held "${realValue}"`);
  else ok(`sent message is byte-identical to what was typed ("${landed}")`);

  // Full-screen pranks must be dismissable, not a lockout.
  const waitLeft = 15500 - (Date.now() - prankSentAt);
  if (waitLeft > 0) await pageA.waitForTimeout(waitLeft); // A's gremlin cooldown
  await pageA.click("#btn-gremlin");
  await pageA.waitForSelector("#gremlin-modal:not(.hidden)");
  await pageA.selectOption("#gm-target", { index: 1 });
  await pageA.click('.gm-card:has(.gm-label:text-is("Blue Screen"))');
  await pageB.waitForSelector(".gq-bsod", { timeout: 8000 });
  ok("fake blue screen renders on the victim");
  await pageB.keyboard.press("Escape");
  await pageB.waitForFunction(() => !document.querySelector(".gq-full"), { timeout: 3000 });
  ok("victim can dismiss a full-screen prank with Escape (no lockout)");
  const settingsReachable = await pageB.evaluate(() => {
    document.getElementById("btn-settings").click();
    return !document.getElementById("settings-modal").classList.contains("hidden");
  });
  if (!settingsReachable) bad("settings reachable after prank", "opt-out is unreachable");
  else ok("opt-out (Settings) is reachable again after dismissal");
  await pageB.click("#settings-modal .modal-close");

  // ---- console/page errors ------------------------------------------------------------
  const realErrors = [...errorsA, ...errorsB].filter(
    (e) => !/favicon|Autoplay|net::ERR_/i.test(e)
  );
  if (realErrors.length) bad("zero console/page errors", realErrors.join(" | "));
  else ok("no console or page errors on either client");
} catch (err) {
  bad("e2e flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nE2E: ALL CHECKS PASSED");
