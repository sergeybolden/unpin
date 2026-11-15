// Tests with files made to mislead or break Unpin: crafted metadata, blocks that hide data,
// values out of range, sizes meant to exhaust memory. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import exifr from "../vendor/exifr.mjs";
import { xray, OPTIONS, coordinates, saysWhere } from "../js/xray.js";
import { stripJpeg, stripPng, stripWebp, leftovers } from "../js/strip.js";
import { readC2pa, cbor } from "../js/c2pa.js";

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const seg = (m, body) => cat(new Uint8Array([0xff, m, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
const has = (hay, text) => Buffer.from(hay).includes(Buffer.from(text));
const base = fx("base.jpg");
const withSegs = (...segs) => cat(base.subarray(0, 2), ...segs, base.subarray(2));
const xmp = (inner, attrs = "") => seg(0xe1, enc(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""${attrs}>${inner}</rdf:Description></rdf:RDF></x:xmpmeta>`));
const report = async (bytes, format = "jpeg") => {
  const clean = format === "jpeg" ? stripJpeg(bytes) : format === "png" ? await stripPng(bytes) : stripWebp(bytes);
  return xray(new Blob([bytes]), bytes, format, clean, bytes);
};
const ids = (info) => info.findings.map((f) => f.id);

test("XMP names can't reach Object.prototype, so one photo can't change the next one's report", async () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const P = (k, v) => `<__proto__:${k}>${v}</__proto__:${k}>`;
  const evil = [
    xmp(P("Software", "Midjourney") + P("latitude", "55.75") + P("Artist", "Somebody")),
    xmp("<constructor:Make>EvilCam</constructor:Make>"),
    xmp('<toString:Make>EvilCam</toString:Make>'),
    xmp("", ' __proto__:Make="EvilCam"'),
    xmp('<exif:Make><rdf:Description><__proto__:x>1</__proto__:x><prototype:y>2</prototype:y></rdf:Description></exif:Make>'),
  ];
  for (const s of evil) {
    for (const mergeOutput of [true, false]) await exifr.parse(withSegs(s), { ...OPTIONS, mergeOutput }).catch(() => {});
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
  for (const k of ["Software", "latitude", "Artist", "Make", "x", "y"]) {
    assert.equal({}[k], undefined, k);
    assert.equal(Object.prototype.toString[k], undefined, k);
  }
  // The next, plain photo says nothing it doesn't hold.
  const next = await report(base);
  assert.deepEqual(ids(next), ["ai"]);
  assert.equal(next.aiReport.kind, "none");
});

test("A location written only in XMP is reported, on the map and by name, and checked", async () => {
  const file = withSegs(xmp(
    "<Iptc4xmpCore:Location>Red Square</Iptc4xmpCore:Location>",
    ' xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:photoshop="http://ns.adobe.com/photoshop/1.0/" xmlns:Iptc4xmpCore="http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/"' +
    ' exif:GPSLatitude="55,45.348N" exif:GPSLongitude="37,37.038E" exif:DateTimeOriginal="2026-08-03T16:05:45+03:00" photoshop:City="Moscow" photoshop:Country="Russia"',
  ));
  const info = await report(file);
  const loc = info.findings.find((f) => f.id === "location");
  assert.ok(loc, "coordinates found");
  assert.ok(Math.abs(loc.lat - 55.7558) < 1e-3 && Math.abs(loc.lon - 37.6173) < 1e-3);
  assert.match(info.findings.find((f) => f.id === "place").text, /Red Square.*Moscow.*Russia/);
  assert.match(info.findings.find((f) => f.id === "time").text, /3 August 2026.*16:05.*UTC\+03:00/);
  // The check of a saved file uses the same test.
  assert.equal(saysWhere(await exifr.parse(file, OPTIONS)), true);
  assert.equal(saysWhere((await exifr.parse(stripJpeg(file).bytes, OPTIONS)) || {}), false);
});

test("XMP coordinates: degrees and minutes, or seconds; south and west are negative; junk is not a place", () => {
  assert.deepEqual(coordinates({ GPSLatitude: "33,52,4.8S", GPSLongitude: "151,12.6E" }), { lat: -(33 + 52 / 60 + 4.8 / 3600), lon: 151.21 });
  assert.equal(coordinates({ GPSLatitude: "95,0N", GPSLongitude: "1,0E" }), null);
  assert.equal(coordinates({ GPSLatitude: "north", GPSLongitude: "1,0E" }), null);
  assert.equal(coordinates({ latitude: NaN, longitude: 3 }), null);
});

test("JPEG: hierarchical blocks (DHP, EXP) are not copied, whatever they hold", async () => {
  const sof = base.findIndex((b, i) => b === 0xff && base[i + 1] >= 0xc0 && base[i + 1] <= 0xc2);
  for (const m of [0xde, 0xdf]) {
    const file = cat(base.subarray(0, sof), seg(m, enc("HIDDEN-PAYLOAD-".repeat(4000))), base.subarray(sof));
    const out = stripJpeg(file);
    assert.ok(!has(out.bytes, "HIDDEN-PAYLOAD"), m.toString(16));
    assert.ok(out.removed.includes("Other data blocks"));
    assert.deepEqual(await leftovers(out.bytes, "jpeg"), []);
  }
  // And a file that has them still fails the check of a saved file.
  assert.ok((await leftovers(cat(base.subarray(0, sof), seg(0xde, enc("x".repeat(20))), base.subarray(sof)), "jpeg")).length);
});

test("JPEG: only one JFIF header is kept, so repeated ones can't carry text", async () => {
  const jfif = (text) => seg(0xe0, cat(enc("JFIF\0"), enc(text.padEnd(7, " ")), new Uint8Array([0, 0])));
  const msg = "user-id=alice;gps=55.75,37.61;";
  const parts = [];
  for (let i = 0; i < msg.length; i += 7) parts.push(jfif(msg.slice(i, i + 7)));
  const out = stripJpeg(withSegs(...parts));
  assert.equal(Buffer.from(out.bytes).toString("latin1").split("JFIF\0").length - 1, 1);
  assert.ok(!has(out.bytes, "gps=55"));
  assert.ok(out.removed.includes("Other data blocks"));
});

test("JPEG: a rotation flag outside 1–8 is dropped, so the clean file passes its own check", async () => {
  const exif = (o) => seg(0xe1, cat(enc("Exif\0\0"), new Uint8Array([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, o >> 8, o & 255, 0, 0, 0, 0, 0, 0])));
  for (const o of [0, 9, 300]) {
    const file = withSegs(exif(o));
    const out = stripJpeg(file, { orientation: (await exifr.orientation(file)) || 1 });
    assert.deepEqual(await leftovers(out.bytes, "jpeg"), [], `orientation ${o}`);
    assert.equal((await exifr.orientation(out.bytes)) ?? 1, 1);
  }
  const turned = stripJpeg(withSegs(exif(6)), { orientation: 6 });
  assert.equal(await exifr.orientation(turned.bytes), 6, "a real turn stays");
});

// A minimal C2PA store: one manifest with one actions assertion, as JSON.
const box = (type, data) => cat(u32(8 + data.length), enc(type), data);
const jumb = (label, ...kids) => box("jumb", cat(box("jumd", cat(new Uint8Array(16), new Uint8Array([0x03]), enc(label + "\0"))), ...kids));
const pngWith = (type, data) => {
  const png = fx("base.png");
  const chunk = cat(u32(data.length), enc(type), data, u32(crc32(cat(enc(type), data))));
  return cat(png.subarray(0, 33), chunk, png.subarray(33));
};

test("Content Credentials with numbers or objects where text belongs still open, and say what they can", async () => {
  const actions = { actions: [{ action: 7, when: {}, softwareAgent: { name: 5, version: [1] }, description: "made with midjourney", digitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia" }] };
  const store = jumb("c2pa", jumb("urn:uuid:x", jumb("c2pa.assertions", jumb("c2pa.actions", box("json", enc(JSON.stringify(actions)))))));
  const file = pngWith("caBX", store);
  const c = readC2pa(file, "png");
  assert.equal(c.ai, "created");
  assert.equal(c.tool, null);
  assert.equal(c.when, null);
  const info = await report(file, "png");
  assert.equal(info.findings[0].title, "Made with Midjourney");
  // An actions list that isn't a list is no actions at all.
  const odd = jumb("c2pa", jumb("urn:uuid:x", jumb("c2pa.assertions", jumb("c2pa.actions", box("json", enc('{"actions":"yes"}'))))));
  assert.equal(readC2pa(pngWith("caBX", odd), "png").ai, null);
});

test("CBOR: a block claiming millions of items, or nesting too deep, is refused quickly", () => {
  const n = 20_000_000;
  const big = new Uint8Array(5 + n);
  big[0] = 0x9a;
  big.set(u32(n), 1);
  const t = performance.now();
  assert.throws(() => cbor(big), /too large/);
  assert.throws(() => cbor(cat(new Uint8Array([0x9a]), u32(1e9))), /cut short/, "a count larger than the bytes left");
  assert.throws(() => cbor(new Uint8Array(1000).fill(0x81)), /too deep/);
  assert.ok(performance.now() - t < 2000);
  assert.equal(Object.getPrototypeOf(cbor(new Uint8Array([0xa1, 0x69, ...enc("__proto__"), 0xa0]))), Object.prototype);
});

test("Data after the end of a PNG or WebP is named, and never copied", async () => {
  const tail = enc("ORIGINAL-SCREENSHOT".repeat(20));
  for (const [name, strip] of [["base.png", stripPng], ["base.webp", stripWebp]]) {
    const out = await strip(cat(fx(name), tail));
    assert.ok(out.removed.some((r) => /after the image/.test(r)), name);
    assert.ok(!has(out.bytes, "ORIGINAL-SCREENSHOT"), name);
    assert.deepEqual((await strip(fx(name))).removed, [], `${name} alone`);
  }
});

test("A PNG packed with a million empty text blocks is read in reasonable time", async () => {
  const empty = cat(u32(0), enc("tEXt"), u32(crc32(enc("tEXt"))));
  const k = 1_000_000;
  const many = new Uint8Array(empty.length * k);
  for (let i = 0; i < k; i++) many.set(empty, i * empty.length);
  const png = fx("base.png");
  const file = cat(png.subarray(0, 33), many, png.subarray(33));
  const t = performance.now();
  await xray(new Blob([file]), file, "png", null, null);
  assert.ok(performance.now() - t < 3000);
});
