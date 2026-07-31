// Backup and restore for the only thing in Concord that can't be re-derived:
// who you are.
//
// There is no email, no password, no "log in again". Your identity is four
// localStorage keys — `concord-account` (the hub account and its token),
// `concord-identities` (a per-server userId + token), `concord-servers` (the
// invite codes, which are themselves the credential) and `concord-profile`.
// Clear the browser, evict the origin under storage pressure, reinstall, run a
// cleanup tool, and every one of those is gone permanently. You lose your @tag,
// your friend graph, your DMs, your group chats, and the ability to edit or
// delete anything you've ever posted. That is what this file exists to prevent.
//
// What it deliberately does NOT back up: DM conversation codes and group codes.
// Those come back on their own — the hub's `hello` takes {uid, token} and the
// `hub-welcome` reply carries every friend's `dm` code and every group you're
// in, straight out of the Durable Object. So the account token IS the DM
// backup. Storing the codes again would only add a second copy of a secret.
//
// Nothing here touches localStorage or `state`. Sources come in as an argument
// and writes go out through a caller-supplied setter, so app.js keeps ownership
// of its storage keys and this whole module is testable in plain Node.

export const FORMAT = "concord-backup";
export const SCHEMA_VERSION = 1;
const MIN_VERSION = 1;

/* ------------------------------- tiers ---------------------------------- */
// Settings are split by "what does losing this actually cost you".
//
// Preferences are small, portable, and pleasant to get back — how the app
// looks and sounds on a new machine. On by default.
const PREF_KEYS = [
  "ptt", "pttKey", "sounds", "volume", "notifs", "gremlin", "mascot", "board",
  "fx", "fxPitch", "presence", "muted", "embeds", "tts", "autoIdle", "theme", "turbo",
];

// Bulky, regenerable, or private-to-this-device. XP and achievements are local
// progression that nothing else can see; notes, saved messages and folded
// categories are about how *you* read this place; userVolumes is per-person
// mixing that only makes sense next to the mic you set it with. None of it is
// irreplaceable and some of it is the most personal text in the app, so it is
// opt-in — you have to ask for it, and then you have to keep the file safe.
const EXTRA_KEYS = [
  "xp", "stats", "achievements", "seenThemes", "triedVoices", "gorbHits",
  "userVolumes", "saved", "notes", "collapsed",
];

// Meaningless or actively wrong on another machine. A mic device id from one
// computer names nothing on the next, and restoring it points capture at a
// device that isn't there.
const DEVICE_KEYS = ["micId"];

// Settings this module has never heard of still get carried, because app.js
// gains preferences faster than this file will be revisited and a silently
// un-backed-up setting is a bug nobody notices. The size cap is the guard: a
// small scalar or a short list is a preference, a 40 KB blob is a cache or a
// log and has no business in an identity backup.
const UNKNOWN_LIMIT = 2048;

/* ------------------------------- helpers -------------------------------- */

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const text = (v, max = 200) => (isStr(v) ? v.slice(0, max) : "");
const day = (iso) => String(iso || "").slice(0, 10);

// Everything below sanitises rather than trusts: a bundle that reached us from
// a paste box is hostile input, and a bundle we wrote ourselves should come out
// the far side of a round trip byte-identical. One set of cleaners gives both.

function cleanAccount(v, dropped) {
  if (!isObj(v)) {
    if (v !== undefined && v !== null) dropped?.push("account (not an object)");
    return null;
  }
  const uid = text(v.uid, 64);
  const token = text(v.token, 128);
  // Half an account is worse than none — it would present a uid with the wrong
  // token, and the worker hands that a brand new account instead of yours.
  if (!uid || !token) {
    dropped?.push("account (missing uid or token)");
    return null;
  }
  const out = { uid, token };
  if (isStr(v.tag) && v.tag) out.tag = text(v.tag, 20);
  return out;
}

