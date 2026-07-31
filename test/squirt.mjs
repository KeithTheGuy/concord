// Arms the squirt gun and soaks Gorb until he goes down, checking that the
// spray tracks him (hits are tested where the water lands, so he can dodge)
// and that a knocked-out Gorb stays down across a reload.
// Usage: node test/squirt.mjs [outDir]

import { chromium } from "playwright";

const base = "http://127.0.0.1:4189";
const out = process.argv[2] || ".";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

try {
  await page.goto(base);
  await page.waitForSelector("#onboard-modal:not(.hidden)");
  await page.fill("#ob-name", "Keith the Guy");
  await page.click("#ob-done");
  await page.waitForSelector("#join-modal:not(.hidden)");
  await page.fill("#jm-create-name", "The Hangout");
  await page.click("#jm-create");
  await page.waitForSelector("#invite-modal:not(.hidden)");
  await page.click("#invite-modal .modal-close");
  await page.waitForSelector("#gorb", { timeout: 10000 });
  ok("Gorb is on the page");

  await page.click("#btn-squirt");
  if (!(await page.locator("#gorb-gun").count())) bad("squirt gun appears when armed");
  else ok("squirt gun appears when armed");

  // Aim at wherever he is right now, five times.
  for (let shot = 1; shot <= 6; shot++) {
    const box = await page.locator("#gorb").boundingBox();
    if (!box) break;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    if (shot === 2) {
      await page.waitForTimeout(180);
      await page.screenshot({ path: `${out}/7-squirt.png` });
    }
    await page.waitForTimeout(700);
    if (await page.locator("#gorb.ko").count()) break;
  }

  if (!(await page.locator("#gorb.ko").count())) bad("Gorb goes down after enough hits");
  else ok("Gorb goes down after enough hits");
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/8-gorb-down.png` });

  // "Forever" means it survives a reload.
  await page.reload();
  await page.waitForSelector("#app:not(.hidden)", { timeout: 15000 });
  await page.waitForTimeout(1200);
  if (!(await page.locator("#gorb.ko").count())) bad("he stays down after a reload");
  else ok("he stays down after a reload");

  // And Settings can bring him back.
  await page.click("#btn-settings");
  await page.click('#set-nav button:has-text("Appearance")'); // Gorb lives under Appearance
  await page.click("#set-revive");
  await page.waitForTimeout(400);
  if (await page.locator("#gorb.ko").count()) bad("Revive Gorb brings him back");
  else ok("Revive Gorb brings him back");
} catch (err) {
  bad("squirt flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nSQUIRT: ALL CHECKS PASSED");
