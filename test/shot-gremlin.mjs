// Screenshot Gremlin Mode: the picker, and a prank landing on a victim.
// Usage: node test/shot-gremlin.mjs [outDir]
import { chromium } from "playwright";

const base = "http://127.0.0.1:4189";
const out = process.argv[2] || ".";
const browser = await chromium.launch();

async function member(name, url) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(url);
  await page.waitForSelector("#onboard-modal:not(.hidden)");
  await page.fill("#ob-name", name);
  await page.click("#ob-done");
  return page;
}

const a = await member("Keith the Guy", base);
await a.waitForSelector("#join-modal:not(.hidden)");
await a.fill("#jm-create-name", "The Hangout");
await a.click("#jm-create");
await a.waitForSelector("#invite-modal:not(.hidden)");
const code = (await a.textContent("#invite-code")).trim();
await a.click("#invite-modal .modal-close");

const b = await member("Victim Steve", `${base}/?join=${code}`);
await b.waitForSelector("#app:not(.hidden)");
await a.waitForFunction(() => document.querySelector("#member-list").textContent.includes("Victim"));

await a.click("#btn-gremlin");
await a.waitForSelector("#gremlin-modal:not(.hidden)");
await a.waitForTimeout(300);
await a.screenshot({ path: `${out}/5-gremlin-picker.png` });

await a.selectOption("#gm-target", { index: 1 });
await a.click('.gm-card:has(.gm-label:text-is("Blue Screen"))');
await b.waitForSelector(".gq-bsod");
await b.waitForTimeout(1200);
await b.screenshot({ path: `${out}/6-victim-bsod.png` });

await browser.close();
console.log("gremlin shots saved");