function cleanIdentities(v, dropped) {
  if (!isObj(v)) return {};
  const out = {};
  for (const [code, row] of Object.entries(v)) {
    if (!code || !isObj(row)) {
      dropped?.push(`identity ${code || "(blank code)"}`);
      continue;
    }
    const userId = text(row.userId, 64);
    const token = text(row.token, 128);
    if (!userId || !token) {
      dropped?.push(`identity ${code}`);
      continue;
    }
    out[code] = { userId, token };
  }
  return out;
}

function cleanServers(v, dropped) {
  if (!Array.isArray(v)) return [];
  const out = [];
  const seen = new Set();
  for (const s of v) {
    const code = isObj(s) ? text(s.code, 32) : "";
    if (!code || seen.has(code)) {
      dropped?.push("a server entry");
      continue;
    }
    seen.add(code);
    out.push({ code, name: text(isObj(s) ? s.name : "", 64), icon: text(isObj(s) ? s.icon : "", 16) });
  }
  return out;
}

function cleanProfile(v, dropped) {
  if (!isObj(v)) {
    if (v !== undefined && v !== null) dropped?.push("profile (not an object)");
    return null;
  }
  const out = {};
  for (const [k, max] of [["userId", 64], ["name", 32], ["color", 16], ["avatar", 8], ["status", 60]]) {
    if (v[k] !== undefined && v[k] !== null) out[k] = text(v[k], max);
  }
  return Object.keys(out).length ? out : null;
}

// Splits a settings object into the tiers above. Unknown keys ride along in
// prefs if they're small enough; anything over the cap is named in `omitted`
// so the export can say what it left behind instead of quietly shrinking.
function splitSettings(settings) {
  const prefs = {};
  const extras = {};
  const omitted = [];
  if (!isObj(settings)) return { prefs, extras, omitted };
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined || DEVICE_KEYS.includes(key)) continue;
    if (EXTRA_KEYS.includes(key)) {
      extras[key] = clone(value);
      continue;
    }
    if (PREF_KEYS.includes(key)) {
      prefs[key] = clone(value);
      continue;
    }
    let size = 0;
    try {
      size = JSON.stringify(value)?.length || 0;
    } catch {
      omitted.push(key); // circular or otherwise unserialisable
      continue;
    }
    if (size > UNKNOWN_LIMIT) omitted.push(key);
    else prefs[key] = clone(value);
  }
  return { prefs, extras, omitted };
}

/* -------------------------------- export -------------------------------- */

// `sources` mirrors app.js's own shapes: {account, identities, servers,
// profile, settings}. `opts.extras` opts into the private tier, `opts.prefs`
// (default true) can drop preferences for an identity-only bundle.
export function exportBundle(sources = {}, opts = {}) {
  const { extras = false, prefs = true } = opts;
  const at = opts.now ? new Date(opts.now) : new Date();
  const exportedAt = (Number.isNaN(at.getTime()) ? new Date() : at).toISOString();
  const origin =
    opts.origin !== undefined
      ? String(opts.origin)
      : typeof location !== "undefined" && location?.origin
        ? location.origin
        : "";

  const data = {};
  const account = cleanAccount(sources.account);
  const identities = cleanIdentities(sources.identities);
  const servers = cleanServers(sources.servers);
  const profile = cleanProfile(sources.profile);
  if (account) data.account = account;
  if (Object.keys(identities).length) data.identities = identities;
  if (servers.length) data.servers = servers;
  if (profile) data.profile = profile;

  const split = splitSettings(sources.settings);
  if (prefs && Object.keys(split.prefs).length) data.settings = split.prefs;
  if (extras && Object.keys(split.extras).length) data.extras = split.extras;

  const bundle = { format: FORMAT, version: SCHEMA_VERSION, exportedAt, origin, data };
  bundle.summary = describeBundle(bundle);
  bundle.readme = readmeFor(bundle);
  if (prefs && split.omitted.length) bundle.omitted = split.omitted.slice().sort();
  return bundle;
}

