// The service worker across releases: files saved for offline use must survive a new version
// of the site, and old copies of a library must not be served after the library changes.
// sw.js runs here in a small fake worker: an in-memory Cache API and a fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import vm from "node:vm";

const ORIGIN = "https://unpin.example";
const SOURCE = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

class FakeCache {
  constructor() { this.map = new Map(); }
  key(req, opts) {
    const u = new URL(typeof req === "string" ? req : req.url, ORIGIN);
    if (opts?.ignoreSearch) u.search = "";
    return u.href;
  }
  async match(req, opts) {
    if (opts?.ignoreSearch) {
      const want = this.key(req, opts);
      for (const [k, v] of this.map) if (this.key(k, opts) === want) return v.clone();
      return undefined;
    }
    return this.map.get(this.key(req))?.clone();
  }
  async put(req, res) { this.map.set(this.key(req), res); }
  async addAll(reqs) { for (const r of reqs) { const res = await net(r.url); if (!res.ok) throw new Error(r.url); this.map.set(this.key(r), res); } }
  async keys() { return [...this.map.keys()].map((url) => ({ url })); }
}
const store = new Map();
const caches = {
  async open(name) { if (!store.has(name)) store.set(name, new FakeCache()); return store.get(name); },
  async keys() { return [...store.keys()]; },
  async delete(name) { return store.delete(name); },
  async match(req, opts) { for (const c of store.values()) { const hit = await c.match(req, opts); if (hit) return hit; } return undefined; },
};
// The network: what the server sends for each path right now.
let server = {};
let online = true;
const fetched = [];
async function net(url) {
  const path = new URL(url, ORIGIN).pathname;
  fetched.push(path);
  if (!online) throw new TypeError("offline");
  return path in server ? new Response(server[path]) : new Response("not found", { status: 404 });
}

// Load one release of sw.js: VERSION and LIBS can be replaced to stand for later releases.
function load(source) {
  const handlers = {};
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, {
    self, caches, URL, Response, Promise, Set, encodeURIComponent,
    // In a worker a relative URL is resolved against the worker's own address.
    Request: class extends Request { constructor(u, o) { super(new URL(u, `${ORIGIN}/sw.js`), o); } },
    location: new URL(`${ORIGIN}/sw.js`),
    fetch: (req) => net(typeof req === "string" ? req : req.url),
  });
  const run = async (type, extra = {}) => {
    const waits = [];
    let response;
    handlers[type]({ ...extra, waitUntil: (p) => waits.push(p), respondWith: (p) => { response = p; } });
    await Promise.all(waits);
    const res = response && (await response);
    await Promise.all(waits); // cache writes started while answering
    return res;
  };
  return {
    install: () => run("install"),
    activate: () => run("activate"),
    post: (path, body) => run("fetch", { request: new Request(`${ORIGIN}/${path}`, { method: "POST", body }) }),
    get: async (path) => {
      const res = await run("fetch", { request: new Request(`${ORIGIN}/${path}`) });
      return res && res.text();
    },
  };
}

