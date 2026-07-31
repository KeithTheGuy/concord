// Concord message-renderer safety suite.
// Usage: node test/render.mjs [baseUrl]   (default http://127.0.0.1:4189)
//
// renderMarkdown() in public/app.js is the only function in this app whose
// output goes straight to innerHTML, and it works by escaping the input and
// then running eight regex passes over the escaped string, using "\0N\0" as a
// sentinel for fragments it wants to protect (fenced blocks, code spans,
// links). public/customemoji.js's substitution was spliced into the middle of
// that pipeline. Every one of those passes is a chance to hand an attacker an
// attribute boundary. Nothing tested it until this file.
//
// renderMarkdown is not exported and the module it lives in is 5k lines of
// DOM-coupled boot code, so this drives it the way a user does: a real
// Chromium page, onboarded into a real server, fed synthetic {type:"msg"}
// frames straight into the realm socket's onmessage handler. That is the same
// code path a hostile peer's message takes, which is the threat model.
//
// Assertions read the PARSED DOM (querySelector / textContent / getAttribute),
// never the HTML string — "the string doesn't contain onerror" passes for a
// dozen wrong reasons, "no element in this subtree has an on* attribute" does
// not.

import { chromium } from "playwright";

const base = process.argv[2] || "http://127.0.0.1:4189";

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
const show = (s, n = 90) => JSON.stringify(String(s).slice(0, n));

// Collected for the summary table at the bottom.
const timings = [];

/* ========================= in-page instrumentation ======================== */
// Runs at document-start, before app.js parses.