// Lives inside the file on purpose. Someone opening this in Notepad in 2028
// should be able to tell what it is, whose it is, and whether it's the right
// one, without this app or this comment.
function readmeFor(bundle) {
  const s = bundle.summary || describeBundle(bundle);
  const who = s.tag ? `@${s.tag}` : s.name || "an unnamed account";
  return [
    "This is a Concord account backup. It is the only copy of an identity that exists nowhere else.",
    `Made ${day(bundle.exportedAt)} for ${who}${s.name && s.tag ? ` (${s.name})` : ""} — ` +
      `${s.servers} server${s.servers === 1 ? "" : "s"}, ${s.identities} server identit${s.identities === 1 ? "y" : "ies"}` +
      `${s.includes.length ? `, includes: ${s.includes.join(", ")}` : ""}.`,
    "TREAT THIS FILE LIKE A PASSWORD. Anyone who has it can sign in as this person, read their DMs, and post as them.",
    "To use it: open Concord, go to Settings, and paste this whole file into Restore.",
    "DMs and group chats are not in here and do not need to be — they come back from the server once the account is restored.",
  ];
}

/* ------------------------------ file / text ----------------------------- */

// Two paths because people keep backups two ways. The file is pretty-printed:
// it will be opened in a text editor one day and the readme has to be legible.
// The text is compact: it gets pasted into a note, a password manager, or a
// message to yourself, and every wasted byte is wasted scroll.
export function toText(bundle) {
  return JSON.stringify(bundle);
}

export function toFile(bundle) {
  const body = JSON.stringify(bundle, null, 2);
  const tag = (bundle?.summary?.tag || bundle?.data?.account?.tag || "").replace(/[^a-z0-9._-]/gi, "");
  const filename = `concord-backup-${tag ? tag + "-" : ""}${day(bundle?.exportedAt) || day(new Date().toISOString())}.json`;
  const type = "application/json";
  // Node has Blob from 18 on, but this must not explode if it doesn't — the
  // caller can still fall back to the text path.
  const blob = typeof Blob === "function" ? new Blob([body], { type }) : null;
  return { blob, filename, type, text: body, bytes: byteLength(body) };
}

// UTF-8 length, not string length: an avatar emoji is four bytes and a size
// estimate that says otherwise is a lie on exactly the accounts that need one.
export function byteLength(s) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(String(s)).length;
  return Buffer.byteLength(String(s), "utf8");
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// What a download would weigh, for a UI that wants to say so before offering it.
export function bundleSize(bundle) {
  const compact = byteLength(toText(bundle));
  const pretty = byteLength(JSON.stringify(bundle, null, 2));
  return { compact, pretty, label: formatBytes(pretty) };
}

/* -------------------------------- parse --------------------------------- */

// Every rejection here is something a real person will actually do: paste half
// a file, paste the wrong file, paste a shopping list, or bring a bundle from a
// newer build. Each one gets a sentence they can act on, and none of them throw.
export function parseBundle(input) {
  if (typeof input !== "string" || !input.trim()) {
    return fail("There's nothing here to restore — paste a backup first.");
  }
  const trimmed = input.trim();
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    // A backup always starts with `{`. If it starts right and ends wrong, the
    // paste was cut short, and saying so beats "unexpected end of input".
    if (trimmed.startsWith("{") && !trimmed.endsWith("}")) {
      return fail("That backup looks cut short — copy the whole file, from the first { to the last }.");
    }
    return fail("That isn't a Concord backup — it isn't even valid JSON.");
  }
  const norm = normalize(raw);
  if (!norm.ok) return fail(norm.error);
  return { ok: true, bundle: norm.bundle, error: null, summary: norm.bundle.summary };
}

const fail = (error) => ({ ok: false, bundle: null, error, summary: null });

