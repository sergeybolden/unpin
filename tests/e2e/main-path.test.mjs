// End-to-end test of the main path in a real browser: open the page, load a photo, read the
// report, press the button, take the download and check its bytes with Unpin's own code.
// Also checks the promise on the page: nothing leaves the site, from the page or its workers.
// Run: npm run test:e2e (needs Chromium once: npx playwright install chromium)
// Kept out of `npm test`: it starts a browser and loads the 14 MB face model, so it is slow.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import exifr from "exifr";
import { leftovers, detectFormat } from "../../js/strip.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
// The face finder loads its model and searches the photo twice (near and far): give it time.
const READY_TIMEOUT = 240_000;
const STEP_TIMEOUT = 120_000;
const TEST_TIMEOUT = 360_000;

// ---------- a tiny static server for the repository root ----------
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".wasm": "application/wasm", ".txt": "text/plain; charset=utf-8",
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
      if (path.endsWith("/")) path += "index.html";
      const file = normalize(join(ROOT, path));
      if (!file.startsWith(ROOT) || file.split(sep).includes("node_modules")) throw Object.assign(new Error(), { code: "ENOENT" });
      const body = await readFile(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
      res.end(body);
    } catch (e) {
      res.writeHead(e.code === "ENOENT" || e.code === "EISDIR" ? 404 : 500).end();
    }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let server, origin, browser;
before(async () => {
  server = await serve();
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise((r) => server?.close(r) ?? r());
});

// A fresh browser context per case. Every request from the page, its workers and its service
// worker passes through the route below: anything not for the local server is recorded and
// refused, so a leak fails the test instead of reaching the network.
async function open() {
  const context = await browser.newContext({ acceptDownloads: true, serviceWorkers: "allow", viewport: { width: 1280, height: 900 } });
  const foreign = [], requested = [];
  const local = (url) => url.startsWith(origin + "/") || /^(data|blob):/.test(url);
  context.on("request", (r) => (local(r.url()) ? requested : foreign).push(r.url()));
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (local(url)) return route.fallback();
    foreign.push(url);
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(origin + "/", { waitUntil: "load" });
  return { context, page, foreign, requested };
}

// Wait until the photo has been checked and the button can save it, then press it and
// take the download. The click waits for the far face search itself, so allow for that.
async function cleanAndDownload(page) {
  await page.locator("#clean:not([disabled])").waitFor({ timeout: READY_TIMEOUT });
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: STEP_TIMEOUT }), page.locator("#clean").click()]);
  const bytes = new Uint8Array(await readFile(await download.path()));
  await page.locator("#after").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
  return { bytes, name: download.suggestedFilename() };
}

const DATE_KEYS = ["DateTimeOriginal", "CreateDate", "ModifyDate", "DateTimeDigitized", "GPSDateStamp", "GPSTimeStamp", "DateCreated", "MetadataDate"];
const DEVICE_KEYS = ["Make", "Model", "LensMake", "LensModel", "Software", "HostComputer", "SerialNumber", "BodySerialNumber"];

// The saved file, read the way the page reads it and the way the tests of the cleaner do.
async function assertClean(bytes) {
  const format = detectFormat(bytes);
  assert.ok(["jpeg", "png", "webp"].includes(format), `saved file is an image (${format})`);
  const buf = Buffer.from(bytes);
  assert.equal(await exifr.gps(buf).catch(() => undefined), undefined, "no GPS");
  const meta = (await exifr.parse(buf, { tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false, interop: true })) || {};
  for (const k of [...DATE_KEYS, ...DEVICE_KEYS, "latitude", "longitude", "GPSLatitude", "GPSLongitude"]) {
    assert.equal(meta[k], undefined, `${k} is gone`);
  }
  assert.deepEqual(await leftovers(bytes, format), [], "nothing left for the cleaner to remove");
}

async function assertAfterReport(page) {
  const after = page.locator("#after");
  assert.equal(await after.locator("li.bad").count(), 0, "no failed check in the after-download report");
  assert.doesNotMatch(await after.innerText(), /still there/i);
}

test("demo photo: the report shows the location, the download is clean, nothing leaves the page", { timeout: TEST_TIMEOUT }, async () => {
  const { context, page, foreign, requested } = await open();
  try {
    const t0 = Date.now();
    await page.locator("#demo-try").click();
    // The location is told on the map above the findings, with the coordinates.
    await page.locator("#mapwrap").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await assert.doesNotReject(page.locator("#map-coords").filter({ hasText: /\d/ }).waitFor({ timeout: STEP_TIMEOUT }));
    assert.ok((await page.locator("#findings li").count()) > 0, "the report lists findings");
    assert.notEqual((await page.locator("#verdict").innerText()).trim(), "", "the report has a verdict");

    const { bytes, name } = await cleanAndDownload(page);
    console.log(`demo: ${name}, ${bytes.length} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s from click to download`);
    // The sample does carry what the test then expects gone.
    const src = readFileSync(join(ROOT, "assets/demo/sample.jpg"));
    assert.ok(await exifr.gps(src), "the sample has GPS to begin with");
    await assertClean(bytes);
    await assertAfterReport(page);
    // The workers did their work from this site: the face model and both wasm engines came from here.
    for (const f of [".tflite", "vision_wasm_internal.wasm", "zxing_reader.wasm"]) {
      assert.ok(requested.some((u) => u.includes(f)), `${f} was loaded from the local server`);
    }
    assert.deepEqual(foreign, [], "no request to any other origin");
  } finally {
    await context.close();
  }
});

