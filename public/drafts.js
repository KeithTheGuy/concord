// Per-channel unsent text. Typing half a message and clicking another channel
// currently throws the half away; this keeps it.
//
// Two things shape the whole module. First, the same channel id exists in every
// server, so nothing here is keyed by chanId alone — it's always (realm code,
// channel id). Second, this lives in a localStorage key that already holds
// settings, servers and progression, so it is capped in both directions: a
// bounded number of drafts, a bounded length each, and writes are debounced
// because a JSON.stringify per keystroke is a real cost on a long draft.
//
// Storage is never touched directly. app.js owns its keys and hands us a
// get/set pair.

const MAX_DRAFTS = 64; // total across all realms, oldest-touched evicted first
const MAX_LEN = 4000; // same ceiling the composer enforces on send
const MAX_REPLY_NAME = 80;
const MAX_REPLY_CONTENT = 160;
const SAVE_DEBOUNCE_MS = 600;

// Composite key separator: ASCII unit separator, which can't occur in a realm
// code (base32-ish) or a server-minted channel id, so splitting one back apart
// is unambiguous. Written as a char code rather than a literal so the byte
// can't be mangled by an editor or a stray re-encoding of this file.
const SEP = String.fromCharCode(31);
const keyOf = (code, chanId) => `${code}${SEP}${chanId}`;

const str = (v) => (typeof v === "string" ? v : "");

// The reply target is stored beside the text because coming back to a draft
// that has forgotten what it was replying to is worse than no draft. Only the
// three fields app.js actually renders survive, clipped — the alternative is
// letting an arbitrary message object into a storage key we just capped.
function normReply(r) {
  if (!r || typeof r !== "object") return null;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name).slice(0, MAX_REPLY_NAME),
    content: str(r.content).slice(0, MAX_REPLY_CONTENT),
  };
}

/**
 * createDrafts({load, save, now?, setTimer?, clearTimer?, debounceMs?})
 *
 * `load()` returns whatever was last handed to `save(obj)`, or undefined.
 * The clock and timer injections exist so the tests can drive the debounce
 * without waiting on real time.
 */
export function createDrafts({
  load,
  save,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  debounceMs = SAVE_DEBOUNCE_MS,
} = {}) {
  const map = new Map(); // "code<US>chanId" -> {text, replyTo, at}
  let timer = null;

  // Anything in storage is untrusted — it survives across versions and a user
  // can edit it by hand. Clamp on the way in rather than trusting on the way out.
  (function hydrate() {
    let raw;
    try {
      raw = load?.();
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "object") return;
    const rows = [];
    for (const [k, v] of Object.entries(raw)) {
      if (!k.includes(SEP) || !v || typeof v !== "object") continue;
      const text = str(v.t).slice(0, MAX_LEN);
      if (!text.trim()) continue;
      rows.push([k, { text, replyTo: normReply(v.r), at: Number(v.at) || 0 }]);
    }
    rows.sort((a, b) => a[1].at - b[1].at);
    for (const [k, v] of rows.slice(-MAX_DRAFTS)) map.set(k, v);
  })();

  function serialize() {
    const out = {};
    for (const [k, v] of map) {
      out[k] = { t: v.text, at: v.at };
      if (v.replyTo) out[k].r = v.replyTo;
    }
    return out;
  }

  function persist() {
    timer = null;
    try {
      save?.(serialize());
    } catch {
      // A full or blocked localStorage must not take the composer down with it.
    }
  }

  function schedule() {
    if (timer !== null) return; // already coalescing; the write picks up the latest
    timer = setTimer(persist, debounceMs);
  }

  // Oldest-touched goes first, which is roughly the order you'd abandon them in.
  function evict() {
    if (map.size <= MAX_DRAFTS) return;
    const byAge = [...map.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [k] of byAge.slice(0, map.size - MAX_DRAFTS)) map.delete(k);
  }

  return {
    /** {text, replyTo} for this channel, or null. */
    get(code, chanId) {
      const d = map.get(keyOf(code, chanId));
      return d ? { text: d.text, replyTo: d.replyTo } : null;
    },

    /**
     * Record (or update) the draft. Empty or whitespace-only clears the entry
     * instead of storing "" — a blank draft is indistinguishable from no draft
     * and would still cost a slot and light up a sidebar marker. Returns
     * whether a draft now exists, so the caller can repaint the marker only on
     * the transitions that matter.
     */
    set(code, chanId, text, replyTo) {
      const body = str(text);
      const k = keyOf(code, chanId);
      if (!body.trim()) {
        if (map.delete(k)) schedule();
        return false;
      }
      map.set(k, { text: body.slice(0, MAX_LEN), replyTo: normReply(replyTo), at: now() });
      evict();
      schedule();
      return true;
    },

    clear(code, chanId) {
      if (!map.delete(keyOf(code, chanId))) return false;
      schedule();
      return true;
    },

    /** For the pencil marker beside a channel in the sidebar. */
    has(code, chanId) {
      return map.has(keyOf(code, chanId));
    },

    /** Realm codes holding at least one draft, for the server rail. */
    codesWithDrafts() {
      const codes = new Set();
      for (const k of map.keys()) codes.add(k.slice(0, k.indexOf(SEP)));
      return [...codes];
    },

    /** Channel ids with a draft in this realm, so the sidebar renders in one pass. */
    chansWithDrafts(code) {
      const prefix = code + SEP;
      const out = [];
      for (const k of map.keys()) if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
      return out;
    },

    /** Write now. Call from pagehide — that's the case the debounce loses. */
    flush() {
      if (timer !== null) clearTimer(timer);
      persist();
    },

    size() {
      return map.size;
    },
  };
}