// Shared by parse and apply: apply must never assume it was handed something
// parseBundle already blessed, or the one caller who skips the check gets to
// write junk into localStorage.
function normalize(raw) {
  if (!isObj(raw)) return { ok: false, error: "That isn't a Concord backup — a backup is a JSON object." };
  if (raw.format !== FORMAT) {
    return {
      ok: false,
      error: raw.format
        ? `That's a "${text(raw.format, 40)}" file, not a Concord backup.`
        : "That isn't a Concord backup — it has no Concord backup marker in it.",
    };
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < MIN_VERSION) {
    return { ok: false, error: "That backup doesn't say which format it's in, so it can't be trusted." };
  }
  if (raw.version > SCHEMA_VERSION) {
    return {
      ok: false,
      error: `That backup was made by a newer version of Concord (format v${raw.version}, this one reads v${SCHEMA_VERSION}). Update Concord, then try again.`,
    };
  }
  if (!isObj(raw.data)) return { ok: false, error: "That backup is missing its contents." };

  // Hard failures are container-shaped: if `identities` is a string, the file
  // is not what it claims and nothing in it can be trusted. Row-shaped damage
  // is different — one bad identity out of five shouldn't cost you the other
  // four, so bad rows are dropped and counted, and the summary says so.
  if (raw.data.account !== undefined && raw.data.account !== null && !isObj(raw.data.account)) {
    return { ok: false, error: "That backup's account section is damaged." };
  }
  if (raw.data.identities !== undefined && !isObj(raw.data.identities)) {
    return { ok: false, error: "That backup's server identities are damaged." };
  }
  if (raw.data.servers !== undefined && !Array.isArray(raw.data.servers)) {
    return { ok: false, error: "That backup's server list is damaged." };
  }
  if (raw.data.profile !== undefined && raw.data.profile !== null && !isObj(raw.data.profile)) {
    return { ok: false, error: "That backup's profile section is damaged." };
  }
  if (raw.data.settings !== undefined && !isObj(raw.data.settings)) {
    return { ok: false, error: "That backup's settings are damaged." };
  }
  if (raw.data.extras !== undefined && !isObj(raw.data.extras)) {
    return { ok: false, error: "That backup's extras are damaged." };
  }

  const dropped = [];
  const data = {};
  const account = cleanAccount(raw.data.account, dropped);
  const identities = cleanIdentities(raw.data.identities, dropped);
  const servers = cleanServers(raw.data.servers, dropped);
  const profile = cleanProfile(raw.data.profile, dropped);
  if (account) data.account = account;
  if (Object.keys(identities).length) data.identities = identities;
  if (servers.length) data.servers = servers;
  if (profile) data.profile = profile;
  if (isObj(raw.data.settings) && Object.keys(raw.data.settings).length) data.settings = clone(raw.data.settings);
  if (isObj(raw.data.extras) && Object.keys(raw.data.extras).length) data.extras = clone(raw.data.extras);

  if (!data.account && !data.identities && !data.servers) {
    return {
      ok: false,
      error: "That backup has no identity in it — no account, no server logins, no servers. There's nothing to restore.",
    };
  }

  const exportedAt = isStr(raw.exportedAt) ? raw.exportedAt : "";
  const bundle = { format: FORMAT, version: raw.version, exportedAt, origin: text(raw.origin, 200), data };
  // The summary is recomputed rather than read: a file's description of itself
  // is written by whoever wrote the file, and the restore prompt is exactly
  // where a lie would do damage.
  bundle.summary = describeBundle(bundle, dropped);
  bundle.readme = readmeFor(bundle);
  if (Array.isArray(raw.omitted) && raw.omitted.length) bundle.omitted = raw.omitted.filter(isStr).slice(0, 50);
  return { ok: true, bundle };
}

/* ------------------------------- describe ------------------------------- */

// Enough for "this backup has 4 servers and the tag @keith, made 3 days ago —
// restore it?" without opening the bundle itself.
export function describeBundle(bundle, dropped = []) {
  const d = isObj(bundle?.data) ? bundle.data : {};
  const servers = Array.isArray(d.servers) ? d.servers : [];
  const identities = isObj(d.identities) ? d.identities : {};
  const includes = [];
  if (d.account || Object.keys(identities).length) includes.push("identity");
  if (d.settings) includes.push("preferences");
  if (d.extras) includes.push("extras");

  const exportedAt = isStr(bundle?.exportedAt) ? bundle.exportedAt : "";
  const when = exportedAt ? Date.parse(exportedAt) : NaN;
  const ageDays = Number.isNaN(when) ? null : Math.max(0, Math.floor((Date.now() - when) / 86400000));

  return {
    tag: text(d.account?.tag, 20),
    name: text(d.profile?.name, 32),
    uid: text(d.account?.uid, 64),
    hasAccount: !!d.account,
    servers: servers.length,
    serverNames: servers.map((s) => s.name || s.code).slice(0, 12),
    identities: Object.keys(identities).length,
    includes,
    exportedAt,
    date: day(exportedAt),
    ageDays,
    origin: text(bundle?.origin, 200),
    version: bundle?.version ?? null,
    dropped: dropped.length,
    droppedNames: dropped.slice(0, 8),
  };
}

