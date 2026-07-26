// Capture UI screenshots for visual inspection. Usage: node test/shot.mjs [outDir]
import { chromium } from "playwright";

const base = "http://127.0.0.1:4189";
const out = process.argv[2] || ".";
const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["microphone"] });
const page = await ctx.newPage();
await page.goto(base);
await page.waitForSelector("#onboard-modal:not(.hidden)");
await page.screenshot({ path: `${out}/1-onboard.png` });
await page.fill("#ob-name", "Keith the Guy");
await page.click("#ob-avatars button:nth-child(11)");
await page.click("#ob-done");
await page.waitForSelector("#join-modal:not(.hidden)");
await page.screenshot({ path: `${out}/2-join.png` });
await page.fill("#jm-create-name", "The Hangout");
await page.click("#jm-create");
await page.waitForSelector("#invite-modal:not(.hidden)");
await page.click("#invite-modal .modal-close");
await page.waitForSelector("#app:not(.hidden)");
await page.fill("#input", "first! also **bold**, *italic*, `code`, and a link https://example.com 🎉");
await page.press("#input", "Enter");
await page.fill("#input", "second message groups under the first");
await page.press("#input", "Enter");
await page.waitForTimeout(400);
await page.click("#voice-channels .chan-row.voice");
await page.waitForSelector("#voice-status:not(.hidden)");
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/3-app.png` });
await page.click("#btn-settings");
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/4-settings.png` });
await browser.close();
console.log("shots saved");