const coreList = () => [...SOURCE.match(/const CORE = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
function siteFiles(tag) {
  server = {};
  for (const f of coreList()) server[new URL(f, `${ORIGIN}/`).pathname] = `${f} ${tag}`;
}
const WASM = "vendor/mediapipe/wasm/vision_wasm_internal.wasm";
const HEIC = "vendor/heic-to.js";
const SAMPLE = "assets/demo/sample.jpg";

test("the libs cache name carries the library versions from package.json", () => {
  const libs = SOURCE.match(/const LIBS = "([^"]+)"/)[1];
  assert.ok(libs.includes(`mediapipe-${pkg.devDependencies["@mediapipe/tasks-vision"]}`), libs);
  assert.ok(libs.includes(`heic-to-${pkg.devDependencies["heic-to"]}`), libs);
});

test("every file in CORE exists", () => {
  for (const f of coreList()) {
    if (f === "./") continue;
    assert.ok(existsSync(new URL(`../${f}`, import.meta.url)), f);
  }
});

test("saved files survive a release, and an old library is not served after an update", async () => {
  // Release 1: install, then the user saves everything for offline use.
  siteFiles("r1");
  Object.assign(server, { [`/${WASM}`]: "wasm 1.2.0", [`/${HEIC}`]: "heic 1.6.7", [`/${SAMPLE}`]: "sample r1" });
  const r1 = load(SOURCE);
  await r1.install();
  await r1.activate();
  assert.equal(await r1.get(WASM), "wasm 1.2.0");
  assert.equal(await r1.get(HEIC), "heic 1.6.7");
  assert.equal(await r1.get(SAMPLE), "sample r1");

  // Release 2, same libraries: the face finder is kept without downloading it again,
  // and the sample photo is fetched fresh with the new release.
  siteFiles("r2");
  Object.assign(server, { [`/${WASM}`]: "wasm 1.2.0", [`/${HEIC}`]: "heic 1.6.7", [`/${SAMPLE}`]: "sample r2" });
  const v2 = SOURCE.replace(/const VERSION = "[^"]+"/, 'const VERSION = "unpin-test-r2"');
  const r2 = load(v2);
  fetched.length = 0;
  await r2.install();
  await r2.activate();
  assert.ok(!fetched.includes(`/${WASM}`), "the face finder was downloaded again");
  online = false;
  assert.equal(await r2.get(WASM), "wasm 1.2.0");
  assert.equal(await r2.get(HEIC), "heic 1.6.7");
  assert.equal(await r2.get(SAMPLE), "sample r2");
  assert.equal(await r2.get("index.html"), "index.html r2");
  online = true;

  // Release 3 updates the face finder: the new copy is fetched on install, the old one is gone.
  siteFiles("r3");
  Object.assign(server, { [`/${WASM}`]: "wasm 9.9.9", [`/${HEIC}`]: "heic 1.6.7", [`/${SAMPLE}`]: "sample r2" });
  const v3 = v2.replace(/const VERSION = "[^"]+"/, 'const VERSION = "unpin-test-r3"').replace(/const LIBS = "[^"]+"/, 'const LIBS = "unpin-libs-mediapipe-9.9.9-heic-to-1.6.7"');
  const r3 = load(v3);
  await r3.install();
  await r3.activate();
  assert.deepEqual((await caches.keys()).sort(), ["unpin-libs-mediapipe-9.9.9-heic-to-1.6.7", "unpin-test-r3"].sort());
  online = false;
  assert.equal(await r3.get(WASM), "wasm 9.9.9");
  for (const name of await caches.keys()) {
    for (const { url } of await (await caches.open(name)).keys()) {
      const res = await (await caches.open(name)).match(url);
      assert.notEqual(await res.text(), "wasm 1.2.0", `old library still cached in ${name}`);
    }
  }
  online = true;
});

test("a photo shared from another app is kept on the device, never sent to the network", async () => {
  siteFiles("share");
  const sw = load(SOURCE);
  await sw.install();
  await sw.activate();
  const form = new FormData();
  form.append("photos", new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], "IMG 1.jpg", { type: "image/jpeg" }));
  form.append("photos", new File([new Uint8Array([0x89, 0x50])], "b.png", { type: "image/png" }));
  fetched.length = 0;
  const res = await sw.post("share-target", form);
  assert.deepEqual(fetched, [], "the shared photo went to the network");
  assert.equal(res.status, 303);
  assert.equal(new URL(res.headers.get("Location")).search, "?shared");
  const cache = await caches.open("unpin-shared");
  const keys = await cache.keys();
  assert.equal(keys.length, 2);
  const first = await cache.match(keys[0].url);
  assert.equal(decodeURIComponent(first.headers.get("X-Name")), "IMG 1.jpg");
  assert.equal(first.headers.get("Content-Type"), "image/jpeg");
  assert.equal((await first.arrayBuffer()).byteLength, 6);
  // A new release doesn't throw away photos still waiting for the page.
  const next = load(SOURCE.replace(/const VERSION = "[^"]+"/, 'const VERSION = "unpin-test-share2"'));
  await next.install();
  await next.activate();
  assert.ok((await caches.keys()).includes("unpin-shared"));
});

test("the manifest's share target stays inside the app and takes image files", () => {
  const m = JSON.parse(readFileSync(new URL("../manifest.webmanifest", import.meta.url), "utf8"));
  const t = m.share_target;
  assert.equal(t.method, "POST");
  assert.equal(t.enctype, "multipart/form-data");
  assert.equal(new URL(t.action, `${ORIGIN}/`).pathname, "/share-target");
  assert.ok(SOURCE.includes('url.pathname.endsWith("/share-target")'));
  assert.equal(t.params.files[0].name, "photos");
  assert.ok(SOURCE.includes('form.getAll("photos")'));
  assert.ok(t.params.files[0].accept.includes("image/*"));
  assert.equal(m.id, "./");
});