/* -------------------------------- warnings ------------------------------ */

// The caveats that belong on screen next to a restore button. Blunt on purpose:
// the two things people get wrong are thinking a backup is harmless to share,
// and thinking an export moves them off the old browser.
export function bundleWarnings(bundle) {
  const s = bundle?.summary || describeBundle(bundle);
  const out = [
    "Treat this backup like a password. Anyone who has it can sign in as you, read your DMs, and post as you — there is no password to change afterwards.",
    "Exporting is a copy, not a move. The browser you exported from still works, and still has your identity in it.",
    "A restore brings back who you are, not what was said. Messages, DMs and group chats live on the servers and reappear once you reconnect — anything a server has already deleted stays gone.",
    "DM and group codes are not in this file and don't need to be: they come back from Concord as soon as your account token is restored.",
  ];
  if (!s.hasAccount) {
    out.push("This backup has no account token, so it can't bring back your @tag, your friends, or your DMs — only servers and per-server logins.");
  }
  if (!s.includes.includes("extras")) {
    out.push("Extras were not included: XP, achievements, saved messages, private notes and per-person volumes won't come back.");
  }
  if (!s.identities) {
    out.push("This backup has no per-server logins, so on each server you'll arrive as a new person and won't be able to edit or delete anything you posted before.");
  }
  if (typeof s.ageDays === "number" && s.ageDays > 30) {
    out.push(`This backup is ${s.ageDays} days old — anything you joined, renamed or changed since then isn't in it.`);
  }
  if (s.origin && typeof location !== "undefined" && location?.origin && s.origin !== location.origin) {
    out.push(`This backup was made on ${s.origin}, which isn't where you are now. Identities are per-install and probably won't work here.`);
  }
  if (s.dropped) {
    out.push(`${s.dropped} damaged entr${s.dropped === 1 ? "y was" : "ies were"} skipped while reading this backup.`);
  }
  return out;
}

/* -------------------------------- redact -------------------------------- */

// For showing a bundle on screen, or in a screenshot, or in a bug report. The
// last few characters stay so two backups can still be told apart. Server codes
// are masked too — in Concord the invite code IS the credential, and a visible
// one is an open door. Settings collapse to a count rather than being masked
// key by key, because `muted` and `collapsed` are themselves keyed by server
// code and nobody inspecting a backup needs to read their own preferences back.
//
// The result is for looking at, not for restoring: it is deliberately no longer
// a valid bundle, so it can't be mistaken for one.
export function redactBundle(bundle) {
  const copy = clone(bundle) || {};
  const mask = (v, keep = 4) => {
    const s = String(v || "");
    if (!s) return s;
    return s.length <= keep ? "•".repeat(s.length) : "•".repeat(Math.min(8, s.length - keep)) + s.slice(-keep);
  };
  const d = isObj(copy.data) ? copy.data : null;
  if (d) {
    if (isObj(d.account)) d.account.token = mask(d.account.token);
    if (isObj(d.identities)) {
      const next = {};
      for (const [code, row] of Object.entries(d.identities)) {
        next[mask(code, 2)] = { userId: row.userId, token: mask(row.token) };
      }
      d.identities = next;
    }
    if (Array.isArray(d.servers)) d.servers = d.servers.map((s) => ({ ...s, code: mask(s.code, 2) }));
    for (const key of ["settings", "extras"]) {
      if (isObj(d[key])) d[key] = `<${Object.keys(d[key]).length} hidden>`;
    }
  }
  copy.redacted = true;
  return copy;
}

/* -------------------------------- apply --------------------------------- */