// ---------- a photo through the file input: the lossless path ----------
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const segment = (marker, body) => cat(new Uint8Array([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body);

// A big-endian TIFF: IFD0 with Make, Model, DateTime and pointers to an EXIF IFD
// (DateTimeOriginal) and a GPS IFD (16.05 N, 108.2 E). Entries are written in tag order.
function exifSegment() {
  const strings = { make: "TestCam\0", model: "Model 7\0", date: "2024:05:01 10:20:30\0" };
  const ifd0At = 8, ifd0Size = 2 + 6 * 12 + 4;
  const makeAt = ifd0At + ifd0Size, modelAt = makeAt + strings.make.length, dateAt = modelAt + strings.model.length;
  const exifAt = dateAt + strings.date.length, exifSize = 2 + 1 * 12 + 4;
  const origAt = exifAt + exifSize;
  const gpsAt = origAt + strings.date.length, gpsSize = 2 + 4 * 12 + 4;
  const ratAt = gpsAt + gpsSize;
  const b = [];
  const u16 = (v) => b.push(v >> 8, v & 255);
  const u32 = (v) => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  const str = (s) => { for (const ch of s) b.push(ch.charCodeAt(0)); };
  b.push(0x4d, 0x4d); u16(42); u32(ifd0At);
  u16(6);
  u16(0x010f); u16(2); u32(strings.make.length); u32(makeAt);
  u16(0x0110); u16(2); u32(strings.model.length); u32(modelAt);
  u16(0x0112); u16(3); u32(1); u16(1); u16(0); // orientation: as stored
  u16(0x0132); u16(2); u32(strings.date.length); u32(dateAt);
  u16(0x8769); u16(4); u32(1); u32(exifAt);
  u16(0x8825); u16(4); u32(1); u32(gpsAt);
  u32(0);
  str(strings.make); str(strings.model); str(strings.date);
  u16(1);
  u16(0x9003); u16(2); u32(strings.date.length); u32(origAt);
  u32(0);
  str(strings.date);
  u16(4);
  u16(1); u16(2); u32(2); b.push(78, 0, 0, 0); // "N"
  u16(2); u16(5); u32(3); u32(ratAt);
  u16(3); u16(2); u32(2); b.push(69, 0, 0, 0); // "E"
  u16(4); u16(5); u32(3); u32(ratAt + 24);
  u32(0);
  for (const [n, d] of [[16, 1], [3, 1], [0, 1], [108, 1], [12, 1], [0, 1]]) { u32(n); u32(d); }
  return segment(0xe1, cat(enc("Exif\0\0"), new Uint8Array(b)));
}

const xmpSegment = () => segment(0xe1, cat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>Jane Private</rdf:li>' +
  "</rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>")));

// The 16x16 test picture (no faces, no codes) with EXIF and XMP put in after its APP0.
function photoWithMetadata() {
  const base = new Uint8Array(readFileSync(new URL("../fixtures/base.jpg", import.meta.url)));
  const app0End = base[3] === 0xe0 ? 4 + ((base[4] << 8) | base[5]) : 2;
  return { base, bytes: cat(base.subarray(0, app0End), exifSegment(), xmpSegment(), base.subarray(app0End)) };
}
const scanData = (b) => b.subarray(b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda));

test("own photo through the file input: metadata removed in place, picture unchanged", { timeout: TEST_TIMEOUT }, async () => {
  const { base, bytes: src } = photoWithMetadata();
  const gps = await exifr.gps(Buffer.from(src));
  assert.ok(gps && Math.abs(gps.latitude - 16.05) < 0.001, "the built photo has GPS");
  assert.equal((await exifr.parse(Buffer.from(src))).Make, "TestCam", "the built photo names a camera");

  const { context, page, foreign } = await open();
  try {
    const t0 = Date.now();
    await page.locator("#file").setInputFiles({ name: "holiday.jpg", mimeType: "image/jpeg", buffer: Buffer.from(src) });
    await page.locator("#mapwrap").waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    await page.locator("#keepname").setChecked(true);

    const { bytes, name } = await cleanAndDownload(page);
    console.log(`file input: ${name}, ${bytes.length} bytes, ${((Date.now() - t0) / 1000).toFixed(1)} s from choosing to download`);
    assert.equal(name, "holiday-unpinned.jpg", "the original name is kept when asked");
    await assertClean(bytes);
    // Lossless: the compressed picture is copied byte for byte, not drawn and saved again.
    assert.deepEqual(Buffer.from(scanData(bytes)), Buffer.from(scanData(base)), "image data unchanged");
    assert.ok(bytes.length < src.length, "the file got smaller");
    await assertAfterReport(page);
    assert.deepEqual(foreign, [], "no request to any other origin");
  } finally {
    await context.close();
  }
});
