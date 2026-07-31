// Runs every suite and prints one verdict.
//
// Each suite already prints its own detail, so this deliberately swallows their
// output unless something fails — the point is to be able to ask "is the app
// still fine?" and get an answer you can read in one glance, rather than nine
// screens of PASS lines you'll skim and misread.
//
// Starts a dev server if one isn't already listening, and only stops the one it
// started. Reusing an existing server matters: wrangler takes ~10s to boot and
// this gets run a lot.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// A private port is worth having: wrangler hot-reloads on every save, and a
// reload kills in-flight sockets mid-suite. Sharing the dev server you're also
// editing against produces failures that look like bugs and aren't.
const PORT = Number(process.env.CONCORD_PORT) || 4189;
const BASE = `http://127.0.0.1:${PORT}`;

// Order matters: the cheap protocol suites run first so an obvious breakage
// fails in seconds instead of after the four-minute browser suites.
const SUITES = [
  // backup is pure logic and needs no server, so it goes first — it costs
  // nothing and a failure here means the restore path is broken.
  ["backup", "protocol"],
  ["outbox", "protocol"],
  ["smoke", "protocol"],
  ["identity", "protocol"],
  ["uploads", "protocol"],
  ["security", "protocol"],
  ["hubsec", "protocol"],
  ["archive", "protocol"],
  ["roster", "protocol"],
  ["threads", "protocol"],
  ["voicefx", "audio"],
  ["flair", "audio"],
  ["render", "browser"],
  ["social", "browser"],
  ["groups", "browser"],
  ["multirealm", "browser"],
  ["ringing", "browser"],
  ["e2e", "browser"],
];

const only = process.argv.slice(2);
const chosen = only.length ? SUITES.filter(([n, kind]) => only.includes(n) || only.includes(kind)) : SUITES;

async function up() {
  try {
    const res = await fetch(BASE + "/", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer() {
  const proc = spawn("npx", ["wrangler", "dev", "--port", String(PORT)], {
    stdio: "ignore",
    shell: process.platform === "win32",
    detached: false,
  });
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (await up()) return proc;
  }
  proc.kill();
  throw new Error("dev server never came up");
}

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    // Every suite takes the base URL as argv[2] and defaults to :4189.
    const proc = spawn(process.execPath, [`test/${name}.mjs`, BASE], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ name, code, out, ms: Date.now() - started }));
  });
}

const mine = (await up()) ? null : await startServer();
if (mine) console.log("started a dev server for this run\n");

const results = [];
for (const [name] of chosen) {
  process.stdout.write(`  ${name.padEnd(12)}`);
  const r = await run(name);
  results.push(r);
  // A suite's own final line is the most informative thing it prints, so echo
  // that rather than inventing a summary of our own.
  const last = r.out.trim().split("\n").filter(Boolean).pop() || "(no output)";
  console.log(`${r.code === 0 ? "ok  " : "FAIL"}  ${(r.ms / 1000).toFixed(1)}s  ${last.slice(0, 60)}`);
}

const failed = results.filter((r) => r.code !== 0);
for (const r of failed) {
  console.log(`\n───── ${r.name} ─────\n${r.out.trim()}`);
}

if (mine) mine.kill();

const total = (results.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(0);
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} suites FAILED (${total}s): ${failed.map((r) => r.name).join(", ")}`
    : `\nall ${results.length} suites passed (${total}s)`
);
process.exit(failed.length ? 1 : 0);
