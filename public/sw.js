// Concord service worker — network-first so deploys land immediately,
// cache fallback so the shell still opens offline. WebSockets and API
// calls are never intercepted.
const CACHE = "concord-v1";

self.addEventListener("install", (event) => {
  // Precache the shell so offline launch works even if the only prior visit
  // was a ?join= URL (cache keys include the query string).
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.add("/"))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== location.origin) return;
  if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) return;
  // Attachments are immutable and can be 25 MB each. Caching them here would
  // grow Cache Storage without bound for no benefit — they already carry a
  // one-year immutable Cache-Control, so the HTTP cache handles them properly.
  if (url.pathname.startsWith("/f/")) return;

  event.respondWith(
    (async () => {
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) {
          const cache = await caches.open(CACHE);
          cache.put(event.request, fresh.clone());
        }
        return fresh;
      } catch {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          const shell = await caches.match("/");
          if (shell) return shell;
        }
        throw new Error("offline and not cached");
      }
    })()
  );
});
