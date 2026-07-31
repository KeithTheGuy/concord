// Attachments: staging, the upload-ticket handshake, and rendering.
//
// The handshake (CONTRACTS.md §1) is three hops because the Durable Object is
// the only thing that knows who you are — a bare POST has no socket and
// therefore no identity. So: ask for a ticket over the socket you're already
// authenticated on, spend it over HTTP, then reference the result in a normal
// msg. createUploader owns the staging tray between "picked" and "sent"; the
// render helpers below turn a message's attachments array into DOM.

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
const TICKET_TIMEOUT_MS = 15000;

let idSeq = 0;
function nextId() {
  return "u" + Date.now().toString(36) + (idSeq++).toString(36);
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function isImage(mime) {
  return !!mime && mime.startsWith("image/");
}
export function isVideo(mime) {
  return !!mime && mime.startsWith("video/");
}
export function isAudio(mime) {
  return !!mime && mime.startsWith("audio/");
}

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

const EXT_ICONS = {
  pdf: "📕",
  zip: "🗜️",
  json: "🧾",
  txt: "📄",
  doc: "📝",
  docx: "📝",
  xls: "📊",
  xlsx: "📊",
  csv: "📊",
};

export function fileIcon(name, mime = "") {
  if (isImage(mime)) return "🖼️";
  if (isVideo(mime)) return "🎬";
  if (isAudio(mime)) return "🎵";
  const ext = (name || "").split(".").pop()?.toLowerCase();
  return EXT_ICONS[ext] || "📎";
}

/* ------------------------------- uploader --------------------------------- */

// Best-effort metadata probe. Never blocks add() — the fields just stay
// undefined if a browser can't decode the file, which the server doesn't
// care about anyway since w/h/dur are cosmetic hints, not trusted values.
function probeDimensions(item) {
  const { file, mime } = item;
  if (isImage(mime)) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    const done = () => URL.revokeObjectURL(url);
    img.onload = () => {
      item.w = img.naturalWidth;
      item.h = img.naturalHeight;
      done();
    };
    img.onerror = done;
    img.src = url;
  } else if (isVideo(mime)) {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    const done = () => URL.revokeObjectURL(url);
    v.onloadedmetadata = () => {
      item.w = v.videoWidth;
      item.h = v.videoHeight;
      item.dur = v.duration;
      done();
    };
    v.onerror = done;
    v.src = url;
  } else if (isAudio(mime)) {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    a.preload = "metadata";
    const done = () => URL.revokeObjectURL(url);
    a.onloadedmetadata = () => {
      item.dur = a.duration;
      done();
    };
    a.onerror = done;
    a.src = url;
  }
}

function toDescriptor(item) {
  return {
    key: item.key,
    name: item.name,
    size: item.size,
    mime: item.mime,
    w: item.w,
    h: item.h,
    dur: item.dur,
    spoiler: item.spoiler,
  };
}

