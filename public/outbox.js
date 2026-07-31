// Messages that survive a dropped socket.
//
// `realm.send()` returns false when the WebSocket isn't open, and today that
// return value is thrown away — you press Enter with a dead socket and the
// message is simply gone. This is the queue that catches it.
//
// ---------------------------------------------------------------------------
// The whole design turns on one fact: THERE IS NO IDEMPOTENCY KEY ON THE
// SERVER. The nonce rides along on `msg` and comes back on `msg-ack`, but the
// Worker never remembers it — every `msg` frame it processes mints a fresh id
// and broadcasts. So a retry the server already saw produces a real, visible,
// second copy in everyone's channel.
//
// That splits an unacked message into three states we must keep apart:
//
//   queued  — send() returned false. The bytes never left the tab, so the
//             server has definitely not seen it. Retrying is free of risk and
//             is done automatically on reconnect.
//
//   sent    — send() returned true and then the socket died before the ack.
//             Genuinely ambiguous: the frame may have been delivered and
//             broadcast, or it may have evaporated in the socket buffer.
//             We do NOT retry these automatically. See below.
//
//   failed  — a human has to decide. Rendered as "failed — Retry".
//
// Why manual for the ambiguous case, rather than an automatic retry:
//
//   * The harms are not symmetric. A duplicate is public, immediate, and the
//     sender can't take it back without a second deliberate act (delete). A
//     message parked in "failed — retry" is private, visible only to its
//     author, loses nothing, and is one click from resolved. Silent data loss
//     is the only unacceptable outcome, and manual retry never causes it.
//
//   * The ambiguity resolves itself, for free, in front of the user. app.js
//     already refills channel history after an unplanned reconnect, so within
//     a second of coming back the sender can SEE whether their message landed.
//     An automatic retry fires before a human could possibly look — it throws
//     away the one piece of evidence that would have decided the question.
//
//   * Auto-retry is worst exactly when the network is worst. A flapping
//     connection acks slowly; "socket died before the ack" then means "the ack
//     was in flight", and blind retry turns a bad connection into a channel
//     full of doubles.
//
// ---------------------------------------------------------------------------
// Attachments make the ambiguous case strictly worse, so they get their own
// rules. The Worker's claimAttachments() deletes the `att:<key>` record as it
// stores the message — the key is SINGLE USE. Therefore:
//
//   * A `queued` attachment entry is safe to retry: nothing consumed the keys,
//     because nothing processed the frame. But the records expire on the server
//     after 30 minutes (ATT_TTL_MS) and the R2 objects are swept with them, so
//     we stop auto-retrying attachment entries well before that — ATTACH_MAX_AGE
//     below. Past that point a retry would post a message whose attachments are
//     silently dropped, and an image-only message would be discarded entirely
//     by the server, leaving the sender staring at a permanent "sending…".
//
//   * A `sent`-then-orphaned attachment entry is NOT retryable at all. If the
//     server did process it, the keys are already spent, and the retry posts a
//     text-only message or nothing. Retry refuses these with a reason, and the
//     UI should offer "put the text back in the composer" instead of pretending
//     a retry would work.

const MAX_ENTRIES = 50; // hard cap on the queue, oldest dropped first
const MAX_CONTENT = 4000; // same ceiling the composer enforces
const GAP_MS = 180; // between flushed sends; server allows 30 per 5s
const SAVE_DEBOUNCE_MS = 400;

// Age limits, all measured from when the user pressed Enter.
const AUTO_MAX_AGE_MS = 60 * 60 * 1000; // past an hour, stop sending it by itself
const ATTACH_MAX_AGE_MS = 20 * 60 * 1000; // comfortably inside the server's 30min ATT_TTL
const DROP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // past a day, forget it entirely

const str = (v) => (typeof v === "string" ? v : "");

/**
 * createOutbox({send, load, save, onChange?, now?, setTimer?, clearTimer?, gapMs?, debounceMs?})
 *
 * `send(code, frame)` must return true only if the frame actually reached an
 * open socket — i.e. wire it straight to `realm.send(frame)`.
 * `load()` returns what was last given to `save(arr)`.
 * `onChange(code)` fires on every state transition so the UI can repaint.
 */