function instrument() {
  // Silence the non-deterministic decoration (gremlin/mascot/embeds/sounds) so
  // the only things mutating the DOM are the renderer and us. Guarded because
  // init scripts also run on about:blank, where storage throws.
  try {
    localStorage.setItem(
      "concord-settings",
      JSON.stringify({
        embeds: false, tts: false, notifs: false, gremlin: false, mascot: false,
        board: false, sounds: false, turbo: false, volume: 0,
      })
    );
  } catch {}

  // The real detector. Not "does the HTML look scary" — "did anything run".
  window.__xss = [];
  const flag = (why) => window.__xss.push(why);
  window.__flag = flag;
  window.alert = (...a) => flag("alert(" + a.join(",") + ")");
  window.confirm = () => (flag("confirm()"), false);
  window.prompt = () => (flag("prompt()"), null);
  window.print = () => flag("print()");
  // If any payload manages to eval, this is the marker it will hit.
  window.__pwn = () => flag("__pwn()");

  addEventListener("securitypolicyviolation", (e) =>
    flag("csp:" + e.violatedDirective + " " + e.blockedURI)
  );

  // Executable / navigational elements have no business appearing in a chat
  // message no matter how they were spelled.
  const DANGER = new Set(["SCRIPT", "IFRAME", "OBJECT", "EMBED", "BASE", "FRAME", "FRAMESET"]);
  const scan = (n) => {
    if (!n || n.nodeType !== 1) return;
    const list = [n, ...(n.querySelectorAll ? n.querySelectorAll("*") : [])];
    for (const e of list) {
      if (DANGER.has(e.tagName)) flag("node:" + e.tagName.toLowerCase());
      if (!e.attributes) continue;
      for (const a of e.attributes) {
        if (/^on/i.test(a.name)) flag("attr:" + e.tagName.toLowerCase() + "[" + a.name + "]");
        if (/^\s*(javascript|data|vbscript):/i.test(a.value) && /^(href|src|action|formaction|xlink:href)$/i.test(a.name))
          flag("url:" + e.tagName.toLowerCase() + "[" + a.name + "]=" + a.value.slice(0, 40));
      }
    }
  };
  try {
    new MutationObserver((recs) => {
      for (const r of recs) for (const n of r.addedNodes) scan(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {}

  /* ---------------------------- the render probe --------------------------- */
  // Feeds one message through the live socket handler and reports the parsed
  // DOM it produced. `contentJson` is a JSON-encoded string so that NULs and
  // lone surrogates survive the trip from node into the page intact.
  window.__probeN = 0;
  window.__probe = (o) => {
    const { state } = window.__concord;
    const realm = state.realms.get(state.activeCode);
    const chanId = realm.activeChan;
    const id = "probe-" + ++window.__probeN;
    realm.messages.set(chanId, []); // one message on screen keeps timings honest
    realm.firstUnread.delete(chanId);

    const msg = {
      id,
      chanId,
      author: { userId: "probe-user", name: "Probe", color: "#8888ff", avatar: "P" },
      content: JSON.parse(o.contentJson),
      ts: Date.now(),
    };
    if (o.attachments) msg.attachments = o.attachments;
    if (o.threadName) {
      msg.threadId = "thread-not-real";
      msg.threadName = o.threadName;
    }
    if (o.replyToJson) msg.replyTo = JSON.parse(o.replyToJson);
    if (o.reactions) msg.reactions = o.reactions;

    const t0 = performance.now();
    realm.ws.onmessage({ data: JSON.stringify({ type: "msg", msg }) });
    const ms = performance.now() - t0;

    const node = document.querySelector('.msg[data-id="' + id + '"]');
    if (!node) return { found: false, ms };
    const body = node.querySelector(".msg-content");
    const inBody = body ? [...body.querySelectorAll("*")] : [];
    const inNode = [...node.querySelectorAll("*")];

    const attrsOf = (e) => [...e.attributes].map((a) => ({ name: a.name, value: a.value }));
    const allAttrs = [];
    for (const e of inNode)
      for (const a of e.attributes) allAttrs.push({ tag: e.tagName.toLowerCase(), name: a.name, value: a.value });

    const q = (sel) => (body ? [...body.querySelectorAll(sel)] : []);
    return {
      found: true,
      ms,
      id,
      text: body ? body.textContent : null,
      html: body ? body.innerHTML : null,
      tags: inBody.map((e) => e.tagName.toLowerCase()),
      nodeTags: inNode.map((e) => e.tagName.toLowerCase()),
      onAttrs: allAttrs.filter((a) => /^on/i.test(a.name)),
      allAttrs,
      anchors: q("a").map((a) => ({
        href: a.getAttribute("href"),
        target: a.getAttribute("target"),
        rel: a.getAttribute("rel"),
        text: a.textContent,
        attrs: attrsOf(a).map((x) => x.name),
      })),
      imgs: q("img").map((i) => ({
        src: i.getAttribute("src"),
        alt: i.getAttribute("alt"),
        cls: i.className,
        attrs: attrsOf(i).map((x) => x.name),
      })),
      pres: q("pre").map((p) => p.textContent),
      codeSpans: q("code")
        .filter((c) => !c.closest("pre"))
        .map((c) => c.textContent),
      strongs: q("strong").map((e) => e.textContent),
      ems: q("em").map((e) => e.textContent),
      dels: q("del").map((e) => e.textContent),
      spoilers: q(".spoiler").map((e) => e.textContent),
      mentions: q(".mention").map((e) => e.textContent),
      replyText: node.querySelector(".msg-reply")?.textContent ?? null,
      threadChip: node.querySelector(".thread-chip")?.textContent ?? null,
      attName: node.querySelector(".att-file-name")?.textContent ?? null,
      attImgAlt: node.querySelector(".att-img")?.getAttribute("alt") ?? null,
      attHref: node.querySelector(".att-file")?.getAttribute("href") ?? null,
      reactionFaceTags: [...node.querySelectorAll(".reaction-face")].map((s) =>
        [...s.querySelectorAll("*")].map((e) => e.tagName.toLowerCase())
      ),
      reactionFaceText: [...node.querySelectorAll(".reaction-face")].map((s) => s.textContent),
    };
  };
}

/* ================================ harness ================================ */

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript(instrument);

const pageErrors = [];
const dialogs = [];
function wire(page) {
  page.on("pageerror", (e) => pageErrors.push(String(e.message || e)));
  page.on("dialog", async (d) => {
    dialogs.push(d.type() + ":" + d.message());
    await d.dismiss();
  });
}

const READY = () => {
  const s = window.__concord && window.__concord.state;
  const r = s && s.activeCode && s.realms.get(s.activeCode);
  return !!(r && r.ws && r.activeChan && document.querySelector("#messages"));
};

let onboarded = false;
async function bootPage() {
  const page = await ctx.newPage();
  wire(page);
  await page.goto(base);
  if (!onboarded) {
    await page.waitForSelector("#onboard-modal:not(.hidden)", { timeout: 30000 });
    await page.fill("#ob-name", "RenderProbe");
    await page.click("#ob-done");
    await page.waitForSelector("#join-modal:not(.hidden)", { timeout: 30000 });
    await page.fill("#jm-create-name", "Render Safety");
    await page.click("#jm-create");
    await page.waitForSelector("#invite-modal:not(.hidden)", { timeout: 30000 });
    await page.click("#invite-modal .modal-close");
    onboarded = true;
  }
  await page.waitForSelector("#app:not(.hidden)", { timeout: 30000 });
  await page.waitForFunction(READY, null, { timeout: 30000 });
  return page;
}

let page = await bootPage();

// A page whose JS is wedged in a runaway regex can never answer again, so the
// pathological section replaces it rather than hanging the whole suite.
async function evalGuarded(fn, arg, ms = 20000) {
  let timer;
  const guard = new Promise((_, rej) => (timer = setTimeout(() => rej(new Error("TIMEOUT")), ms)));
  try {
    return await Promise.race([page.evaluate(fn, arg), guard]);
  } finally {
    clearTimeout(timer);
  }
}
async function replacePage() {
  try {
    await page.close();
  } catch {}
  page = await bootPage();
}

const J = (s) => JSON.stringify(s);

async function render(opts, budgetMs) {
  const o = typeof opts === "string" ? { contentJson: J(opts) } : opts;
  return evalGuarded((x) => window.__probe(x), o, budgetMs ?? 20000);
}

// Renders, then waits long enough for an async payload (img onerror, svg
// onload, a queued microtask) to have fired, and reports what tripped.
async function renderXss(opts) {
  await page.evaluate(() => (window.__xss = []));
  const r = await render(opts);
  await page.waitForTimeout(150);
  r.xss = await page.evaluate(() => window.__xss.slice());
  return r;
}

// One assertion shape reused by every XSS case: nothing ran, nothing dangerous
// exists, no inline handler survived.
function assertClean(label, r, extra = "") {
  const problems = [];
  if (!r.found) problems.push("message never rendered");
  if (r.xss.length) problems.push("detector: " + r.xss.join(" | "));
  if (r.onAttrs.length) problems.push("on* attrs: " + r.onAttrs.map((a) => a.tag + "[" + a.name + "]").join(","));
  const danger = r.nodeTags.filter((t) => ["script", "iframe", "object", "embed", "base", "svg"].includes(t));
  if (danger.length) problems.push("elements: " + danger.join(","));
  check(!problems.length, label + (extra ? ` (${extra})` : ""), problems.join("; ") + " :: " + show(r.html, 160));
  return !problems.length;
}

// The sentinel character renderMarkdown parks its placeholders behind. Built
// from a char code so no editor, linter or git filter can quietly eat it.
const NUL = String.fromCharCode(0);

try {
  /* ====================================================================== */
  section("1. XSS — nothing executes, nothing escapes");

  {
    // --- classic injection vectors ------------------------------------------
    const vectors = [
      ["<script>alert(1)</script>", "script tag"],
      ["<img src=x onerror=alert(1)>", "img onerror"],
      ["<svg/onload=alert(1)>", "svg onload"],
      ['<svg><animate onbegin="alert(1)" attributeName="x"></svg>', "svg animate onbegin"],
      ["<iframe src=javascript:alert(1)></iframe>", "iframe javascript:"],
      ["<body onload=alert(1)>", "body onload"],
      ["<img src=x onerror=&#97;lert(1)>", "entity-obfuscated handler"],
      ["<scr<script>ipt>alert(1)</scr</script>ipt>", "nested tag splice"],
      ["<a href=javascript:alert(1)>x</a>", "anchor javascript:"],
      ["<details open ontoggle=alert(1)>", "details ontoggle"],
    ];
    for (const [payload, name] of vectors) {
      const r = await renderXss(payload);
      const clean = assertClean(`raw HTML is inert: ${name}`, r);
      if (clean) {
        check(
          r.text === payload,
          `raw HTML survives as literal text: ${name}`,
          `text=${show(r.text)} want=${show(payload)}`
        );
      }
    }
  }

  {
    // --- dangerous URL schemes in link position ------------------------------
    for (const [payload, name] of [
      ["javascript:alert(1)", "bare javascript:"],
      ["JaVaScRiPt:alert(1)", "mixed-case javascript:"],
      ["data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==", "data:text/html"],
      ["[click me](javascript:alert(1))", "markdown-style javascript: link"],
      ["vbscript:msgbox(1)", "vbscript:"],
      ["  javascript:alert(1)", "leading-space javascript:"],
    ]) {
      const r = await renderXss(payload);
      const clean = assertClean(`hostile scheme is not linkified: ${name}`, r);
      if (clean) {
        const hrefs = r.anchors.map((a) => a.href || "");
        check(
          !hrefs.some((h) => /^\s*(javascript|data|vbscript):/i.test(h)),
          `no anchor points at a hostile scheme: ${name}`,
          "hrefs=" + J(hrefs)
        );
      }
    }
  }

  {
    // --- breaking out of the href the linkifier emits ------------------------
    // The linkifier runs on ALREADY-ESCAPED text, so a typed " arrives as
    // &quot;. That should stay a character reference inside the quoted value
    // rather than closing it. This is the single highest-value check here.
    const cases = [
      ['http://a.com" onmouseover="alert(1)', "double-quote breakout"],
      ["http://a.com' onmouseover='alert(1)", "single-quote breakout"],
      ['http://a.com"onmouseover=alert(1)', "unspaced double-quote breakout"],
      ['http://a.com/?x="><img src=x onerror=alert(1)>', "close-tag breakout"],
      ["http://a.com/`onmouseover=alert(1)", "backtick breakout"],
      ["http://a.com/&quot;%20onmouseover=alert(1)", "pre-encoded quote"],
    ];
    for (const [payload, name] of cases) {
      const r = await renderXss(payload);
      const clean = assertClean(`href breakout blocked: ${name}`, r);
      if (clean && r.anchors.length) {
        const extra = r.anchors.flatMap((a) => a.attrs.filter((n) => !["href", "target", "rel"].includes(n)));
        check(
          !extra.length,
          `linkifier emits only href/target/rel: ${name}`,
          "unexpected attrs: " + J(extra)
        );
        check(
          r.anchors.every((a) => (a.rel || "").includes("noopener") && a.target === "_blank"),
          `link keeps rel=noopener target=_blank: ${name}`,
          J(r.anchors)
        );
      }
    }
  }

  {
    // --- the sentinel scheme itself -----------------------------------------
    // renderMarkdown parks protected fragments behind "\0N\0". User text is
    // supposed to be unable to contain \0 (the worker strips control chars),
    // but the optimistic local render and any non-worker producer are not
    // covered by that, so the renderer must be safe on its own.
    {
      const r = await renderXss(`plain ${NUL} text`);
      assertClean("literal NUL in a message is harmless", r);
      check(!/undefined/.test(r.text || ""), "literal NUL does not print 'undefined'", show(r.text));
    }
    {
      const r = await renderXss(`before ${NUL}0${NUL} after`);
      assertClean("literal \\0N\\0 sentinel is harmless", r);
      check(
        !/undefined/.test(r.text || ""),
        "a forged sentinel with no fragment behind it does not print 'undefined'",
        show(r.text)
      );
    }
    {
      // Forged sentinel COLLIDING with a real protected fragment: the code span
      // takes index 0, and the typed \0 0 \0 asks for index 0 as well.
      const r = await renderXss("`SAFE` " + NUL + "0" + NUL);
      assertClean("forged sentinel colliding with a code span is harmless", r);
      check(
        r.codeSpans.length === 1,
        "a forged sentinel cannot duplicate a protected fragment",
        `got ${r.codeSpans.length} <code> spans: ${J(r.codeSpans)} :: ${show(r.html, 160)}`
      );
    }
    {
      // Same trick aimed at the LINK fragment, which is the one that carries
      // raw quote characters in its markup.
      const r = await renderXss("http://collide.example/x " + NUL + "0" + NUL);
      assertClean("forged sentinel colliding with a link is harmless", r);
      check(
        r.anchors.length === 1,
        "a forged sentinel cannot conjure a second anchor",
        `got ${r.anchors.length} anchors :: ${show(r.html, 160)}`
      );
    }
    {
      // Out-of-range index.
      const r = await renderXss("`a` " + NUL + "9" + NUL);
      assertClean("out-of-range sentinel index is harmless", r);
      check(
        !/undefined/.test(r.text || ""),
        "out-of-range sentinel index does not print 'undefined'",
        show(r.text)
      );
    }
  }

  {
    // --- HTML inside every container that claims to be verbatim --------------
    const P = "<img src=x onerror=alert(1)>";
    const containers = [
      ["```" + P + "```", "fenced code block", (r) => r.pres.length === 1 && r.pres[0] === P],
      ["`" + P + "`", "inline code", (r) => r.codeSpans.length === 1 && r.codeSpans[0] === P],
      ["||" + P + "||", "spoiler", (r) => r.spoilers.length === 1 && r.spoilers[0] === P],
      ["**" + P + "**", "bold", (r) => r.strongs.length === 1 && r.strongs[0] === P],
      ["~~" + P + "~~", "strikethrough", (r) => r.dels.length === 1 && r.dels[0] === P],
    ];
    for (const [payload, name, structural] of containers) {
      const r = await renderXss(payload);
      const clean = assertClean(`HTML inside a ${name} is inert`, r);
      if (clean)
        check(structural(r), `HTML inside a ${name} is kept verbatim`, show(r.html, 160));
    }
  }

  {
    // --- HTML inside a mention -----------------------------------------------
    // highlightMentions compiles a regex out of every known member name. A
    // member whose name is markup must not be able to smuggle it back out.
    const hostileName = '<img src=x onerror=alert(1)>';
    await page.evaluate((name) => {
      const { state } = window.__concord;
      const realm = state.realms.get(state.activeCode);
      realm.members.set("sid-hostile", {
        sid: "sid-hostile", userId: "u-hostile", name, color: "#f00", avatar: "X",
      });
      realm.members.set("sid-quote", {
        sid: "sid-quote", userId: "u-quote", name: 'Quo"te', color: "#f00", avatar: "X",
      });
      realm.members.set("sid-nul", {
        sid: "sid-nul", userId: "u-nul", name: "Nu0ll", color: "#f00", avatar: "X",
      });
      realm.members.set("sid-re", {
        sid: "sid-re", userId: "u-re", name: "(a+)+$", color: "#f00", avatar: "X",
      });
    }, hostileName);

    for (const [payload, name] of [
      ["hi @" + hostileName + " bye", "member name that is markup"],
      ['hi @Quo"te bye', "member name containing a quote"],
      ["hi @Nu" + NUL + "0" + NUL + "ll bye", "member name containing the sentinel"],
      ["hi @(a+)+$ bye", "member name that is a regex bomb"],
    ]) {
      const r = await renderXss(payload);
      assertClean(`mention of a hostile ${name} is inert`, r);
    }
  }

  {
    // --- emoji: hostile NAME --------------------------------------------------
    // nameOk()/NAME_TOKEN_RE restrict names to [a-z0-9_], so a markup name must
    // simply never match; the typed ":<img ...>:" has to stay text.
    await page.evaluate(() => {
      const { state } = window.__concord;
      const realm = state.realms.get(state.activeCode);
      realm.ws.onmessage({
        data: JSON.stringify({
          type: "emoji",
          list: [
            { name: "blobcat", url: "/f/blobcat.png" },
            { name: "<img src=x onerror=alert(1)>", url: "/f/x.png" },
            { name: 'q"uote', url: "/f/x.png" },
          ],
        }),
      });
    });
    const r = await renderXss(":<img src=x onerror=alert(1)>: and :q\"uote:");
    const clean = assertClean("emoji name that is markup is inert", r);
    if (clean)
      check(
        r.imgs.filter((i) => i.cls.includes("ce")).length === 0,
        "a markup emoji name never resolves to an <img>",
        show(r.html, 160)
      );
  }

  {
    // --- emoji: hostile URL ---------------------------------------------------
    // e.url is whatever the server said. renderCustomEmoji drops it into an
    // src="" attribute, and it does so BEFORE placeholder restoration runs, so
    // this covers both attribute-escaping and sentinel handling.
    const setEmoji = (url) =>
      page.evaluate((u) => {
        const { state } = window.__concord;
        const realm = state.realms.get(state.activeCode);
        realm.ws.onmessage({
          data: JSON.stringify({ type: "emoji", list: [{ name: "evil", url: JSON.parse(u) }] }),
        });
      }, J(url));

    {
      await setEmoji('x" onerror="window.alert(1)');
      const r = await renderXss("look :evil: here");
      const clean = assertClean("emoji url containing a quote is inert", r);
      if (clean) {
        const ce = r.imgs.find((i) => i.cls.includes("ce"));
        check(
          ce && ce.attrs.every((n) => ["class", "src", "alt", "title", "loading"].includes(n)),
          "emoji url with a quote cannot add attributes to its <img>",
          J(ce)
        );
      }
    }
    {
      await setEmoji('x"><img src=y onerror=alert(1)><span a="');
      const r = await renderXss("look :evil: here");
      const clean = assertClean("emoji url containing markup is inert", r);
      if (clean)
        check(r.imgs.length === 1, "emoji url with markup cannot spawn a second element", show(r.html, 200));
    }
    {
      // The interesting one. The emoji <img src="…"> is built while "\0N\0"
      // placeholders are still parked in the string, and the restore pass runs
      // afterwards over the WHOLE string — attributes included. A url carrying
      // a sentinel therefore gets a chunk of raw markup (with raw quote
      // characters, in the link case) spliced into the middle of its src.
      await setEmoji("x" + NUL + "0" + NUL + "y");
      const r = await renderXss(":evil: http://sentinel.example/z");
      const clean = assertClean("emoji url containing the sentinel is inert", r);
      if (clean) {
        const ce = r.imgs.find((i) => i.cls.includes("ce"));
        check(
          ce && !/[<>]/.test(ce.src || ""),
          "emoji url sentinel is not expanded into raw markup inside src",
          "src=" + show(ce && ce.src, 120)
        );
        check(
          r.anchors.length === 1,
          "emoji url sentinel does not clone the link element",
          `${r.anchors.length} anchors :: ${show(r.html, 220)}`
        );
      }
    }
    // Put a sane registry back for the correctness section.
    await page.evaluate(() => {
      const { state } = window.__concord;
      const realm = state.realms.get(state.activeCode);
      realm.ws.onmessage({
        data: JSON.stringify({ type: "emoji", list: [{ name: "blobcat", url: "/f/blobcat.png" }] }),
      });
    });
  }

  {
    // --- names that reach the DOM by other routes -----------------------------
    // Attachment filenames, thread names and reaction keys all land next to
    // renderMarkdown's output. Traced: uploads.js sets them with textContent /
    // el(), and reactionLabel escapes — so these assert that stays true.
    const P = "<img src=x onerror=alert(1)>";
    {
      const r = await renderXss({
        contentJson: J("file below"),
        attachments: [{ key: "k1", name: P + ".pdf", url: "/f/nope", mime: "application/pdf", size: 42 }],
      });
      const clean = assertClean("hostile attachment filename is inert", r);
      if (clean)
        check(r.attName === P + ".pdf", "attachment filename renders as literal text", show(r.attName));
    }
    {
      const r = await renderXss({
        contentJson: J("image below"),
        attachments: [{ key: "k2", name: P, url: "/f/nope.png", mime: "image/png", size: 42, w: 4, h: 4 }],
      });
      assertClean("hostile attachment filename in an image alt is inert", r);
    }
    {
      const r = await renderXss({ contentJson: J("threaded"), threadName: P });
      const clean = assertClean("hostile thread name is inert", r);
      if (clean)
        check((r.threadChip || "").includes(P), "thread name renders as literal text", show(r.threadChip));
    }
    {
      const r = await renderXss({ contentJson: J("reacted"), reactions: { [P]: ["u1"], ":evil:": ["u1"] } });
      const clean = assertClean("hostile reaction key is inert", r);
      if (clean)
        check(
          r.reactionFaceText.some((t) => t === P),
          "reaction key renders as literal text",
          J(r.reactionFaceText)
        );
    }
    {
      // Channel / category names take a different render path entirely.
      await page.evaluate(() => (window.__xss = []));
      const info = await page.evaluate((p) => {
        const { state, switchToRealm } = window.__concord;
        const realm = state.realms.get(state.activeCode);
        const saved = realm.channels.slice();
        realm.channels = saved.concat([
          { id: "chan-hostile", name: p, type: "text", category: p },
        ]);
        switchToRealm(state.activeCode);
        const rail = document.getElementById("channels");
        const out = {
          tags: [...rail.querySelectorAll("*")].map((e) => e.tagName.toLowerCase()),
          text: rail.textContent,
        };
        realm.channels = saved;
        switchToRealm(state.activeCode);
        return out;
      }, P);
      await page.waitForTimeout(120);
      const xss = await page.evaluate(() => window.__xss.slice());
      check(
        !xss.length && !info.tags.includes("img") && info.text.includes(P),
        "hostile channel/category name renders as literal text",
        `xss=${J(xss)} text=${show(info.text, 120)}`
      );
    }
  }

  /* ====================================================================== */
  section("2. Correctness");

  {
    const cases = [
      ["**bold**", "bold", (r) => r.strongs.length === 1 && r.strongs[0] === "bold" && r.text === "bold"],
      ["*ital*", "italic", (r) => r.ems.length === 1 && r.ems[0] === "ital"],
      ["~~gone~~", "strikethrough", (r) => r.dels.length === 1 && r.dels[0] === "gone"],
      ["`snip`", "inline code", (r) => r.codeSpans.length === 1 && r.codeSpans[0] === "snip" && !r.pres.length],
      ["```\nblock\n```", "fenced block", (r) => r.pres.length === 1 && r.pres[0] === "block"],
      ["||hidden||", "spoiler", (r) => r.spoilers.length === 1 && r.spoilers[0] === "hidden"],
      [
        "see http://ok.example/p?a=1",
        "link",
        (r) => r.anchors.length === 1 && r.anchors[0].href === "http://ok.example/p?a=1",
      ],
      ["hey @RenderProbe", "self mention", (r) => r.mentions.length === 1 && r.mentions[0] === "@RenderProbe"],
      ["hey @everyone", "@everyone", (r) => r.mentions.length === 1],
      [
        "nice :blobcat: work",
        "custom emoji",
        (r) => r.imgs.length === 1 && r.imgs[0].alt === ":blobcat:" && r.imgs[0].src === "/f/blobcat.png",
      ],
      [":notanemoji: stays", "unknown emoji name stays text", (r) => !r.imgs.length && r.text.includes(":notanemoji:")],
    ];
    for (const [input, name, structural] of cases) {
      const r = await render(input);
      check(r.found && structural(r), `renders ${name}`, show(r.html, 160));
    }
  }

  {
    // Everything above, typed inside a fence, has to come back out untouched.
    const inners = ["**bold**", "*ital*", "~~gone~~", "||hidden||", "@RenderProbe", ":blobcat:", "http://ok.example/p", "@everyone"];
    for (const inner of inners) {
      const r = await render("```" + inner + "```");
      const inert =
        r.pres.length === 1 &&
        r.pres[0] === inner &&
        !r.strongs.length && !r.ems.length && !r.dels.length &&
        !r.spoilers.length && !r.mentions.length && !r.imgs.length && !r.anchors.length;
      check(inert, `fenced block keeps ${show(inner, 24)} verbatim`, show(r.html, 160));
    }
    for (const inner of inners) {
      const r = await render("`" + inner + "`");
      const inert =
        r.codeSpans.length === 1 &&
        r.codeSpans[0] === inner &&
        !r.strongs.length && !r.ems.length && !r.dels.length &&
        !r.spoilers.length && !r.mentions.length && !r.imgs.length && !r.anchors.length;
      check(inert, `inline code keeps ${show(inner, 24)} verbatim`, show(r.html, 160));
    }
  }

  {
    // Nesting.
    const nests = [
      [
        "**bold with *ital* inside**",
        "italic nested in bold",
        (r) => r.strongs.length === 1 && r.ems.length === 1 && r.text === "bold with ital inside",
      ],
      [
        "||spoiled **bold**||",
        "bold nested in spoiler",
        (r) => r.spoilers.length === 1 && r.strongs.length === 1,
      ],
      [
        "**bold with `code` inside**",
        "code nested in bold",
        (r) => r.strongs.length === 1 && r.codeSpans.length === 1 && r.codeSpans[0] === "code",
      ],
      [
        "~~struck **bold**~~",
        "bold nested in strikethrough",
        (r) => r.dels.length === 1 && r.strongs.length === 1,
      ],
      [
        "**@RenderProbe**",
        "mention nested in bold",
        (r) => r.strongs.length === 1 && r.mentions.length === 1,
      ],
      [
        "**:blobcat:**",
        "emoji nested in bold",
        (r) => r.strongs.length === 1 && r.imgs.length === 1,
      ],
    ];
    for (const [input, name, structural] of nests) {
      const r = await render(input);
      check(r.found && structural(r), `nesting: ${name}`, show(r.html, 160));
    }
  }

  {
    // A link at the END of a spoiler. The linkifier's URL class is
    // [^\s<\0]+ and it runs BEFORE the spoiler pass, so the closing "||" is
    // swallowed into the href and the spoiler never forms — which means the
    // text someone deliberately hid is painted in the clear.
    const r = await render("||secret http://ok.example/q||");
    check(
      r.spoilers.length === 1,
      "a trailing link inside a spoiler leaves the spoiler intact",
      `spoilers=${r.spoilers.length} :: ${show(r.html, 200)}`
    );
    check(
      !((r.anchors[0] && r.anchors[0].href) || "").includes("|"),
      "the linkifier does not swallow a spoiler's closing ||",
      show(r.anchors[0] && r.anchors[0].href)
    );
  }

  {
    // Unmatched delimiters must degrade to literal text and must not swallow
    // the rest of the message.
    const tail = "TAILSENTINEL";
    const degrade = [
      ["**foo " + tail, "unclosed **", (r) => !r.strongs.length],
      ["*foo " + tail, "unclosed *", (r) => !r.ems.length],
      ["~~foo " + tail, "unclosed ~~", (r) => !r.dels.length],
      ["||foo " + tail, "unclosed ||", (r) => !r.spoilers.length],
      ["`foo " + tail, "unclosed `", (r) => !r.codeSpans.length],
      ["```foo " + tail, "unclosed ```", (r) => !r.pres.length],
      ["```foo `bar` " + tail, "unclosed ``` with a code span after", (r) => !r.pres.length],
    ];
    for (const [input, name, structural] of degrade) {
      const r = await render(input);
      const kept = (r.text || "").includes(tail);
      check(
        r.found && kept && structural(r),
        `${name} degrades without eating the rest of the message`,
        `text=${show(r.text)}`
      );
    }
  }

  /* ====================================================================== */
  section("4. Unicode integrity");

  {
    // Built in-page from code points so nothing can be mangled in transit.
    const results = await page.evaluate(() => {
      const samples = [
        ["ZWJ family", "\u{1F469}‍\u{1F469}‍\u{1F467}‍\u{1F466}"],
        ["skin tone modifier", "\u{1F44B}\u{1F3FD}"],
        ["regional-indicator flag", "\u{1F1EF}\u{1F1F5}"],
        ["keycap sequence", "1️⃣"],
        ["combining marks", "é̂̃ a̧"],
        ["RTL text", "مرحبا بالعالم"],
        ["RTL + LTR mix", "hello שלום world"],
        ["astral plane", "\u{1D56C}\u{1D598}\u{1D599}\u{1D586}\u{1D590} \u{20BB7}"],
        ["astral inside a code block", "```\u{1F600}\u{20BB7}\u{1F469}‍\u{1F467}```"],
        ["astral inside bold", "**\u{1F600}\u{20BB7}**"],
      ];
      const out = [];
      for (const [label, s] of samples) {
        const r = window.__probe({ contentJson: JSON.stringify(s) });
        const want = s.replace(/^```|```$/g, "").replace(/^\*\*|\*\*$/g, "");
        out.push({
          label,
          got: r.text,
          want,
          equal: r.text === want,
          // any replacement char or unpaired surrogate is a corruption
          corrupt: /�/.test(r.text || "") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(r.text || ""),
        });
      }
      return out;
    });
    for (const r of results) {
      check(r.equal && !r.corrupt, `unicode survives the renderer: ${r.label}`, `got=${show(r.got)} want=${show(r.want)}`);
    }
  }

  {
    // The truncation traps. Several previews cut with a plain .slice(), which
    // counts UTF-16 code units and will happily cut a surrogate pair in half.
    const unpaired = (s) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

    const cut = await page.evaluate(() => {
      const { state } = window.__concord;
      // Char index 119 lands on the HIGH surrogate of the emoji, so slice(0,120)
      // takes half of it. Same shape for the 40- and 140-char cuts elsewhere.
      const content = "A".repeat(119) + "\u{1F44D}" + " trailing text that should not matter";
      const r = window.__probe({ contentJson: JSON.stringify(content) });
      const node = document.querySelector('.msg[data-id="' + r.id + '"]');
      node.querySelector('.msg-actions button[title="Reply"]').click();
      const reply = state.replyTo ? state.replyTo.content : null;
      node.querySelector('.msg-actions button[title="Save this message"]').click();
      return { reply, saved: (state.settings.saved || [])[0]?.preview ?? null, raw: content };
    });
    check(!unpaired(cut.reply || ""), "reply preview (.slice(0,120)) does not split a surrogate pair", show(cut.reply, 140));
    check(!unpaired(cut.saved || ""), "saved-message preview (.slice(0,120)) does not split a surrogate pair", show(cut.saved, 140));

    // And the quote as it is actually painted for the reader.
    const quoted = await page.evaluate(() => {
      const content = "A".repeat(119) + "\u{1F44D}" + " tail";
      const r = window.__probe({
        contentJson: JSON.stringify("a reply"),
        replyToJson: JSON.stringify({ id: "x", name: "Probe", content: content.slice(0, 120) }),
      });
      return r.replyText;
    });
    check(
      !unpaired(quoted || "") && !/�/.test(quoted || ""),
      "rendered reply quote contains no half surrogate",
      show(quoted, 140)
    );
  }

  /* ====================================================================== */
  section("3. Pathological input (measured)");

  {
    // Threshold. Catastrophic backtracking is never a 2x problem — a quadratic
    // or exponential pass on 4000 chars takes seconds to minutes, so anything
    // in the 100–500 ms band separates it from "linear, but building real DOM"
    // with enormous margin. 150 ms is also already a user-visible bug on its
    // own terms: renderMessages() paints a whole channel in one synchronous
    // pass, so 150 ms for ONE message is several seconds of frozen tab when
    // fifty of them load.
    const BUDGET_MS = 150;

    const N = 4000;
    const cases = [
      ["4000 x '*'", "*".repeat(N)],
      ["4000 x '|'", "|".repeat(N)],
      ["4000 x '`'", "`".repeat(N)],
      ["4000 x '~'", "~".repeat(N)],
      ["4000 x '@'", "@".repeat(N)],
      ["4000 x ':'", ":".repeat(N)],
      ["4000 x '_'", "_".repeat(N)],
      ["alternating '*a*b'", "*a*b".repeat(N / 4)],
      ["alternating '||a||b'", "||a||b".repeat(Math.floor(N / 6))],
      ["alternating '`a`b'", "`a`b".repeat(N / 4)],
      ["500 x '```'", "```".repeat(500)],
      ["nested '*'x500", "*".repeat(500) + "x" + "*".repeat(500)],
      ["nested '**'x250", "**".repeat(250) + "x" + "**".repeat(250)],
      ["nested '||'x250", "||".repeat(250) + "x" + "||".repeat(250)],
      ["nested '~~'x250", "~~".repeat(250) + "x" + "~~".repeat(250)],
      ["nested emphasis mix", "*|~`".repeat(250) + "x" + "`~|*".repeat(250)],
      ["4000 x 'http://a.b/'", "http://a.b/x ".repeat(300)],
      ["baseline: 4000 plain chars", "a".repeat(N)],
    ];

    // Roster load: 200 known names, message with 500 mentions.
    await page.evaluate(() => {
      const { state } = window.__concord;
      const realm = state.realms.get(state.activeCode);
      window.__savedMembers = new Map(realm.members);
      for (let i = 0; i < 200; i++)
        realm.members.set("bulk-" + i, {
          sid: "bulk-" + i,
          userId: "bulk-" + i,
          name: "mem" + String(i).padStart(3, "0"),
          color: "#777777",
          avatar: "M",
        });
    });
    cases.push(["500 mentions vs 200-name roster", "@mem042 ".repeat(500)]);
    cases.push(["500 unknown mentions vs 200-name roster", "@zzz042 ".repeat(500)]);

    for (const [label, input] of cases) {
      let r = null;
      let err = null;
      try {
        r = await render(input, 15000);
      } catch (e) {
        err = e;
      }
      if (err) {
        timings.push([label, null]);
        bad(`pathological input completes: ${label}`, "render did not return within 15000 ms (page wedged)");
        await replacePage();
        continue;
      }
      timings.push([label, r.ms]);
      check(
        r.found && r.ms < BUDGET_MS,
        `pathological input under ${BUDGET_MS} ms: ${label}`,
        `${r.ms.toFixed(1)} ms`
      );
    }

    // A timing number for a case that quietly did no work is worse than no
    // number at all, so prove the roster case really was exercising the
    // 200-alternative mention regex.
    {
      const r = await render("@mem042 ".repeat(500), 15000);
      check(
        r.found && r.mentions.length === 500,
        "the 500-mention timing case really highlighted 500 mentions (not a vacuous measurement)",
        `${r.found ? r.mentions.length : "no render"} mention spans`
      );
    }

    await page
      .evaluate(() => {
        const { state } = window.__concord;
        const realm = state.realms.get(state.activeCode);
        if (window.__savedMembers) realm.members = window.__savedMembers;
      })
      .catch(() => {});
  }

  /* ====================================================================== */
  section("5. Page health");

  {
    const leftovers = await page.evaluate(() => ({
      scripts: document.querySelectorAll("#messages script, #app script").length,
      xss: window.__xss.slice(),
    }));
    check(leftovers.scripts === 0, "no <script> node was ever grafted into the app tree", String(leftovers.scripts));
    check(dialogs.length === 0, "no native dialog was raised by any payload", J(dialogs));
    const relevant = pageErrors.filter((e) => !/favicon|Failed to load resource|net::ERR/i.test(e));
    check(relevant.length === 0, "no uncaught page errors while rendering hostile input", J(relevant.slice(0, 3)));
  }
} catch (e) {
  bad("suite crashed", String(e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e));
} finally {
  await browser.close();
}

/* =============================== summary ================================ */

if (timings.length) {
  console.log("\n── measured render times " + "─".repeat(40));
  const w = Math.max(...timings.map(([l]) => l.length));
  for (const [label, ms] of timings)
    console.log(`  ${label.padEnd(w)}  ${ms === null ? ">15000 (wedged)" : ms.toFixed(1).padStart(8) + " ms"}`);
}

console.log("");
if (failures) {
  console.error(`${failures} CHECK${failures === 1 ? "" : "S"} FAILED (${passed} passed)`);
  process.exit(1);
}
console.log(`ALL ${passed} CHECKS PASSED`);
