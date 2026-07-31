// Concord backup/restore suite.
// Usage: node test/backup.mjs        (no dev server, no browser — pure logic)
//
// public/backup.js is the only module in the app whose bugs are permanent.
// Every other failure is a bad render or a dropped socket; a restore that
// silently overwrites a per-server identity orphans messages that nobody —
// not the user, not the server owner — can ever edit or delete again. So this
// leans hard on the two things that can't be undone: that parseBundle refuses
// anything it doesn't fully understand, and that a merge never overwrites an
// identity that's already here.

import {
  FORMAT,
  SCHEMA_VERSION,
  exportBundle,
  toText,
  toFile,
  parseBundle,
  applyBundle,
  bundleWarnings,
  describeBundle,
  redactBundle,
  bundleSize,
  byteLength,
  formatBytes,
} from "../public/backup.js";

let passed = 0;
let failures = 0;
const ok = (l) => {
  passed++;
  console.log(`  PASS ${l}`);
};
const bad = (l, d) => {
  failures++;
  console.error(`  FAIL ${l}${d ? ` — ${d}` : ""}`);
};
const check = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));
const section = (t) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 62 - t.length))}`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ------------------------------- fixtures -------------------------------- */

const SOURCES = () => ({
  account: { uid: "u-keith-0001", token: "tok-account-aaaa", tag: "keith" },
  identities: {
    ABCDEF: { userId: "me-on-abcdef", token: "tok-abcdef" },
    GHJKMN: { userId: "me-on-ghjkmn", token: "tok-ghjkmn" },
  },
  servers: [
    { code: "ABCDEF", name: "The Pit", icon: "🕳️" },
    { code: "GHJKMN", name: "Quiet Room", icon: "🤫" },
  ],
  profile: { userId: "u-keith-0001", name: "Keith", color: "#5865f2", avatar: "🙂", status: "here" },
  settings: {
    // preferences
    theme: "synthwave", volume: 80, ptt: true, pttKey: "ControlLeft", muted: { ABCDEF: true },
    // extras (opt-in)
    xp: 4200, achievements: ["first-word", "turbo"], notes: { "u-bob": "owes me a fiver" },
    saved: ["msg-1", "msg-2"], userVolumes: { "u-bob": 140 }, collapsed: { "ABCDEF::General": true },
    // device-local, must never travel
    micId: "hw:this-laptop-only",
  },
});

// Stands in for app.js's `store`: same get(key, fallback) / set(key, value)
// shape, minus the "concord-" prefix, which stays app.js's business.
function fakeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    get: (k, fb) => (k in data ? JSON.parse(JSON.stringify(data[k])) : fb),
    set: (k, v) => {
      data[k] = JSON.parse(JSON.stringify(v));
    },
  };
}

const AT = "2026-07-31T09:15:00.000Z";
const ORIGIN = "https://concord.jeffnugget.workers.dev";
const make = (opts = {}) => exportBundle(SOURCES(), { now: AT, origin: ORIGIN, ...opts });

/* ================================ export ================================= */
section("export: shape and self-description");

const core = make();
check(core.format === FORMAT && core.version === SCHEMA_VERSION, "bundle carries the format marker and schema version");
check(core.exportedAt === AT && core.origin === ORIGIN, "bundle records when and where it was made");
check(same(core.data.account, SOURCES().account), "account survives export intact");
check(same(core.data.identities, SOURCES().identities), "per-server identities survive export intact");
check(core.data.servers.length === 2 && core.data.servers[0].code === "ABCDEF", "server list (invite codes) is included");
check(core.data.profile.name === "Keith" && core.data.profile.userId === "u-keith-0001", "profile is included");

check(Array.isArray(core.readme) && core.readme.length >= 4, "bundle contains a human-readable readme");
const readme = core.readme.join(" ");
check(/@keith/.test(readme) && /2026-07-31/.test(readme), "readme names the account and the date");
check(/password/i.test(readme), "readme says out loud that the file is as sensitive as a password");
check(/2 servers/.test(readme), "readme counts the servers");
check(core.summary.tag === "keith" && core.summary.servers === 2 && core.summary.identities === 2, "embedded summary matches the payload");

section("export: inclusion tiers are actually opt-in");

check(core.data.settings.theme === "synthwave" && core.data.settings.volume === 80, "preferences are included by default");
check(core.data.extras === undefined, "extras are absent unless asked for");
for (const key of ["xp", "achievements", "notes", "saved", "userVolumes", "collapsed"]) {
  check(core.data.settings[key] === undefined, `private/bulky "${key}" is not smuggled into the prefs tier`);
}
const withExtras = make({ extras: true });
check(withExtras.data.extras.xp === 4200 && withExtras.data.extras.notes["u-bob"] === "owes me a fiver", "extras appear when opted in");
check(withExtras.data.settings.theme === "synthwave", "opting into extras doesn't disturb prefs");
check(withExtras.summary.includes.join(",") === "identity,preferences,extras", "summary lists every tier present");

const idOnly = make({ prefs: false });
check(idOnly.data.settings === undefined && idOnly.data.account, "prefs:false yields an identity-only bundle");

check(core.data.settings.micId === undefined && withExtras.data.extras.micId === undefined, "the device-local mic id never leaves this machine");

const unknownPref = exportBundle({ ...SOURCES(), settings: { newToggle: true, hugeCache: "x".repeat(5000) } }, { now: AT });
check(unknownPref.data.settings.newToggle === true, "an unrecognised small setting still gets backed up");
check(unknownPref.data.settings.hugeCache === undefined, "an unrecognised oversized value is dropped, not hoovered up");
check(same(unknownPref.omitted, ["hugeCache"]), "the bundle names what it left behind");

section("export: junk in, clean bundle out");

const junk = exportBundle(
  {
    account: { uid: "u1", token: 12345 }, // token isn't a string
    identities: { GOOD: { userId: "a", token: "b" }, BAD: { userId: "a" }, "": { userId: "x", token: "y" } },
    servers: [{ code: "AAA" }, { name: "no code" }, null, { code: "AAA" }],
    profile: "nope",
    settings: null,
  },
  { now: AT, origin: ORIGIN }
);
check(junk.data.account === undefined, "a half-formed account is dropped rather than exported broken");
check(same(Object.keys(junk.data.identities), ["GOOD"]), "identities missing a token are dropped");
check(junk.data.servers.length === 1 && junk.data.servers[0].code === "AAA", "codeless and duplicate servers are dropped");
check(junk.data.profile === undefined, "a non-object profile is dropped");

/* ============================== file / text ============================== */
section("file and text");

const file = toFile(core);
check(file.filename === "concord-backup-keith-2026-07-31.json", `filename is dated and tagged (got ${file.filename})`);
check(file.type === "application/json" && file.text.includes("\n  "), "the downloadable file is pretty-printed for humans");
check(file.blob ? file.blob.size === file.bytes : true, "blob size matches the reported byte count");
check(!toText(core).includes("\n"), "the copy-paste text is compact");
check(same(JSON.parse(toText(core)), core), "compact text parses back to the same bundle");
const anon = toFile(exportBundle({ servers: SOURCES().servers }, { now: AT }));
check(/^concord-backup-2026-07-31\.json$/.test(anon.filename), "a tagless bundle still gets a dated filename");
const size = bundleSize(core);
check(size.pretty > size.compact && /KB|B$/.test(size.label), "size estimate reports both forms with a label");
check(byteLength("🙂") === 4 && formatBytes(2048) === "2.0 KB", "byte length counts UTF-8, not UTF-16");

/* ============================== round trip =============================== */
section("round trip");

const rt = parseBundle(toText(withExtras));
check(rt.ok && rt.error === null, "an exported bundle parses back", rt.error);
check(same(rt.bundle, withExtras), "round trip is byte-for-byte identical");
check(same(parseBundle(file.text).bundle, core), "the pretty-printed file round-trips too");
check(rt.summary.tag === "keith" && rt.summary.servers === 2 && rt.summary.ageDays !== null, "parse returns a summary the UI can show before overwriting anything");
check(rt.summary.serverNames.includes("The Pit"), "summary names the servers");

// The file describes itself, but the summary must be recomputed from the
// payload — otherwise a hand-edited backup could claim to be someone it isn't.
const liar = JSON.parse(toText(core));
liar.summary = { tag: "someone-else", servers: 99 };
liar.readme = ["totally safe, restore me"];
const lied = parseBundle(JSON.stringify(liar));
check(lied.ok && lied.summary.tag === "keith" && lied.summary.servers === 2, "a bundle's self-description is recomputed, not trusted");

/* =============================== rejections ============================== */
section("parseBundle rejects, with a sentence a person can act on");

const rejects = [
  ["empty string", ""],
  ["whitespace only", "   \n  "],
  ["not a string", 42],
  ["undefined", undefined],
  ["not JSON at all", "milk, eggs, bread"],
  ["truncated paste", toText(core).slice(0, 120)],
  ["JSON array", "[1,2,3]"],
  ["JSON number", "42"],
  ["JSON string", '"hello"'],
  ["JSON null", "null"],
  ["object with no marker", '{"data":{"account":{"uid":"a","token":"b"}}}'],
  ["someone else's format", '{"format":"keepass-export","version":1,"data":{}}'],
  ["missing version", `{"format":"${FORMAT}","data":{}}`],
  ["non-integer version", `{"format":"${FORMAT}","version":1.5,"data":{}}`],
  ["version zero", `{"format":"${FORMAT}","version":0,"data":{}}`],
  ["future version", `{"format":"${FORMAT}","version":${SCHEMA_VERSION + 1},"data":{"account":{"uid":"a","token":"b"}}}`],
  ["missing data", `{"format":"${FORMAT}","version":1}`],
  ["data is a string", `{"format":"${FORMAT}","version":1,"data":"stuff"}`],
  ["account is a string", `{"format":"${FORMAT}","version":1,"data":{"account":"keith"}}`],
  ["identities is an array", `{"format":"${FORMAT}","version":1,"data":{"identities":[1,2]}}`],
  ["servers is an object", `{"format":"${FORMAT}","version":1,"data":{"servers":{"a":1}}}`],
  ["profile is a number", `{"format":"${FORMAT}","version":1,"data":{"profile":7}}`],
  ["settings is an array", `{"format":"${FORMAT}","version":1,"data":{"account":{"uid":"a","token":"b"},"settings":[]}}`],
  ["extras is a string", `{"format":"${FORMAT}","version":1,"data":{"account":{"uid":"a","token":"b"},"extras":"x"}}`],
  ["nothing restorable inside", `{"format":"${FORMAT}","version":1,"data":{"profile":{"name":"Keith"}}}`],
  ["identity-shaped but all rows broken", `{"format":"${FORMAT}","version":1,"data":{"identities":{"A":{"userId":"x"}}}}`],
];
for (const [label, input] of rejects) {
  let r;
  try {
    r = parseBundle(input);
  } catch (e) {
    bad(`rejects ${label}`, `threw ${e.message}`);
    continue;
  }
  const usable = !r.ok && r.bundle === null && typeof r.error === "string" && r.error.length > 20 && /[.!]$/.test(r.error);
  check(usable, `rejects ${label} with a readable message`, r.ok ? "accepted it" : `weak error: ${JSON.stringify(r.error)}`);
}

const truncated = parseBundle(toText(core).slice(0, 200));
check(/cut short/i.test(truncated.error), "a truncated paste is diagnosed as truncated, not as bad JSON");
const future = parseBundle(`{"format":"${FORMAT}","version":9,"data":{"account":{"uid":"a","token":"b"}}}`);
check(/newer version/i.test(future.error) && /update/i.test(future.error), "a future bundle tells you to update rather than guessing");

section("parseBundle salvages row damage instead of discarding the file");

const halfDamaged = {
  format: FORMAT,
  version: 1,
  exportedAt: AT,
  origin: ORIGIN,
  data: {
    account: { uid: "u1", token: "t1", tag: "keith" },
    identities: { GOOD: { userId: "a", token: "b" }, BROKEN: { userId: "a", token: null } },
    servers: [{ code: "AAA", name: "Fine" }, { name: "no code" }],
  },
};
const salvage = parseBundle(JSON.stringify(halfDamaged));
check(salvage.ok, "a backup with two bad rows still restores the good ones", salvage.error);
check(same(Object.keys(salvage.bundle.data.identities), ["GOOD"]) && salvage.bundle.data.servers.length === 1, "the damaged rows are gone");
check(salvage.summary.dropped === 2, "the summary counts what it had to drop");
check(bundleWarnings(salvage.bundle).some((w) => /damaged/i.test(w)), "and a warning says so");

/* ================================= fuzz ================================== */
section("fuzz: parseBundle never throws");

const seeds = [
  "", "{", "}", "[]", "null", "undefined", "NaN", "0", "-1", "1e999", '"', "{}",
  '{"format":null}', '{"format":{},"version":{},"data":{}}',
  `{"format":"${FORMAT}","version":1,"data":{"account":{"uid":{},"token":[]}}}`,
  `{"format":"${FORMAT}","version":1,"data":{"identities":{"A":null,"B":[],"C":"x"}}}`,
  `{"format":"${FORMAT}","version":1,"data":{"servers":[null,0,"","[]",{"code":{}}]}}`,
  `{"format":"${FORMAT}","version":true,"data":[]}`,
  '{"__proto__":{"polluted":true},"format":"' + FORMAT + '","version":1,"data":{}}',
  " ", "😀".repeat(200), "<script>alert(1)</script>",
];
const chars = `{}[]",:0189aAzZ\\/ \n\t éé😀-_.null truefalse`;
let fuzzed = 0;
let thrown = 0;
let accepted = 0;
for (const s of seeds) {
  fuzzed++;
  try {
    if (parseBundle(s).ok) accepted++;
  } catch {
    thrown++;
    bad("fuzz", `seed threw: ${JSON.stringify(s.slice(0, 40))}`);
  }
}
// Deterministic pseudo-random garbage, plus bit-rot of a real bundle: the two
// ways a backup actually arrives broken.
let seedNum = 1337;
const rnd = () => ((seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const good = toText(withExtras);
for (let i = 0; i < 3000; i++) {
  let s;
  if (i % 3 === 0) {
    const len = Math.floor(rnd() * 120);
    s = Array.from({ length: len }, () => chars[Math.floor(rnd() * chars.length)]).join("");
  } else if (i % 3 === 1) {
    s = good.slice(0, Math.floor(rnd() * good.length)); // truncation at every point
  } else {
    const at = Math.floor(rnd() * good.length);
    s = good.slice(0, at) + chars[Math.floor(rnd() * chars.length)] + good.slice(at + 1); // one flipped byte
  }
  fuzzed++;
  try {
    const r = parseBundle(s);
    if (r.ok) {
      accepted++;
      // Anything it does accept must still be safe to hand to applyBundle.
      applyBundle(r.bundle, { mode: "merge", ...fakeStore() });
    } else if (typeof r.error !== "string" || !r.error) {
      bad("fuzz", "rejected without an error message");
    }
  } catch (e) {
    thrown++;
    bad("fuzz", `threw ${e.message} on ${JSON.stringify(s.slice(0, 60))}`);
  }
}
check(thrown === 0, `parseBundle survived ${fuzzed} hostile inputs without throwing`, `${thrown} threw`);
check(accepted >= 1, `${accepted} mutations happened to stay valid and were all still safe to apply`);
check(({}).polluted === undefined, "a __proto__ key in a bundle doesn't pollute Object.prototype");

/* ================================ apply ================================== */
section("apply: restoring into an empty browser");

{
  const store = fakeStore();
  const parsed = parseBundle(toText(withExtras));
  const res = applyBundle(parsed.bundle, { mode: "merge", get: store.get, set: store.set });
  check(res.ok && res.applied.length > 0, "a fresh browser accepts the whole bundle");
  check(same(store.data.account, SOURCES().account), "account written");
  check(same(store.data.identities, SOURCES().identities), "both server identities written");
  check(store.data.servers.length === 2, "servers written");
  check(store.data.profile.name === "Keith", "profile written");
  check(store.data.settings.theme === "synthwave" && store.data.settings.xp === 4200, "prefs and extras written");
  check(store.data.settings.micId === undefined, "restore never invents a mic id");
  check(res.applied.some((l) => /Account @keith/.test(l)), "the report names what it restored", res.applied.join(" | "));
}

section("apply: dry run");

{
  const store = fakeStore();
  const res = applyBundle(make(), { mode: "replace", get: store.get, set: store.set, dryRun: true });
  check(res.ok && res.applied.length > 0, "a dry run still reports what it would do");
  check(Object.keys(store.data).length === 0, "a dry run writes nothing");
  check(res.warnings.some((w) => /Preview only/i.test(w)), "and says it was only a preview");
}

section("apply: merge keeps the identity that's already here");

{
  // The dangerous case: this browser is already someone else on ABCDEF.
  const store = fakeStore({
    account: { uid: "u-other", token: "tok-other", tag: "other" },
    identities: { ABCDEF: { userId: "someone-else", token: "tok-else" } },
    servers: [{ code: "ZZZZZZ", name: "Local only", icon: "📦" }],
    profile: { userId: "u-other", name: "Other", color: "#fff", avatar: "🙃", status: "" },
    settings: { theme: "nord", volume: 11, micId: "hw:this-machine" },
  });
  const res = applyBundle(make({ extras: true }), { mode: "merge", get: store.get, set: store.set });

  check(store.data.account.uid === "u-other", "merge does not swap the hub account");
  check(res.warnings.some((w) => /different account/i.test(w)), "and warns that the backup holds a different one");
  check(store.data.identities.ABCDEF.userId === "someone-else", "merge leaves a colliding server identity alone");
  check(
    res.warnings.some((w) => /orphan/i.test(w) && /The Pit/.test(w)),
    "and explains the collision by server name, in terms of orphaned messages",
    res.warnings.join(" | ")
  );
  check(res.skipped.some((l) => /The Pit/.test(l)), "the skip is reported, not silent");
  check(store.data.identities.GHJKMN.userId === "me-on-ghjkmn", "merge does fill the gap where no identity existed");
  check(store.data.servers.map((s) => s.code).join(",") === "ZZZZZZ,ABCDEF,GHJKMN", "merge unions the server rail, local first");
  check(store.data.profile.name === "Other", "merge keeps the local profile");
  check(store.data.settings.theme === "nord" && store.data.settings.volume === 11, "merge never overwrites a setting you already chose");
  check(store.data.settings.ptt === true && store.data.settings.xp === 4200, "merge fills settings you never set");
  check(store.data.settings.micId === "hw:this-machine", "merge leaves the device-local mic id alone");
  check(res.displaced === null, "merge displaced nothing, because it overwrote nothing");
}

section("apply: replace lets the backup win — without deleting");

{
  const store = fakeStore({
    account: { uid: "u-other", token: "tok-other", tag: "other" },
    identities: { ABCDEF: { userId: "someone-else", token: "tok-else" }, ZZZZZZ: { userId: "me-on-zzz", token: "tok-zzz" } },
    servers: [{ code: "ZZZZZZ", name: "Local only", icon: "📦" }],
    profile: { userId: "u-other", name: "Other", color: "#fff", avatar: "🙃", status: "" },
    settings: { theme: "nord", volume: 11, micId: "hw:this-machine" },
  });
  const res = applyBundle(make({ extras: true }), { mode: "replace", get: store.get, set: store.set });

  check(store.data.account.uid === "u-keith-0001", "replace swaps in the backup's account");
  check(same(res.displaced.account, { uid: "u-other", token: "tok-other", tag: "other" }), "the displaced account is handed back so the UI can offer to save it");
  check(res.warnings.some((w) => /@other/.test(w) && /unreachable|lives nowhere/i.test(w)), "and the loss is stated plainly", res.warnings.join(" | "));
  check(store.data.identities.ABCDEF.userId === "me-on-abcdef", "replace overwrites a colliding identity");
  check(res.displaced.identities.ABCDEF.userId === "someone-else", "the displaced identity is handed back too");
  check(store.data.identities.ZZZZZZ.userId === "me-on-zzz", "replace does NOT delete an identity the backup never mentioned");
  check(store.data.servers.some((s) => s.code === "ZZZZZZ"), "replace does NOT drop a server the backup never mentioned");
  check(store.data.servers[0].code === "ABCDEF", "replace puts the backup's rail order first");
  check(res.warnings.some((w) => /never removes a server/i.test(w)), "and says why the extra server was kept");
  check(store.data.profile.name === "Keith", "replace takes the backup's profile");
  check(store.data.settings.theme === "synthwave" && store.data.settings.volume === 80, "replace takes the backup's settings");
  check(store.data.settings.micId === "hw:this-machine", "replace still doesn't touch the device-local mic id");
}

section("apply: the quiet cases");

{
  const store = fakeStore({ account: { uid: "u-keith-0001", token: "tok-account-aaaa", tag: "keith" } });
  const res = applyBundle(make(), { mode: "merge", get: store.get, set: store.set });
  check(res.skipped.some((l) => /already/i.test(l)), "restoring the same account onto itself is reported as a no-op");
}
{
  const store = fakeStore({ account: { uid: "u-keith-0001", token: "tok-STALE", tag: "keith" } });
  applyBundle(make(), { mode: "merge", get: store.get, set: store.set });
  check(store.data.account.token === "tok-STALE", "same account, different token: merge keeps the token this browser is using");
  const store2 = fakeStore({ account: { uid: "u-keith-0001", token: "tok-STALE", tag: "keith" } });
  const r2 = applyBundle(make(), { mode: "replace", get: store2.get, set: store2.set });
  check(store2.data.account.token === "tok-account-aaaa", "replace takes the backup's token");
  check(r2.warnings.some((w) => /older of the two/i.test(w)), "and warns it might be the older one");
}
{
  const res = applyBundle(make(), { mode: "merge" });
  check(!res.ok && res.warnings.length === 1 && res.applied.length === 0, "apply without a storage adapter refuses instead of throwing");
}
{
  const store = fakeStore();
  const res = applyBundle({ format: "nope" }, { mode: "merge", get: store.get, set: store.set });
  check(!res.ok && Object.keys(store.data).length === 0, "apply re-validates: a bundle that never went through parseBundle writes nothing");
}
{
  const store = fakeStore();
  const res = applyBundle(make(), { mode: "sideways", get: store.get, set: store.set });
  check(res.ok && res.warnings.some((w) => /treated as merge/i.test(w)), "an unknown mode falls back to the non-destructive one, loudly");
}
{
  // The setter is the only way out, so a store that explodes on read must not
  // take the restore down with it.
  const boom = { get: () => { throw new Error("storage evicted"); }, set: () => {} };
  let threw = false;
  try {
    applyBundle(make(), { mode: "merge", ...boom });
  } catch {
    threw = true;
  }
  check(!threw, "a throwing storage read doesn't break the restore");
}

/* =============================== warnings ================================ */
section("warnings and redaction");

const warns = bundleWarnings(parseBundle(toText(core)).bundle);
check(warns.some((w) => /like a password/i.test(w) && /post as you/i.test(w)), "warns that the bundle is as sensitive as a password");
check(warns.some((w) => /copy, not a move/i.test(w)), "warns that exporting doesn't disable the old browser");
check(warns.some((w) => /DM and group codes/i.test(w) && /come back/i.test(w)), "explains that DM codes return from the server on their own");
check(warns.some((w) => /Extras were not included/i.test(w)), "says which tier is missing from this particular bundle");
check(!bundleWarnings(parseBundle(toText(withExtras)).bundle).some((w) => /Extras were not included/i.test(w)), "and doesn't say it when extras are present");
const stale = parseBundle(toText(exportBundle(SOURCES(), { now: "2024-01-01T00:00:00.000Z", origin: ORIGIN })));
check(bundleWarnings(stale.bundle).some((w) => /days old/i.test(w)), "an old backup says how old it is");
const noAccount = exportBundle({ servers: SOURCES().servers }, { now: AT });
check(bundleWarnings(noAccount).some((w) => /no account token/i.test(w)), "a bundle without an account token admits what it can't restore");
check(bundleWarnings(noAccount).some((w) => /no per-server logins/i.test(w)), "and a bundle without identities admits it too");

const red = redactBundle(withExtras);
const redText = JSON.stringify(red);
check(!redText.includes("tok-account-aaaa") && !redText.includes("tok-abcdef"), "redaction removes every token");
// Invite codes are credentials in their own right, and they leak twice: in the
// server list, and as the keys of `muted` and `collapsed`.
check(!redText.includes("ABCDEF"), "redaction masks invite codes everywhere they appear, settings keys included");
check(typeof red.data.settings === "string" && /hidden/.test(red.data.settings), "settings collapse to a count instead of being displayed");
check(redText.includes("aaaa") || redText.includes("•"), "redaction leaves a tail so two backups can be told apart");
check(red.redacted === true && withExtras.data.account.token === "tok-account-aaaa", "redaction returns a copy and doesn't damage the original");
check(describeBundle(red).servers === 2, "a redacted bundle can still be described");

/* ================================ verdict ================================ */

if (failures) {
  console.error(`\n${failures} CHECK${failures === 1 ? "" : "S"} FAILED (${passed} passed)`);
  process.exit(1);
}
console.log(`\nALL ${passed} CHECKS PASSED`);
process.exit(0);
