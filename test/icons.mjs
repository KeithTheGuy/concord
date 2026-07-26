// Generate Concord app icons (PWA + Electron) by rendering an SVG headset
// logo in Chromium and screenshotting at each size. No image deps needed.
// Usage: node test/icons.mjs
import { chromium } from "playwright";
import { mkdirSync } from "fs";

// fullBleed: square background edge-to-edge (for maskable icons);
// otherwise a rounded squircle on transparency.
const logo = (fullBleed) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${
    fullBleed
      ? `<rect width="512" height="512" fill="#5865f2"/>`
      : `<rect width="512" height="512" rx="115" fill="#5865f2"/>`
  }
  <g transform="${fullBleed ? "translate(51,51) scale(0.8)" : ""}">
    <!-- headband -->
    <path d="M136 300 v-44 a120 120 0 0 1 240 0 v44"
          fill="none" stroke="#fff" stroke-width="42" stroke-linecap="round"/>
    <!-- ear cups -->
    <rect x="104" y="270" width="64" height="112" rx="32" fill="#fff"/>
    <rect x="344" y="270" width="64" height="112" rx="32" fill="#fff"/>
    <!-- mic boom -->
    <path d="M376 382 a96 64 0 0 1 -96 50 h-24"
          fill="none" stroke="#fff" stroke-width="26" stroke-linecap="round"/>
    <circle cx="248" cy="432" r="22" fill="#fff"/>
  </g>
</svg>`;

const jobs = [
  { out: "public/icon-192.png", size: 192, fullBleed: false },
  { out: "public/icon-512.png", size: 512, fullBleed: false },
  { out: "public/icon-maskable-512.png", size: 512, fullBleed: true },
  { out: "build/icon.png", size: 512, fullBleed: false },
];

mkdirSync("build", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const j of jobs) {
  await page.setViewportSize({ width: j.size, height: j.size });
  await page.setContent(
    `<body style="margin:0;background:transparent">` +
      logo(j.fullBleed).replace('width="512" height="512"', `width="${j.size}" height="${j.size}"`) +
      `</body>`
  );
  await page.screenshot({ path: j.out, omitBackground: !j.fullBleed });
  console.log("wrote", j.out);
}
await browser.close();
