// Electron desktop smoke: launch the real app shell, confirm the window opens,
// loads the Concord client, and the onboarding/app UI renders.
// Usage: node test/desktop.mjs [url]   (url overrides CONCORD_URL for the app)

import { _electron } from "playwright";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
// CONCORD_EXE overrides with a packaged binary (e.g. dist/win-unpacked/Concord.exe)
const electronPath = process.env.CONCORD_EXE || require("electron");

const url = process.argv[2]; // optional override, e.g. local dev server
const env = { ...process.env };
if (url) env.CONCORD_URL = url;

const app = await _electron.launch({
  executablePath: electronPath,
  args: ["."],
  env,
});

let failed = false;
try {
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  // Fresh profile → onboarding modal; returning profile → app shell.
  await win.waitForSelector("#onboard-modal:not(.hidden), #app:not(.hidden)", { timeout: 30000 });
  console.log("  PASS window opened and Concord UI rendered");
  const title = await win.title();
  if (!/Concord/.test(title)) {
    failed = true;
    console.error(`  FAIL window title: ${title}`);
  } else {
    console.log(`  PASS window title: ${title}`);
  }
  const loaded = win.url();
  console.log(`  INFO loaded URL: ${loaded}`);
} catch (err) {
  failed = true;
  console.error("  FAIL desktop smoke —", err.message);
} finally {
  await app.close();
}

if (failed) process.exit(1);
console.log("\nDESKTOP: ALL CHECKS PASSED");
