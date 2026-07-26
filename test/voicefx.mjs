// Proves the voice changer actually shifts pitch, rather than just running.
// Feeds a known tone through the real worklet in an OfflineAudioContext and
// measures the pitch that comes out by autocorrelation.
// Usage: node test/voicefx.mjs [baseUrl]

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";
let failures = 0;
const ok = (l) => console.log(`  PASS ${l}`);
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};

const browser = await chromium.launch();
const page = await browser.newPage();

try {
  await page.goto(base);

  const measure = await page.evaluate(async () => {
    // Dominant frequency via autocorrelation over a settled window.
    const pitchOf = (data, rate) => {
      const start = Math.floor(rate * 0.35);
      const size = 8192;
      const slice = data.slice(start, start + size);
      let best = -1;
      let bestScore = -Infinity;
      const minLag = Math.floor(rate / 900);
      const maxLag = Math.floor(rate / 80);
      for (let lag = minLag; lag <= maxLag; lag++) {
        let sum = 0;
        for (let i = 0; i < size - lag; i++) sum += slice[i] * slice[i + lag];
        if (sum > bestScore) {
          bestScore = sum;
          best = lag;
        }
      }
      return rate / best;
    };

    const run = async (semitones) => {
      const rate = 48000;
      const ctx = new OfflineAudioContext(1, rate, rate);
      await ctx.audioWorklet.addModule("/voicefx-worklet.js");
      const osc = ctx.createOscillator();
      osc.type = "sawtooth"; // harmonically rich, like a voice
      osc.frequency.value = 200;
      const fx = new AudioWorkletNode(ctx, "voice-fx");
      fx.parameters.get("semitones").value = semitones;
      osc.connect(fx);
      fx.connect(ctx.destination);
      osc.start();
      const rendered = await ctx.startRendering();
      const data = rendered.getChannelData(0);
      let peak = 0;
      for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
      return { hz: pitchOf(data, rate), peak };
    };

    return {
      bypass: await run(0),
      up12: await run(12),
      up5: await run(5),
      down9: await run(-9),
    };
  });

  const near = (actual, want, tolerance) => Math.abs(actual - want) / want < tolerance;

  if (!near(measure.bypass.hz, 200, 0.05))
    bad("bypass leaves pitch untouched", `${measure.bypass.hz.toFixed(1)}Hz, wanted 200Hz`);
  else ok(`bypass passes 200Hz through unchanged (${measure.bypass.hz.toFixed(1)}Hz)`);

  if (measure.up12.peak < 0.05) bad("shifted output is audible", `peak amplitude ${measure.up12.peak}`);
  else ok(`shifted output is audible (peak ${measure.up12.peak.toFixed(2)})`);

  if (!near(measure.up12.hz, 400, 0.06))
    bad("+12 semitones doubles the pitch", `${measure.up12.hz.toFixed(1)}Hz, wanted 400Hz`);
  else ok(`+12 semitones: 200Hz → ${measure.up12.hz.toFixed(1)}Hz (wanted 400)`);

  if (!near(measure.up5.hz, 267, 0.06))
    bad("+5 semitones (Feminine)", `${measure.up5.hz.toFixed(1)}Hz, wanted ~267Hz`);
  else ok(`+5 semitones: 200Hz → ${measure.up5.hz.toFixed(1)}Hz (wanted ~267)`);

  if (!near(measure.down9.hz, 119, 0.08))
    bad("-9 semitones (Demon)", `${measure.down9.hz.toFixed(1)}Hz, wanted ~119Hz`);
  else ok(`-9 semitones: 200Hz → ${measure.down9.hz.toFixed(1)}Hz (wanted ~119)`);
} catch (err) {
  bad("voice fx", err.stack || err.message);
} finally {
  await browser.close();
}

if (failures) {
  console.error(`\n${failures} FAILURE(S)`);
  process.exit(1);
}
console.log("\nVOICE FX: ALL CHECKS PASSED");