export function createOutbox({
  send,
  load,
  save,
  onChange,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  gapMs = GAP_MS,
  debounceMs = SAVE_DEBOUNCE_MS,
} = {}) {
  const queue = []; // enqueue order, which is also send order
  const drains = new Map(); // code -> timer id, one drain in flight per realm
  let saveTimer = null;

  /* ------------------------------- storage ------------------------------- */

  function serialize() {
    return queue.map((e) => ({
      n: e.nonce,
      c: e.code,
      ch: e.chanId,
      at: e.at,
      s: e.state,
      r: e.reason,
      f: e.frame,
      m: e.meta,
    }));
  }

  function persist() {
    saveTimer = null;
    try {
      save?.(serialize());
    } catch {
      // Losing the persisted copy is bad; taking the composer down is worse.
    }
  }

  function schedulePersist() {
    if (saveTimer === null) saveTimer = setTimer(persist, debounceMs);
  }

  function changed(code) {
    schedulePersist();
    try {
      onChange?.(code);
    } catch {}
  }

  (function hydrate() {
    let raw;
    try {
      raw = load?.();
    } catch {
      raw = null;
    }
    if (!Array.isArray(raw)) return;
    for (const r of raw.slice(-MAX_ENTRIES)) {
      const nonce = str(r?.n);
      const code = str(r?.c);
      const frame = r?.f;
      if (!nonce || !code || !frame || typeof frame !== "object") continue;
      if (typeof frame.content === "string") frame.content = frame.content.slice(0, MAX_CONTENT);
      queue.push({
        nonce,
        code,
        chanId: str(r.ch),
        at: Number(r.at) || 0,
        // A `sent` entry that made it into storage is by definition one we
        // never saw acked — the reload IS the socket dying. Same ambiguity,
        // same answer: hand it to the human.
        state: r.s === "queued" ? "queued" : "failed",
        reason: r.s === "queued" ? null : str(r.r) || "unacked",
        frame,
        meta: r.m,
        files: hasFiles(frame),
        manual: false,
      });
    }
    sweep(now());
  })();

  /* -------------------------------- rules -------------------------------- */

  function hasFiles(frame) {
    return Array.isArray(frame?.attachments) && frame.attachments.length > 0;
  }

  // Why this entry can't go out right now, or null if it can.
  function blocker(e, t) {
    const age = t - e.at;
    if (e.files && age > ATTACH_MAX_AGE_MS) return "attachments-expired";
    // A manual retry is a fresh human decision, so it overrides the age limit
    // that only exists to stop the app resurrecting things behind your back.
    if (!e.manual && age > AUTO_MAX_AGE_MS) return "stale";
    return null;
  }

  /**
   * Drop what's too old to matter and demote anything that can no longer be
   * sent automatically. Runs on load and on every enqueue.
   */
  function sweep(t) {
    let touched = false;
    for (let i = queue.length - 1; i >= 0; i--) {
      const e = queue[i];
      if (t - e.at > DROP_MAX_AGE_MS) {
        queue.splice(i, 1);
        touched = true;
        continue;
      }
      if (e.state !== "queued") continue;
      const why = blocker(e, t);
      if (why) {
        e.state = "failed";
        e.reason = why;
        touched = true;
      }
    }
    // The cap is last so a sweep never leaves us over it.
    if (queue.length > MAX_ENTRIES) {
      queue.splice(0, queue.length - MAX_ENTRIES);
      touched = true;
    }
    return touched;
  }

  /* --------------------------------- send -------------------------------- */

  function attempt(e) {
    let ok = false;
    try {
      ok = send?.(e.code, e.frame) === true;
    } catch {
      ok = false;
    }
    if (ok) {
      e.state = "sent";
      e.reason = null;
      e.manual = false;
    }
    return ok;
  }

  function stopDrain(code) {
    const t = drains.get(code);
    if (t !== undefined) {
      clearTimer(t);
      drains.delete(code);
    }
  }

  function nextQueued(code) {
    const t = now();
    return queue.find((e) => e.code === code && e.state === "queued" && !blocker(e, t)) || null;
  }

  // One entry per tick, spaced by gapMs. Ten backed-up messages must not fire
  // as a burst into a server that cuts you off at 30 per 5 seconds.
  function drain(code) {
    drains.delete(code);
    const e = nextQueued(code);
    if (!e) return;
    // Socket went away again mid-drain. Everything stays exactly where it is —
    // nothing changed state, so nothing to repaint — and the next reconnect
    // calls flush() and picks up from here.
    if (!attempt(e)) return;
    changed(code);
    if (nextQueued(code)) drains.set(code, setTimer(() => drain(code), gapMs));
  }

  /* ---------------------------------- api -------------------------------- */

  return {
    /**
     * enqueue({code, chanId, nonce, frame, meta}) -> {nonce, state}
     *
     * `frame` is the exact object you would have passed to realm.send() — we
     * store and resend it verbatim. `nonce` is the one app.js already generated
     * for the optimistic bubble, and doubles as this entry's id.
     *
     * The send is attempted immediately unless something is already queued for
     * this realm, in which case it goes behind that — a live socket must not
     * let a new message overtake the backlog it's about to replay.
     */
    enqueue({ code, chanId, nonce, frame, meta } = {}) {
      if (!code || !nonce || !frame || typeof frame !== "object") return null;
      if (typeof frame.content === "string") frame.content = frame.content.slice(0, MAX_CONTENT);
      const e = {
        nonce,
        code,
        chanId: str(chanId) || str(frame.chanId),
        at: now(),
        state: "queued",
        reason: null,
        frame,
        meta,
        files: hasFiles(frame),
        manual: false,
      };
      queue.push(e);
      sweep(now());
      if (queue.includes(e)) {
        const backlog = queue.some((x) => x !== e && x.code === code && x.state === "queued");
        if (!backlog) attempt(e);
      }
      changed(code);
      return { nonce: e.nonce, state: e.state };
    },

    /** A msg-ack arrived. Retires that entry and only that entry. */
    ack(nonce) {
      const i = queue.findIndex((e) => e.nonce === nonce);
      if (i < 0) return false;
      const [e] = queue.splice(i, 1);
      changed(e.code);
      return true;
    },

    /**
     * The socket for this realm closed. Every entry we'd written to it but
     * never saw acked becomes the ambiguous case — handed to the user rather
     * than retried. `queued` entries are untouched: they never hit the wire.
     */
    disconnected(code) {
      stopDrain(code);
      let touched = false;
      for (const e of queue) {
        if (e.code !== code || e.state !== "sent") continue;
        e.state = "failed";
        e.reason = "unacked";
        touched = true;
      }
      if (touched) changed(code);
      return touched;
    },

    /**
     * Call on reconnect (after welcome). Replays queued entries in order,
     * spaced out. Returns how many were eligible at call time.
     */
    flush(code) {
      sweep(now());
      if (drains.has(code)) return 0;
      const t = now();
      const eligible = queue.filter((e) => e.code === code && e.state === "queued" && !blocker(e, t));
      if (!eligible.length) return 0;
      drain(code);
      return eligible.length;
    },

    /**
     * A human pressed Retry. Returns {ok, reason}.
     *
     * Refused outright when the entry carries attachments and may already have
     * been consumed — a "successful" retry there posts a message with dead
     * attachments, which is a worse outcome than the honest refusal.
     */
    retry(nonce) {
      const e = queue.find((x) => x.nonce === nonce);
      if (!e) return { ok: false, reason: "gone" };
      if (e.files && e.reason === "unacked") return { ok: false, reason: "attachments-consumed" };
      if (e.files && now() - e.at > ATTACH_MAX_AGE_MS) return { ok: false, reason: "attachments-expired" };
      e.state = "queued";
      e.reason = null;
      e.manual = true; // overrides the staleness limit, not the attachment ones
      stopDrain(e.code);
      drain(e.code);
      return { ok: true, state: e.state };
    },

    /** Mark an entry failed from outside — e.g. a server `error` or `slowmode` frame. */
    fail(nonce, reason) {
      const e = queue.find((x) => x.nonce === nonce);
      if (!e) return false;
      e.state = "failed";
      e.reason = str(reason) || "rejected";
      e.manual = false;
      changed(e.code);
      return true;
    },

    /** User dismissed it. */
    drop(nonce) {
      const i = queue.findIndex((e) => e.nonce === nonce);
      if (i < 0) return false;
      const [e] = queue.splice(i, 1);
      changed(e.code);
      return true;
    },

    /**
     * Entries for a realm (or all of them), in order, as copies. `state` and
     * `reason` are what the UI renders: "sending…" for sent, "waiting…" for
     * queued, "failed — Retry" for failed. `retryable` says whether the Retry
     * button should exist at all.
     */
    pending(code) {
      const t = now();
      return queue
        .filter((e) => code === undefined || e.code === code)
        .map((e) => ({
          nonce: e.nonce,
          code: e.code,
          chanId: e.chanId,
          at: e.at,
          state: e.state,
          reason: e.reason,
          files: e.files,
          meta: e.meta,
          retryable: !(e.files && (e.reason === "unacked" || t - e.at > ATTACH_MAX_AGE_MS)),
        }));
    },

    size() {
      return queue.length;
    },

    /** Write now — pagehide, same as drafts. */
    persist() {
      if (saveTimer !== null) clearTimer(saveTimer);
      persist();
    },

    /** Exposed for the tests and for a periodic tidy; enqueue/flush call it anyway. */
    sweep(t = now()) {
      if (sweep(t)) changed(undefined);
    },
  };
}