// `get(key, fallback)` / `set(key, value)` are app.js's own `store`, so the keys
// here are unprefixed: "account", "identities", "servers", "profile", "settings".
//
// The governing rule, in both modes: **a restore never deletes.** This module
// exists because losing an identity is unrecoverable, and a restore that drops
// a server code or a server login you weren't backed up for would cause exactly
// the harm it's here to prevent. So "replace" means the backup wins wherever
// the two disagree — not that everything else is thrown away.
export function applyBundle(bundle, options = {}) {
  const { mode = "merge", get, set, dryRun = false } = options;
  const applied = [];
  const skipped = [];
  const warnings = [];
  let displaced = null;

  if (typeof get !== "function" || typeof set !== "function") {
    return { ok: false, applied, skipped, warnings: ["Nothing was restored: no storage was provided to write to."], displaced };
  }
  const norm = normalize(bundle);
  if (!norm.ok) return { ok: false, applied, skipped, warnings: [norm.error], displaced };

  const replace = mode === "replace";
  if (mode !== "replace" && mode !== "merge") {
    warnings.push(`Unknown restore mode "${String(mode)}" — treated as merge, which never overwrites.`);
  }
  const d = norm.bundle.data;
  const write = (key, value) => {
    if (!dryRun) set(key, value);
  };
  const read = (key, fallback) => {
    try {
      const v = get(key, fallback);
      return v === undefined || v === null ? fallback : v;
    } catch {
      return fallback;
    }
  };

  /* -- account: the hub identity, and the thing DMs hang off -------------- */
  if (d.account) {
    const mine = cleanAccount(read("account", null));
    const label = d.account.tag ? `@${d.account.tag}` : d.account.uid.slice(0, 8);
    if (!mine) {
      write("account", d.account);
      applied.push(`Account ${label} restored — this browser had none.`);
    } else if (mine.uid === d.account.uid) {
      if (mine.token === d.account.token) {
        skipped.push(`Account ${label} was already here, unchanged.`);
      } else if (replace) {
        write("account", d.account);
        applied.push(`Account ${label} token replaced from the backup.`);
        warnings.push("The backup's account token replaced the one this browser was using. If the backup's token is the older of the two, you may be signed out and given a new account.");
      } else {
        skipped.push(`Account ${label} is already signed in here; kept this browser's token.`);
      }
    } else if (replace) {
      // Handing the caller what was displaced beats writing it to a key this
      // module doesn't own — the UI can offer "back that up first" with it.
      displaced = { account: mine };
      write("account", d.account);
      applied.push(`Account ${label} restored, replacing a different account.`);
      warnings.push(`This browser was ${mine.tag ? "@" + mine.tag : "a different account"} and now isn't. That identity lives nowhere else — if you didn't back it up, its @tag, friends and DMs are now unreachable.`);
    } else {
      skipped.push(`Kept this browser's account (${mine.tag ? "@" + mine.tag : mine.uid.slice(0, 8)}); the backup holds a different one.`);
      warnings.push(`This browser is already signed in as a different account than the backup (${label}). Merge never swaps identities — use Replace if the backup is the one you want, and export this one first.`);
    }
  }

  /* -- per-server identities: the dangerous merge ------------------------- */
  //
  // A per-server identity is the proof that your past messages are yours. If a
  // different identity already exists for a server, overwriting it doesn't
  // "sync" anything — it orphans everything you've already said there: you
  // appear as a second person, and the first one's messages can no longer be
  // edited or deleted by anybody, ever. There is no undo and the server has no
  // idea the two are the same human. So merge never touches an existing
  // identity, not even to "upgrade" a token, and reports every collision by
  // name so the UI can offer Replace as a deliberate choice.
  if (d.identities) {
    const mine = cleanIdentities(read("identities", {}));
    const next = { ...mine };
    const names = new Map((Array.isArray(d.servers) ? d.servers : []).map((s) => [s.code, s.name || s.code]));
    let filled = 0;
    for (const [code, row] of Object.entries(d.identities)) {
      const here = mine[code];
      const name = names.get(code) || code;
      if (!here) {
        next[code] = row;
        filled++;
        continue;
      }
      if (here.userId === row.userId && here.token === row.token) {
        skipped.push(`Identity for ${name} was already here, unchanged.`);
        continue;
      }
      if (replace) {
        displaced = displaced || {};
        displaced.identities = { ...(displaced.identities || {}), [code]: here };
        next[code] = row;
        applied.push(`Identity for ${name} replaced from the backup.`);
        if (here.userId !== row.userId) {
          warnings.push(`On ${name} you were a different person until now. Messages you sent under the old identity are no longer yours to edit or delete.`);
        }
      } else {
        skipped.push(`Kept this browser's identity on ${name}.`);
        warnings.push(`${name} already has an identity here that isn't the backup's. Merge left it alone on purpose — replacing it would orphan messages you've already sent there.`);
      }
    }
    if (filled) applied.push(`${filled} server login${filled === 1 ? "" : "s"} restored.`);
    write("identities", next);
  }

  /* -- servers: invite codes, which are credentials ----------------------- */
  if (d.servers) {
    const mine = cleanServers(read("servers", []));
    const byCode = new Map(mine.map((s) => [s.code, s]));
    // Replace puts the backup's order first (that's the rail the user
    // remembers), then keeps anything local it didn't know about — an invite
    // code is unrecoverable and dropping one is the exact failure this module
    // is for.
    const order = replace ? [...d.servers, ...mine.filter((s) => !d.servers.some((b) => b.code === s.code))] : [...mine, ...d.servers];
    const out = [];
    const seen = new Set();
    let added = 0;
    for (const s of order) {
      if (seen.has(s.code)) continue;
      seen.add(s.code);
      if (!byCode.has(s.code)) added++;
      // Names and icons refresh from the server on the next connect, so the
      // local copy is as good as the backup's and not worth a conflict.
      out.push(byCode.get(s.code) || s);
    }
    write("servers", out);
    if (added) applied.push(`${added} server${added === 1 ? "" : "s"} added to your rail.`);
    else skipped.push("You were already in every server this backup knows about.");
    const kept = out.length - d.servers.length;
    if (replace && kept > 0) warnings.push(`${kept} server${kept === 1 ? "" : "s"} not in the backup ${kept === 1 ? "was" : "were"} kept — a restore never removes a server, because its invite code can't be recovered.`);
  }

  /* -- profile ------------------------------------------------------------ */
  if (d.profile) {
    const mine = cleanProfile(read("profile", null));
    if (!mine || replace) {
      write("profile", d.profile);
      applied.push(mine ? "Profile replaced from the backup." : "Profile restored.");
    } else {
      skipped.push("Kept this browser's profile.");
    }
  }

  /* -- settings ----------------------------------------------------------- */
  //
  // Even in replace mode this is a key-wise overlay, never a swap. The bundle
  // is deliberately partial — no micId, and extras only if asked — so writing
  // it wholesale would silently wipe device settings the backup never claimed
  // to hold.
  const incoming = { ...(isObj(d.settings) ? d.settings : {}), ...(isObj(d.extras) ? d.extras : {}) };
  if (Object.keys(incoming).length) {
    const stored = read("settings", {});
    const mine = isObj(stored) ? stored : {};
    const next = { ...mine };
    let changed = 0;
    let gaps = 0;
    for (const [k, v] of Object.entries(incoming)) {
      if (DEVICE_KEYS.includes(k)) continue; // never, from either direction
      if (!(k in mine)) {
        next[k] = clone(v);
        gaps++;
      } else if (replace) {
        next[k] = clone(v);
        changed++;
      }
    }
    if (gaps || changed) write("settings", next);
    if (gaps) applied.push(`${gaps} setting${gaps === 1 ? "" : "s"} filled in from the backup.`);
    if (changed) applied.push(`${changed} existing setting${changed === 1 ? "" : "s"} overwritten by the backup.`);
    if (!replace && Object.keys(incoming).length - gaps > 0) {
      skipped.push(`${Object.keys(incoming).length - gaps} settings you'd already set were left as they are.`);
    }
  }

  if (dryRun) warnings.push("Preview only — nothing was written.");
  return { ok: true, applied, skipped, warnings, displaced };
}