export function createUploader(hooks) {
  const tray = new Map(); // id -> item
  let pending = null; // {resolve, reject, timer} for an in-flight ticket request

  function items() {
    return [...tray.values()];
  }

  function add(fileList) {
    const added = [];
    const seen = new Set(items().map((it) => it.name + ":" + it.size));
    for (const file of fileList) {
      if (tray.size + added.length >= MAX_FILES) {
        hooks.onError?.(`Only ${MAX_FILES} files at a time.`);
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        hooks.onError?.(`${file.name} is over 25 MB.`);
        continue;
      }
      const dedupeKey = file.name + ":" + file.size;
      if (seen.has(dedupeKey)) continue; // a double drop shouldn't double up
      seen.add(dedupeKey);

      const item = {
        id: nextId(),
        file,
        name: file.name,
        size: file.size,
        mime: file.type || "application/octet-stream",
        w: undefined,
        h: undefined,
        dur: undefined,
        spoiler: false,
        state: "staged",
        pct: 0,
        key: undefined,
        error: undefined,
      };
      tray.set(item.id, item);
      added.push(item);
      probeDimensions(item);
    }
    return added;
  }

  function remove(id) {
    tray.delete(id);
  }

  function toggleSpoiler(id) {
    const item = tray.get(id);
    if (item) item.spoiler = !item.spoiler;
  }

  function clear() {
    tray.clear();
  }

  function isEmpty() {
    return tray.size === 0;
  }

  function busy() {
    return items().some((it) => it.state === "uploading");
  }

  function handleTickets(msg) {
    if (!pending) return; // nothing waiting — a stray or duplicate frame
    clearTimeout(pending.timer);
    const p = pending;
    pending = null;
    p.resolve(msg.tickets || []);
  }

  function requestTickets(staged) {
    return new Promise((resolve, reject) => {
      pending = {
        resolve,
        reject,
        // A socket that dies mid-request would otherwise hang the composer
        // forever waiting for a reply that's never coming.
        timer: setTimeout(() => {
          pending = null;
          reject(new Error("Timed out waiting for upload tickets."));
        }, TICKET_TIMEOUT_MS),
      };
      hooks.send({
        type: "upload-ticket",
        files: staged.map((it) => ({ name: it.name, size: it.size, mime: it.mime })),
      });
    });
  }

  // XMLHttpRequest, not fetch — xhr.upload.onprogress is the only way to get
  // a real progress bar out of a request body in a browser. Yes, still.
  function uploadOne(item, ticket) {
    return new Promise((resolve, reject) => {
      item.state = "uploading";
      item.pct = 0;
      item.error = undefined;
      hooks.onProgress?.(item);

      const xhr = new XMLHttpRequest();
      xhr.open("PUT", `/api/upload/${ticket.id}?code=${encodeURIComponent(hooks.code())}`);
      xhr.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        item.pct = Math.round((e.loaded / e.total) * 100);
        hooks.onProgress?.(item);
      };
      xhr.onerror = () => {
        item.state = "error";
        item.error = "Network error during upload.";
        hooks.onProgress?.(item);
        reject(new Error(item.error));
      };
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          item.state = "error";
          item.error = `Upload failed (${xhr.status}).`;
          hooks.onProgress?.(item);
          reject(new Error(item.error));
          return;
        }
        let body;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          item.state = "error";
          item.error = "Bad response from server.";
          hooks.onProgress?.(item);
          reject(new Error(item.error));
          return;
        }
        item.state = "done";
        item.pct = 100;
        item.key = body.att?.key;
        hooks.onProgress?.(item);
        resolve();
      };
      xhr.send(item.file);
    });
  }

  // Requests tickets for whatever's staged (or errored — a retry), uploads
  // each, and returns descriptors for everything currently done, including
  // files a previous flush() already finished. That makes flush() safe to
  // call again after a partial failure instead of re-uploading successes.
  async function flush() {
    const staged = items().filter((it) => it.state === "staged" || it.state === "error");

    if (staged.length) {
      let tickets;
      try {
        tickets = await requestTickets(staged);
      } catch (err) {
        hooks.onError?.(err.message);
        throw err;
      }

      for (let i = 0; i < staged.length; i++) {
        const item = staged[i];
        const ticket = tickets[i];
        if (!ticket) {
          item.state = "error";
          item.error = "No ticket issued.";
          hooks.onProgress?.(item);
          continue;
        }
        try {
          await uploadOne(item, ticket);
        } catch {
          // One bad upload shouldn't sink the rest of the batch — it's left
          // in "error" state so the caller can show a retry affordance.
        }
      }
    }

    return items()
      .filter((it) => it.state === "done")
      .map(toDescriptor);
  }

  return { add, items, remove, toggleSpoiler, clear, isEmpty, busy, handleTickets, flush };
}

/* ------------------------------ rendering ---------------------------------- */

// Blur wrapper for spoilered attachments. The click listener runs in the
// capture phase and, while unrevealed, calls stopPropagation before the
// event reaches the real content — so a spoilered video's controls can't be
// triggered by the same click that reveals it, no CSS pointer-events trick
// needed.
function wrapSpoiler(att, revealedSet, contentEl) {
  if (!att.spoiler) return contentEl;
  const already = revealedSet?.has(att.key);
  const holder = el("div", "att-spoiler" + (already ? " revealed" : ""));
  holder.appendChild(contentEl);
  holder.appendChild(el("div", "att-spoiler-label", "Spoiler"));
  holder.addEventListener(
    "click",
    (e) => {
      if (holder.classList.contains("revealed")) return;
      e.preventDefault();
      e.stopPropagation();
      holder.classList.add("revealed");
      revealedSet?.add(att.key);
    },
    true
  );
  return holder;
}

function buildFileCard(att) {
  const card = el("a", "att-file");
  card.href = att.url;
  card.download = att.name || "";
  card.target = "_blank";
  card.rel = "noreferrer noopener";
  card.appendChild(el("span", "att-file-icon", fileIcon(att.name, att.mime)));
  const meta = el("div", "att-file-meta");
  meta.appendChild(el("div", "att-file-name", att.name || "file"));
  meta.appendChild(el("div", "att-file-size", humanSize(att.size || 0)));
  card.appendChild(meta);
  card.appendChild(el("span", "att-file-download", "⬇"));
  return card;
}

function buildImageTile(att, revealedSet, onOpen) {
  const tile = el("div", "att-img-tile");
  if (att.w && att.h) tile.style.aspectRatio = `${att.w} / ${att.h}`;
  const img = document.createElement("img");
  img.className = "att-img";
  img.loading = "lazy";
  img.alt = att.name || "";
  img.src = att.url;
  img.onclick = () => onOpen(att);
  img.onerror = () => {
    tile.classList.add("att-img-tile-broken");
    tile.replaceChildren(buildFileCard(att));
  };
  tile.appendChild(img);
  return wrapSpoiler(att, revealedSet, tile);
}

