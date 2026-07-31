// Phone-sized regression suite.
//
// The app used to be genuinely inoperable below ~500px: three fixed columns
// and one breakpoint meant a 390px viewport got a 118px chat pane and a 0px
// textarea, and page.fill("#input") timed out after 30 seconds because there
// was nothing there to fill. So the load-bearing assertion in here is a
// number — the measured width of the box you type in — checked at every
// viewport a phone actually reports, portrait and landscape.
//
// The rest of the file covers the daily annoyances fixed alongside it, which
// no other suite reaches: Escape on the emoji picker, who-reacted tooltips,
// the invite note on the first-run screen, the retry button on a failed
// upload, and the mute button's tooltip while deafened.
//
// Usage: node test/mobile.mjs [baseUrl]

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

// A composer narrower than this is one you can't write a sentence in. The
// pre-fix numbers were 54px at 480 and 0px at 390.
const MIN_COMPOSER = 180;

const PHONES = [
  ["390x844 portrait", 390, 844],
  ["360x740 portrait", 360, 740],
  ["480x800 portrait", 480, 800],
  ["600x900 portrait", 600, 900],
  ["740x360 landscape", 740, 360],
];

const browser = await chromium.launch();

const widthOf = async (page, sel) => {
  const box = await page.locator(sel).boundingBox();
  return box ? Math.round(box.width) : 0;
};

async function newUser(page, name) {
  await page.goto(base);
  await page.waitForSelector("#onboard-modal:not(.hidden)");
  await page.fill("#ob-name", name);
  await page.click("#ob-done");
}

async function createServer(page, name) {
  await page.waitForSelector("#join-modal:not(.hidden)");
  await page.fill("#jm-create-name", name);
  await page.click("#jm-create");
  await page.waitForSelector("#invite-modal:not(.hidden)");
  const code = (await page.textContent("#invite-code")).trim();
  await page.click("#invite-modal .modal-close");
  await page.waitForSelector("#chat-view:not(.hidden)");
  return code;
}

const drawerX = async (page) => {
  const box = await page.locator("#sidebar").boundingBox();
  return box ? Math.round(box.x) : null;
};

// The drawer slides, so every assertion about where it is has to outlast the
// transition rather than sample the first frame of it.
const drawerSettled = (page, x) =>
  page.waitForFunction(
    (want) => Math.round(document.getElementById("sidebar").getBoundingClientRect().x) === want,
    x,
    { timeout: 4000 }
  );

