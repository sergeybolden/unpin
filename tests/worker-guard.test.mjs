// The workers don't inherit the page's Content-Security-Policy, so js/worker-guard.js blocks every
// connection that leaves the site. Run it in a fake worker scope and try to get out.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function scope() {
  const calls = [];
  class XMLHttpRequest { open(method, url) { calls.push(["xhr", url]); } }
  const self = {
    location: new URL("https://unpin.example/js/faces-worker.js"),
    fetch: async (u) => { calls.push(["fetch", String(u)]); return { ok: true }; },
    importScripts: (...u) => calls.push(["import", ...u]),
    WebSocket: class {},
    EventSource: class {},
  };
  const ctx = vm.createContext({ self, XMLHttpRequest, Request: class { constructor(u) { this.url = u; } }, URL, TypeError, Promise, String, Object });
  vm.runInContext(readFileSync(new URL("../js/worker-guard.js", import.meta.url), "utf8"), ctx);
  return { self, XMLHttpRequest, calls };
}

test("worker guard lets the site's own files through", async () => {
  const { self, XMLHttpRequest, calls } = scope();
  await self.fetch("/vendor/mediapipe/blaze_face_short_range.tflite");
  await self.fetch("blob:https://unpin.example/123");
  new XMLHttpRequest().open("GET", "../vendor/zxing/zxing_reader.wasm");
  self.importScripts("./worker-guard.js");
  assert.equal(calls.length, 4);
});

test("worker guard blocks every way out of the site", async () => {
  const { self, XMLHttpRequest, calls } = scope();
  await assert.rejects(self.fetch("https://odml.pa.googleapis.com/v1/log"), /doesn't connect/);
  assert.throws(() => new XMLHttpRequest().open("POST", "https://example.com/"), /doesn't connect/);
  assert.throws(() => self.importScripts("https://cdn.example/x.js"), /doesn't connect/);
  assert.equal(self.WebSocket, undefined);
  assert.equal(self.EventSource, undefined);
  assert.equal(calls.length, 0);
});
