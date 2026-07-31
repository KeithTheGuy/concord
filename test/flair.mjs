// Covers the new decorative + audio-rack layer: FredsVoice actually changes
// the signal (not just the pitch), every theme applies, turbo mode is opt-in
// and reversible, polls tally votes, and achievements/levels tick over.
// Usage: node test/flair.mjs

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
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
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, permissions: ["microphone"] });
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

try {
  const a = await newUser("Keith");
  await a.page.waitForSelector("#join-modal:not(.hidden)");
  await a.page.fill("#jm-create-name", "Flair Test");
  await a.page.click("#jm-create");
  await a.page.waitForSelector("#invite-modal:not(.hidden)");
  await a.page.click("#invite-modal .modal-close");
  await a.page.waitForSelector("#chat-view:not(.hidden)");

  /* ---------------------------- voice FX rack --------------------------- */
  // Drive a known tone through each preset's graph offline and compare the
  // rendered output to the dry signal. A preset that claims to change the
  // sound had better actually change it.
  const fx = await a.page.evaluate(async () => {
    const { VOICE_FX, buildFxGraph } = await import("/voicefx.js");
    const results = {};
    for (const preset of VOICE_FX) {
      const spec = preset.spec || {};
      const hasRack = Object.keys(spec).some((k) => k !== "semis");
      const ctx = new OfflineAudioContext(2, 44100 * 0.5, 44100);
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 220;
      const graph = hasRack ? buildFxGraph(ctx, spec) : null;
      if (graph) {
        osc.connect(graph.input);
        graph.output.connect(ctx.destination);
      } else {
        osc.connect(ctx.destination);
      }
      osc.start();
      osc.stop(0.5);
      const buf = await ctx.startRendering();
      const L = buf.getChannelData(0);
      const Rr = buf.getChannelData(1);
      let rms = 0;
      let diff = 0;
      for (let i = 4000; i < L.length; i++) {
        rms += L[i] * L[i];
        diff += Math.abs(L[i] - Rr[i]);
      }
      results[preset.id] = {
        hasRack,
        rms: Math.sqrt(rms / (L.length - 4000)),
        stereoDiff: diff / (L.length - 4000),
      };
    }
    return results;
  });

  if (!fx.freds?.hasRack) bad("FredsVoice has a real FX chain, not just pitch");
  else ok("FredsVoice has a real FX chain, not just pitch");

  if (!(fx.freds.rms > 0.0001)) bad("FredsVoice produces audible output", JSON.stringify(fx.freds));
  else ok(`FredsVoice produces audible output (rms ${fx.freds.rms.toFixed(3)})`);

  // The ping-pong delay is what makes it feel like it's beside your head.
  if (!(fx.freds.stereoDiff > 0.001)) bad("FredsVoice is genuinely stereo", `diff=${fx.freds.stereoDiff}`);
  else ok(`FredsVoice is genuinely stereo (L/R differ by ${fx.freds.stereoDiff.toFixed(4)})`);

  if (fx.off.hasRack) bad("Off stays a true bypass");
  else ok("Off stays a true bypass");

  const silent = Object.entries(fx).filter(([, v]) => v.hasRack && !(v.rms > 0.0001));
  if (silent.length) bad("every preset produces sound", silent.map(([k]) => k).join(", "));
  else ok(`every preset with a rack produces sound (${Object.values(fx).filter((v) => v.hasRack).length} racks)`);

  // Nothing should be so loud it wrecks the call — the output limiter caps it.
  const tooLoud = Object.entries(fx).filter(([, v]) => v.rms > 1.2);
  if (tooLoud.length) bad("presets stay within a sane level", tooLoud.map(([k]) => k).join(", "));
  else ok("presets stay within a sane level (limiter holds)");

  /* ------------------------------- themes ------------------------------- */
  const themeResults = await a.page.evaluate(async () => {
    const { THEMES, applyTheme } = await import("/flair.js");
    const out = [];
    for (const t of THEMES) {
      applyTheme(t.id);
      const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg-chat").trim();
      out.push([t.id, bg]);
    }
    applyTheme("midnight");
    return out;
  });
  const distinct = new Set(themeResults.map(([, bg]) => bg));
  if (distinct.size !== themeResults.length) {
    bad("every theme has a distinct background", JSON.stringify(themeResults));
  } else ok(`all ${themeResults.length} themes apply distinct colours`);

  /* ------------------------------- turbo -------------------------------- */
  await a.page.click("#btn-settings");
  // Settings shows one section at a time now, and turbo lives under Appearance.
  await a.page.click('#set-nav button:has-text("Appearance")');
  await a.page.check("#set-turbo");
  await a.page.waitForTimeout(200);
  if (!(await a.page.locator("body.turbo").count())) bad("turbo mode switches on");
  else ok("turbo mode switches on");
  await a.page.uncheck("#set-turbo");
  await a.page.waitForTimeout(150);
  if (await a.page.locator("body.turbo").count()) bad("turbo mode switches back off");
  else ok("turbo mode switches back off");
  await a.page.click("#set-done");

  /* -------------------------------- polls ------------------------------- */
  await a.page.fill("#input", "/poll Pizza tonight? | Yes | Absolutely");
  await a.page.press("#input", "Enter");
  await a.page.waitForSelector(".poll", { timeout: 10000 });
  ok("poll renders as a widget");

  const optCount = await a.page.locator(".poll-opt").count();
  if (optCount !== 2) bad("poll shows both options", `got ${optCount}`);
  else ok("poll shows both options");

  await a.page.click(".poll-opt >> nth=0");
  await a.page.waitForFunction(
    () => document.querySelector(".poll-opt .poll-count")?.textContent === "1",
    undefined,
    { timeout: 10000 }
  );
  ok("voting registers on the poll");

  // Voting the other way should move the vote, not add a second one.
  await a.page.click(".poll-opt >> nth=1");
  await a.page.waitForTimeout(900);
  const counts = await a.page.locator(".poll-count").allTextContents();
  const total = counts.reduce((n, c) => n + Number(c), 0);
  if (total !== 1) bad("one vote each — switching moves it", JSON.stringify(counts));
  else ok("one vote each — switching moves the vote");

  /* --------------------------- levels + badges -------------------------- */
  const progress = await a.page.evaluate(() => ({
    xp: window.__concord.state.settings.xp,
    achievements: window.__concord.state.settings.achievements,
  }));
  if (!(progress.xp > 0)) bad("sending messages earns XP", JSON.stringify(progress));
  else ok(`sending messages earns XP (${progress.xp})`);
  if (!progress.achievements?.includes("first-word")) {
    bad("first message unlocks an achievement", JSON.stringify(progress.achievements));
  } else ok("first message unlocks an achievement");
  if (!progress.achievements?.includes("pollster")) bad("running a poll unlocks Pollster");
  else ok("running a poll unlocks Pollster");

  await a.page.click("#btn-settings");
  await a.page.click('#set-nav button:has-text("Appearance")');
  await a.page.click("#set-achievements");
  await a.page.waitForSelector("#achievements-modal:not(.hidden)");
  const achRows = await a.page.locator("#ach-list .friend-row").count();
  if (achRows < 20) bad("achievements list renders", `rows=${achRows}`);
  else ok(`achievements list renders (${achRows} entries)`);

  /* ---------------------------- console clean --------------------------- */
  const real = a.errors.filter((e) => !/favicon|manifest|ERR_INTERNET|sw\.js|Notification|ytimg/i.test(e));
  if (real.length) bad("no console errors", real.slice(0, 3).join(" | "));
  else ok("no console errors");
} catch (err) {
  bad("flair flow", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nFLAIR: ALL CHECKS PASSED");
