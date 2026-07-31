// Per-realm registry of server custom emoji (":name:" -> {name, url}) and the
// render-time substitution that turns those names into pictures. Nothing
// here ever touches stored message content — a message is always saved as
// plain text ("nice work :blobcat:") and stays searchable; only the DOM the
// user sees gets the picture. Keyed by server code because two servers can
// both mint a ":blobcat:" and they are not the same file.

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function nameOk(name) {
  return typeof name === "string" && /^[a-z0-9_]{2,20}$/.test(name);
}

export class EmojiRegistry {
  constructor() {
    this.byCode = new Map(); // code -> Map(name -> {name, url})
  }
  setFor(code, list) {
    const m = new Map();
    for (const e of list || []) m.set(e.name, e);
    this.byCode.set(code, m);
  }
  forCode(code) {
    return [...(this.byCode.get(code)?.values() ?? [])];
  }
  get(code, name) {
    return this.byCode.get(code)?.get(name);
  }
  has(code, name) {
    return !!this.byCode.get(code)?.has(name);
  }
  names(code) {
    return [...(this.byCode.get(code)?.keys() ?? [])];
  }
}

// Matches ":name:" using the same charset as nameOk(). Kept deliberately
// narrow: [a-z0-9_] can never contain the \u0000 sentinel app.js's
// renderMarkdown uses to hide code blocks and links, so this pattern can
// never straddle a sentinel by accident even without special-casing it.
const NAME_TOKEN_RE = /:([a-z0-9_]{2,20}):/g;

// Called from inside app.js's renderMarkdown, on already-escaped HTML, AFTER
// the ``` / ` code-span / link passes have swapped their contents for
// \u0000N\u0000 placeholders and BEFORE those placeholders are restored.
// That window is not a style choice, it's load-bearing both directions:
//   - Must run after code/link protection, or a literal ":shrug:" typed
//     inside a fenced code block would still be live text and get turned
//     into an <img> — code blocks are supposed to render verbatim.
//   - Must run before placeholder restoration, or the same thing happens in
//     reverse: code block bodies come back as live text and THEN get scanned.
// Concretely: insert the call between the highlightMentions(t) line and the
// final `t.replace(/\u0000(\d+)\u0000/g, ...)` line in renderMarkdown.
export function renderCustomEmoji(html, code, reg) {
  return html.replace(NAME_TOKEN_RE, (whole, name) => {
    const e = reg.get(code, name);
    if (!e) return whole; // not a real emoji here - a stray ":" stays a ":"
    return `<img class="ce" src="${esc(e.url)}" alt=":${name}:" title=":${name}:" loading="lazy">`;
  });
}

// Same substitution for plain-text contexts (reaction buttons, member list,
// notification bodies) that never go through renderMarkdown at all.
export function renderEmojiText(text, code, reg) {
  return renderCustomEmoji(esc(text), code, reg);
}

// A reaction value is either a literal emoji character or ":name:". Returns
// what to put in the button face. If the emoji was since deleted from the
// server, fall back to the bare ":name:" text rather than a broken <img>.
export function reactionLabel(emoji, code, reg) {
  const m = /^:([a-z0-9_]{2,20}):$/.exec(emoji || "");
  if (!m) return { html: esc(emoji ?? ""), isCustom: false };
  const e = reg.get(code, m[1]);
  if (!e) return { html: esc(emoji), isCustom: false };
  return { html: `<img class="ce" src="${esc(e.url)}" alt=":${m[1]}:" title=":${m[1]}:" loading="lazy">`, isCustom: true };
}

// Autocomplete for ":que…". `builtins` is app.js's EMOJI_NAMES, an array of
// [name, char] pairs — passed in rather than imported so this module doesn't
// need to know app.js exists. Custom emoji sort first: they're the ones
// someone on this server bothered to upload, so they're more likely to be
// what the person typing meant.
export function emojiCandidates(query, code, reg, builtins) {
  const q = (query || "").toLowerCase();
  const custom = reg
    .forCode(code)
    .filter((e) => e.name.includes(q))
    .map((e) => ({ name: e.name, url: e.url }));
  const built = (builtins || [])
    .filter(([name]) => name.includes(q))
    .map(([name, char]) => ({ name, char }));
  return custom.concat(built).slice(0, 12);
}

// A row of clickable custom emoji for the emoji picker, or null when the
// server hasn't uploaded any (so the caller can skip the section entirely
// instead of rendering an empty row).
export function pickerRow(list, onPick) {
  if (!list || !list.length) return null;
  const row = document.createElement("div");
  row.className = "ce-picker";
  for (const e of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ce-picker-btn";
    btn.title = `:${e.name}:`;
    const img = document.createElement("img");
    img.className = "ce-picker-img";
    img.src = e.url;
    img.alt = `:${e.name}:`;
    img.loading = "lazy";
    img.width = 28;
    img.height = 28;
    btn.appendChild(img);
    btn.onclick = () => onPick(e);
    row.appendChild(btn);
  }
  return row;
}

// Unicode emoji plus the formatting characters that glue emoji sequences
// together (variation selector, ZWJ, regional indicators for flags, skin
// tone modifiers, the combining keycap used by 1️⃣-style digits). Not a
// perfect grapheme segmenter, just enough to answer "is this message just
// pictures" for the jumbo-render check below.
const UNICODE_EMOJI_RE =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{200D}\u{20E3}]/gu;

// True when a message is nothing but custom/unicode emoji and whitespace —
// the trigger for rendering it in the larger ".ce-big" size, same as real
// Discord does for emoji-only messages. Only :names: that actually resolve
// count; an unresolved ":name:" is just text and disqualifies the message.
export function isOnlyEmoji(text, code, reg) {
  if (!text || !text.trim()) return false;
  const noCustom = text.replace(NAME_TOKEN_RE, (whole, name) => (reg.has(code, name) ? "" : whole));
  const remainder = noCustom.replace(UNICODE_EMOJI_RE, "").trim();
  return remainder === "";
}
