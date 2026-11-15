// Offline support: keep every file of the site in the browser cache.
// Small files are stored on install; the big ones (face model, HEIC decoder) the first time they are used.
const VERSION = "unpin-v30";
const CORE = [
  "./", "index.html", "css/app.css", "manifest.webmanifest", "assets/favicon.svg", "assets/favicon.ico", "assets/icons.svg", "vendor/fonts/figtree-latin.woff2",
  "assets/demo/river.jpg",
  "js/demo-start.js", "js/app.js", "js/strip.js", "js/xray.js", "js/detect.js", "js/redact.js", "js/map.js", "js/mascot.js", "js/mascot-places.js", "js/codes-worker.js", "js/faces-worker.js", "js/worker-guard.js", "js/logo.js", "js/inspect.js", "js/plan.js", "js/c2pa.js", "js/ai.js",
  "vendor/exifr.mjs", "vendor/data/land.json", "vendor/data/cities.json",
  "vendor/zxing/reader/index.js", "vendor/zxing/share.js", "vendor/zxing/zxing_reader.wasm",
];

// Fresh copies on install: the browser's own cache could hand over an old file.
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE.map((u) => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("unpin-") && k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Big files never change between releases of the same library: serve them from the cache.
// Everything else: try the network first, so updates arrive; fall back to the cache when offline.
const HEAVY = /\.(wasm|tflite)$|heic-to\.js$|vision_bundle\.mjs$|cities\.json$/;

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(VERSION).then(async (cache) => {
      if (HEAVY.test(url.pathname)) {
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