function buildVideo(att, revealedSet) {
  const wrap = el("div", "att-video-wrap");
  const video = document.createElement("video");
  video.className = "att-video";
  video.controls = true;
  video.preload = "metadata";
  video.src = att.url;
  if (att.w && att.h) video.style.aspectRatio = `${att.w} / ${att.h}`;
  wrap.appendChild(video);
  return wrapSpoiler(att, revealedSet, wrap);
}

function buildAudio(att, revealedSet) {
  const wrap = el("div", "att-audio-wrap");
  const audio = document.createElement("audio");
  audio.className = "att-audio";
  audio.controls = true;
  audio.src = att.url;
  wrap.appendChild(audio);
  wrap.appendChild(el("div", "att-audio-name", att.name || ""));
  return wrapSpoiler(att, revealedSet, wrap);
}

// Builds the DOM for one message's attachments array, or null if there's
// nothing to show. Images get their own grid (sized by count) with w/h
// reserved up front — the single most important detail here, since a chat
// that reflows as thumbnails decode is miserable to read.
export function renderAttachments(atts, opts = {}) {
  if (!atts || !atts.length) return null;
  const revealedSet = opts.spoilerRevealed;
  const onOpen = opts.onOpen || (() => {});

  const wrap = el("div", "att-list");
  const images = atts.filter((a) => isImage(a.mime));

  if (images.length) {
    const gridCls =
      images.length === 1 ? "att-grid-solo" : images.length <= 4 ? "att-grid-tiled" : "att-grid-compact";
    const grid = el("div", "att-grid " + gridCls);
    for (const att of images) grid.appendChild(buildImageTile(att, revealedSet, onOpen));
    wrap.appendChild(grid);
  }

  for (const att of atts) {
    if (isImage(att.mime)) continue;
    if (isVideo(att.mime)) wrap.appendChild(buildVideo(att, revealedSet));
    else if (isAudio(att.mime)) wrap.appendChild(buildAudio(att, revealedSet));
    else wrap.appendChild(wrapSpoiler(att, revealedSet, buildFileCard(att)));
  }

  return wrap.children.length ? wrap : null;
}

/* ------------------------------- lightbox ---------------------------------- */

let active = null; // {close} while a lightbox is open, so a second open cleans up the first

export function openLightbox(att, all = []) {
  active?.close();

  const gallery = all.filter((a) => isImage(a.mime) || isVideo(a.mime));
  let idx = gallery.findIndex((a) => a.key === att.key);
  if (idx === -1) {
    gallery.unshift(att);
    idx = 0;
  }

  const root = el("div", "lb-backdrop");
  const frame = el("div", "lb-frame");
  const stage = el("div", "lb-stage");
  const closeBtn = el("button", "lb-close", "✕");
  const prevBtn = el("button", "lb-prev", "‹");
  const nextBtn = el("button", "lb-next", "›");
  const footer = el("div", "lb-footer");
  const caption = el("div", "lb-caption");
  const download = el("a", "lb-download", "Download");
  download.target = "_blank";
  download.rel = "noreferrer noopener";

  footer.appendChild(caption);
  footer.appendChild(download);
  frame.appendChild(stage);
  frame.appendChild(closeBtn);
  frame.appendChild(prevBtn);
  frame.appendChild(nextBtn);
  frame.appendChild(footer);
  root.appendChild(frame);

  function render() {
    const a = gallery[idx];
    stage.replaceChildren();
    if (isVideo(a.mime)) {
      const v = document.createElement("video");
      v.className = "lb-media";
      v.controls = true;
      v.autoplay = true;
      v.src = a.url;
      stage.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.className = "lb-media";
      img.alt = a.name || "";
      img.src = a.url;
      stage.appendChild(img);
    }
    caption.textContent = a.name || "";
    download.href = a.url;
    download.download = a.name || "";
    const canNav = gallery.length > 1;
    prevBtn.style.display = canNav ? "" : "none";
    nextBtn.style.display = canNav ? "" : "none";
  }

  function go(delta) {
    idx = (idx + delta + gallery.length) % gallery.length;
    render();
  }

  function onKeydown(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }

  function close() {
    document.removeEventListener("keydown", onKeydown);
    root.remove();
    active = null;
  }

  root.onclick = (e) => {
    if (e.target === root) close(); // backdrop only — clicks on the frame stay open
  };
  closeBtn.onclick = close;
  prevBtn.onclick = () => go(-1);
  nextBtn.onclick = () => go(1);

  document.addEventListener("keydown", onKeydown);
  active = { close };

  document.body.appendChild(root);
  render();
}