try {
  /* ===================== 1. the number that was zero ===================== */

  const measured = [];
  for (const [label, width, height] of PHONES) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await newUser(page, "Keith");
    await createServer(page, "The Hangout");

    const composer = await widthOf(page, "#input");
    const main = await widthOf(page, "#main");
    measured.push(`${label}: #input ${composer}px, #main ${main}px`);
    if (composer < MIN_COMPOSER) bad(`${label} composer is usable`, `#input is ${composer}px`);
    else ok(`${label} composer is ${composer}px wide (#main ${main}px)`);

    // The pane must not be sitting under a drawer that never left.
    if (width <= 760) {
      const x = await drawerX(page);
      if (x === null || x >= 0) bad(`${label} drawer starts closed`, `#sidebar x=${x}`);
      else ok(`${label} drawer starts closed`);
    }

    // Nothing may push the page sideways: html/body are overflow:hidden, so a
    // row that can't shrink silently clips its own right-hand end instead.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 0) bad(`${label} nothing overflows horizontally`, `${overflow}px past the edge`);
    else ok(`${label} nothing overflows horizontally`);

    await ctx.close();
  }
  console.log("  ---- measured ----");
  for (const m of measured) console.log(`       ${m}`);

  /* ================= 2. a whole conversation on a phone ================== */

  const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await phoneCtx.newPage();
  const errors = [];
  phone.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  phone.on("pageerror", (e) => errors.push(String(e)));
  await newUser(phone, "Keith");
  const code = await createServer(phone, "The Hangout");

  await phone.click("#nav-toggle");
  await phone.waitForFunction(() => document.body.classList.contains("nav-open"));
  try {
    await drawerSettled(phone, 72);
    ok("☰ opens the drawer");
  } catch {
    bad("☰ opens the drawer", `#sidebar x=${await drawerX(phone)}`);
  }

  // Picking a channel has to put the drawer away — otherwise every navigation
  // leaves it covering the thing you just chose.
  await phone.click("#text-channels .chan-row >> nth=0");
  await phone.waitForFunction(() => !document.body.classList.contains("nav-open"));
  ok("picking a channel closes the drawer");

  await phone.click("#nav-toggle");
  await phone.waitForFunction(() => document.body.classList.contains("nav-open"));
  await phone.keyboard.press("Escape");
  await phone.waitForFunction(() => !document.body.classList.contains("nav-open"));
  ok("Escape closes the drawer");

  await phone.click("#nav-toggle");
  await phone.waitForFunction(() => document.body.classList.contains("nav-open"));
  await phone.click("#nav-scrim");
  await phone.waitForFunction(() => !document.body.classList.contains("nav-open"));
  ok("tapping the scrim closes the drawer");

  await phone.click("#nav-toggle");
  await phone.waitForFunction(() => document.body.classList.contains("nav-open"));
  await phone.goBack();
  await phone.waitForFunction(() => !document.body.classList.contains("nav-open"));
  ok("the back button closes the drawer");

  // The thing that timed out for 30 seconds.
  await phone.fill("#input", "typed on a phone");
  await phone.press("#input", "Enter");
  await phone.waitForSelector('.msg-content:has-text("typed on a phone")', { timeout: 10000 });
  ok("a message sends from a 390px viewport");

  /* ================= 3. the desktop half of the exchange ================= */

  const deskCtx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const desk = await deskCtx.newPage();
  await newUser(desk, "Cole");
  await desk.waitForSelector("#join-modal:not(.hidden)");
  await desk.fill("#jm-code", code);
  await desk.click("#jm-join");
  await desk.waitForSelector("#chat-view:not(.hidden)", { timeout: 15000 });
  await desk.fill("#input", "read on a phone");
  await desk.press("#input", "Enter");
  await phone.waitForSelector('.msg-content:has-text("read on a phone")', { timeout: 15000 });
  ok("the reply arrives and is readable at 390px");

  // One letter per line was the old failure mode, so check the bubble is
  // wider than a single character is tall.
  const bubble = await widthOf(phone, '.msg-content:has-text("read on a phone")');
  if (bubble < 100) bad("message text isn't rendering one letter per line", `${bubble}px wide`);
  else ok(`message text has room to wrap (${bubble}px)`);

  /* ==================== 4. the header's overflow plan ==================== */

  const shown = (page, sel) => page.locator(sel).isVisible();
  if (await shown(phone, "#btn-squirt")) bad("💦 leaves the header at 390px");
  else ok("💦 leaves the header at 390px");
  if (await shown(phone, "#btn-gremlin")) bad("🃏 leaves the header at 390px");
  else ok("🃏 leaves the header at 390px");
  if (!(await shown(phone, "#btn-more"))) bad("⋯ appears at 390px");
  else ok("⋯ appears at 390px");

  await phone.click("#btn-more");
  await phone.waitForSelector("#ctx-menu:not(.hidden)");
  const menuText = await phone.textContent("#ctx-menu");
  if (!menuText.includes("Squirt") || !menuText.includes("Gremlin")) {
    bad("⋯ holds both joke buttons", menuText);
  } else ok("⋯ holds both joke buttons");
  await phone.keyboard.press("Escape");
  await phone.click("#messages");

  if (!(await shown(desk, "#btn-squirt"))) bad("💦 is still in the header at 1400px");
  else ok("💦 is still in the header at 1400px");
  if (await shown(desk, "#btn-more")) bad("⋯ stays out of the way at 1400px");
  else ok("⋯ stays out of the way at 1400px");

  /* ================= 5. Settings at 390px is not a trap ================= */

  await phone.click("#nav-toggle");
  await phone.click("#btn-settings");
  await phone.waitForSelector("#settings-modal:not(.hidden)");
  const tall = await phone.evaluate(() => document.getElementById("settings-modal").scrollHeight);
  await phone.evaluate(() => {
    const back = document.getElementById("modal-backdrop");
    back.scrollTop = back.scrollHeight;
  });
  const closeBox = await phone.locator("#settings-modal .modal-close").boundingBox();
  const inView = closeBox && closeBox.y >= 0 && closeBox.y + closeBox.height <= 844;
  if (!inView) bad("the ✕ survives scrolling a 1600px settings page", JSON.stringify(closeBox));
  else ok(`the ✕ stays reachable through all ${tall}px of Settings`);
  await phone.click("#settings-modal .modal-close");
  await phone.waitForFunction(() => document.getElementById("settings-modal").classList.contains("hidden"));
  await phone.keyboard.press("Escape"); // the drawer, still open behind it
  await phone.waitForFunction(() => !document.body.classList.contains("nav-open"));
  ok("Escape closes the modal first and the drawer second");

  /* =================== 6. Escape closes the emoji picker ================= */

  await desk.click("#btn-emoji");
  await desk.waitForSelector("#emoji-picker:not(.hidden)");
  await desk.keyboard.press("Escape");
  await desk.waitForFunction(() => document.getElementById("emoji-picker").classList.contains("hidden"), null, {
    timeout: 3000,
  });
  ok("Escape closes the emoji picker");

  /* ======================= 7. who reacted, by name ======================= */

  await desk.hover('.msg:has-text("read on a phone")');
  await desk.click('.msg:has-text("read on a phone") .msg-actions button >> nth=0');
  await desk.waitForSelector(".reaction");
  const mine = await desk.getAttribute('.msg:has-text("read on a phone") .reaction', "title");
  if (!/^You reacted with /.test(mine || "")) bad("a reaction names who reacted", mine);
  else ok(`own reaction reads "${mine}"`);

  await phone.hover('.msg:has-text("read on a phone")');
  await phone.click('.msg:has-text("read on a phone") .msg-actions button >> nth=0');
  await desk.waitForFunction(
    () => document.querySelector(".reaction")?.title.includes("Keith"),
    null,
    { timeout: 10000 }
  );
  const both = await desk.getAttribute('.msg:has-text("read on a phone") .reaction', "title");
  if (/reactions?$/.test(both || "")) bad("the old count-only tooltip is gone", both);
  else ok(`two reactors read "${both}"`);

  /* ================ 8. the invite link says what it's for ================ */

  const guestCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestCtx.newPage();
  await guest.goto(`${base}/?join=${code}`);
  await guest.waitForSelector("#onboard-modal:not(.hidden)");
  const note = (await guest.textContent("#ob-invite")).trim();
  const noteShown = await guest.locator("#ob-invite").isVisible();
  if (!noteShown || !note.includes(code)) bad("an invited guest is told what they're joining", note);
  else ok(`invited guest sees "${note}"`);
  await guestCtx.close();

  const plainCtx = await browser.newContext();
  const plain = await plainCtx.newPage();
  await plain.goto(base);
  await plain.waitForSelector("#onboard-modal:not(.hidden)");
  if (await plain.locator("#ob-invite").isVisible()) bad("a stranger doesn't get an invite note");
  else ok("a stranger doesn't get an invite note");
  await plainCtx.close();

  /* =================== 9. a failed upload can be retried ================= */

  await desk.route("**/api/upload/**", (route) => route.fulfill({ status: 503, body: "no" }));
  await desk.setInputFiles("#file-picker", {
    name: "holiday.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("a file that is about to have a bad time"),
  });
  await desk.waitForSelector(".att-card");
  await desk.fill("#input", "here you go");
  await desk.press("#input", "Enter");
  await desk.waitForSelector(".att-card.error", { timeout: 20000 });
  const why = (await desk.textContent(".att-card-why")).trim();
  if (!why.includes("503")) bad("the full error text is shown", why);
  else ok(`the failure explains itself: "${why}"`);
  if (!(await desk.locator(".att-card-retry").isVisible())) bad("a failed upload offers a retry");
  else ok("a failed upload offers a retry");

  await desk.unroute("**/api/upload/**");
  await desk.click(".att-card-retry");
  await desk.waitForSelector(".att-card:not(.error)", { timeout: 20000 });
  ok("retry clears the error and keeps the file staged");
  await desk.click(".att-card-remove");

  /* ============ 10. the mute button stops lying while deafened =========== */

  await desk.click("#btn-deafen");
  const deafTip = await desk.getAttribute("#btn-mute", "title");
  if (!/deafen/i.test(deafTip || "")) bad("the mute tooltip mentions being deafened", deafTip);
  else ok(`deafened mute tooltip reads "${deafTip}"`);
  await desk.click("#btn-deafen");
  const plainTip = await desk.getAttribute("#btn-mute", "title");
  if (plainTip !== "Mute") bad("undeafening puts the mute tooltip back", plainTip);
  else ok("undeafening puts the mute tooltip back");

  /* ============ 11. the voice panel gets two lines for its name ========== */

  const clamp = await desk.evaluate(() => {
    const s = getComputedStyle(document.getElementById("vs-channel"));
    return { clamp: s.webkitLineClamp, wrap: s.whiteSpace };
  });
  if (clamp.clamp !== "2" || clamp.wrap !== "normal") {
    bad("the voice panel subtitle gets two lines", JSON.stringify(clamp));
  } else ok("the voice panel subtitle gets two lines");

  /* ============================ console health =========================== */

  const noisy = errors.filter((e) => !/favicon|WebSocket is closed|net::ERR/i.test(e));
  if (noisy.length) bad("no console errors on the phone", noisy.slice(0, 3).join(" | "));
  else ok("no console errors on the phone");

  await phoneCtx.close();
  await deskCtx.close();
} catch (err) {
  bad("suite crashed", err.message);
} finally {
  await browser.close();
}

console.log(failures ? `\n${failures} mobile check(s) FAILED` : "\nall mobile checks passed");
process.exit(failures ? 1 : 0);
