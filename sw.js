// Offline support: keep every file of the site in the browser cache.
// Small files are stored on install; the big ones (face model, HEIC decoder) the first time they are used.
//
// Two caches:
// - VERSION: the site itself. A new release gets a new cache and the old one is deleted.
// - LIBS: the face finder and the HEIC decoder (about 17 MB). They don't change between releases,
//   so their cache outlives them; its name carries the library versions from package.json
//   (tests/sw.test.mjs checks that), so a library update starts a new one and the old copies go.
const VERSION = "unpin-v34";
const LIBS = "unpin-libs-mediapipe-1.2.0-heic-to-1.6.7";
const CORE = [
  "./", "index.html", "licenses.html", "css/app.css", "manifest.webmanifest", "assets/favicon.svg", "assets/favicon.ico", "assets/icons.svg", "vendor/fonts/figtree-latin.woff2",
  "assets/demo/river.jpg",
  "js/demo-start.js", "js/app.js", "js/strip.js", "js/xray.js", "js/detect.js", "js/redact.js", "js/map.js", "js/mascot.js", "js/mascot-places.js", "js/codes-worker.js", "js/faces-worker.js", "js/worker-guard.js", "js/logo.js", "js/inspect.js", "js/plan.js", "js/batch.js", "js/c2pa.js", "js/ai.js",
  "vendor/exifr.mjs", "vendor/data/land.json", "vendor/data/cities.json",
  "vendor/zxing/reader/index.js", "vendor/zxing/share.js", "vendor/zxing/zxing_reader.wasm",
];
// Files that live in LIBS.
const IN_LIBS = /\/vendor\/(mediapipe\/|heic-to\.js$)/;
// Big files that never change within a release (or a library version): served from the cache first.
const CACHE_FIRST = /\/vendor\/(mediapipe\/|heic-to\.js$|zxing\/zxing_reader\.wasm$|data\/cities\.json$)/;

const cacheName = (url) => (IN_LIBS.test(new URL(url, location.href).pathname) ? LIBS : VERSION);
// Photos shared to Unpin from another app wait here until the page takes them (see share-target below).
const SHARED = "unpin-shared";
const ours = (k) => k.startsWith("unpin-") && k !== SHARED;

// Fresh copies on install: the browser's own cache could hand over an old file.
// Files saved later on (the sample photo, or the face finder after a library update) were saved
// for offline use on purpose: fetch fresh copies of them too, so a release doesn't quietly drop them.
self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const site = await caches.open(VERSION);
    await site.addAll(CORE.map((u) => new Request(u, { cache: "reload" })));
    const core = new Set(CORE.map((u) => new URL(u, location.href).href));
    const want = new Set();
    for (const k of await caches.keys()) {
      if (!ours(k) || k === VERSION || k === LIBS) continue;
      for (const req of await (await caches.open(k)).keys()) if (!core.has(req.url)) want.add(req.url);
    }
    const libs = await caches.open(LIBS);
    // Best effort: a file that can't be fetched now is fetched again when it's next used.
    await Promise.allSettled([...want].map(async (url) => {
      const cache = cacheName(url) === LIBS ? libs : site;
      if (await cache.match(url)) return;
      const res = await fetch(url, { cache: "reload" });
      if (res.ok) await cache.put(url, res);
    }));
    await self.skipWaiting();
  })());
});

// Only the current two caches stay.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => ours(k) && k !== VERSION && k !== LIBS).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method === "POST" && url.origin === location.origin && url.pathname.endsWith("/share-target")) {
    e.respondWith(receiveShared(e.request));
    return;
  }
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(cacheName(url.href)).then(async (cache) => {
      if (CACHE_FIRST.test(url.pathname)) {
        const hit = await cache.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
      }
      try {
        // "no-cache" asks the server whether the file changed (a cheap 304 when it didn't),
        // so an update reaches you on the next load instead of after the browser's cache expires.
        const res = await fetch(e.request, { cache: "no-cache" });
        // Keep the worker alive until the copy is stored, so "saved for offline" is true when it says so.
        if (res.ok) e.waitUntil(cache.put(e.request, res.clone()));
        return res;
      } catch (err) {
        const hit = await cache.match(e.request, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    }),
  );
});

// A photo shared to Unpin from another app (Android's share sheet, share_target in
// manifest.webmanifest) arrives as a form POST. It is answered here, on the device: the POST never
// reaches the network. The files wait in their own cache, and the page, opened with ?shared,
// takes them from there (receiveShared in js/app.js) and opens them like dropped files.
async function receiveShared(request) {
  try {
    const form = await request.formData();
    const files = form.getAll("photos").filter((f) => typeof f === "object" && f.size > 0);
    await caches.delete(SHARED); // photos shared earlier and never opened go
    const cache = await caches.open(SHARED);
    await Promise.all(files.map((f, i) => cache.put(`shared/${i}`, new Response(f, {
      headers: { "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || "photo") },
    }))));
  } catch {
    // The page then finds nothing and says so.
  }
  return Response.redirect(new URL("./?shared", location.href).href, 303);
}
