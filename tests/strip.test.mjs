// Regression tests for metadata removal. Run: npm test
// Every test file is built here from tiny generated images, so the tests carry nobody's photos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import exifr from "exifr";
import { stripJpeg, stripPng, stripWebp, detectFormat, scanC2pa, leftovers, BrokenFileError } from "../js/strip.js";

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const has = (bytes, text) => Buffer.from(bytes).includes(Buffer.from(text));

// A big-endian TIFF with Make and a GPS IFD (latitude 16.05 N, longitude 108.2 E).
function exifWithGps({ orientation = 1 } = {}) {
  const b = [];
  const u16 = (v) => b.push(v >> 8, v & 255);
  const u32 = (v) => b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  // header
  b.push(0x4d, 0x4d); u16(42); u32(8);
  // IFD0 at 8: Make, Orientation, GPS pointer
  const ifd0Count = 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4;
  const makeOff = 8 + ifd0Size;
  const make = "TestCam\0";
  const gpsOff = makeOff + make.length;
  u16(ifd0Count);
  u16(0x010f); u16(2); u32(make.length); u32(makeOff);
  u16(0x0112); u16(3); u32(1); u16(orientation); u16(0);
  u16(0x8825); u16(4); u32(1); u32(gpsOff);
  u32(0);
  for (const ch of make) b.push(ch.charCodeAt(0));
  // GPS IFD: LatRef, Lat, LonRef, Lon
  const gpsCount = 4;
  const ratOff = gpsOff + 2 + gpsCount * 12 + 4;
  u16(gpsCount);
  u16(1); u16(2); u32(2); b.push(78, 0, 0, 0); // "N"
  u16(2); u16(5); u32(3); u32(ratOff);
  u16(3); u16(2); u32(2); b.push(69, 0, 0, 0); // "E"
  u16(4); u16(5); u32(3); u32(ratOff + 24);
  u32(0);
  for (const [n, d] of [[16, 1], [3, 1], [0, 1], [108, 1], [12, 1], [0, 1]]) { u32(n); u32(d); }
  const body = cat(enc("Exif\0\0"), new Uint8Array(b));
  return cat(new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
}

const XMP = (extra = "") =>
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' + extra +
  '><dc:creator><rdf:Seq><rdf:li>Jane Private</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>';
const AI = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";

function app1Xmp(xml) {
  const body = cat(enc("http://ns.adobe.com/xap/1.0/\0"), enc(xml));
  return cat(new Uint8Array([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
}

// A JFIF APP0 with a 2x1 RGB preview (6 bytes of "pixels").
function jfifWithThumb() {
  const body = cat(enc("JFIF\0"), new Uint8Array([1, 2, 0, 0, 1, 0, 1, 2, 1, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff]));
  return cat(new Uint8Array([0xff, 0xe0, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
}

// An APP11 block shaped like a C2PA JUMBF box that declares AI generation.
function app11C2pa() {
  const body = cat(enc("JP\0\0\0\0\0\x01jumbjumd\0\0\0\0c2pa\0"), enc(`c2pa.actions digitalSourceType ${AI}`));
  return cat(new Uint8Array([0xff, 0xeb, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
}

// Replace the original APP0 and insert segments right after SOI.
function jpegWith(...segments) {
  const base = fx("base.jpg");
  let i = 2;
  if (base[2] === 0xff && base[3] === 0xe0) i = 4 + ((base[4] << 8) | base[5]);
  return cat(base.subarray(0, 2), ...segments, base.subarray(i));
}

test("JPEG: GPS, camera and the rest of EXIF are removed, rotation is kept", async () => {
  const src = jpegWith(exifWithGps({ orientation: 6 }));
  const before = await exifr.gps(Buffer.from(src));
  assert.ok(before && Math.abs(before.latitude - 16.05) < 0.001, "fixture has GPS");
  const { bytes, removed } = stripJpeg(src, { orientation: 6 });
  assert.equal(await exifr.gps(Buffer.from(bytes)), undefined);
  const after = (await exifr.parse(Buffer.from(bytes), { tiff: true })) || {};
  assert.equal(after.Make, undefined);
  assert.equal(await exifr.orientation(Buffer.from(bytes)), 6);
  assert.ok(removed.includes("EXIF"));
});

test("JPEG: the image data is copied byte for byte", async () => {
  const base = fx("base.jpg");
  const src = jpegWith(exifWithGps());
  const { bytes } = stripJpeg(src);
  const sos = (b) => b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
  assert.deepEqual(Buffer.from(bytes.subarray(sos(bytes))), Buffer.from(base.subarray(sos(base))));
});

test("JPEG: the JFIF preview picture is removed", async () => {
  const src = jpegWith(jfifWithThumb());
  assert.ok(Buffer.from(src).includes(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])), "fixture has preview pixels");
  const { bytes, removed } = stripJpeg(src);
  assert.ok(!Buffer.from(bytes).includes(Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff])), "preview pixels are gone");
  const app0 = bytes.subarray(2, 2 + 18);
  assert.equal(app0[1], 0xe0);
  assert.equal((app0[2] << 8) | app0[3], 16, "JFIF block is 16 bytes long");
  assert.equal(app0[16] * app0[17], 0, "preview size is 0x0");
  assert.ok(removed.includes("Preview image (JFIF)"));
});

test("JPEG: XMP with a name and the AI label is removed whole", async () => {
  const src = jpegWith(app1Xmp(XMP(`Iptc4xmpExt:DigitalSourceType="${AI}"`)));
  const { bytes, removed } = stripJpeg(src);
  assert.ok(removed.includes("XMP"));
  assert.ok(!has(bytes, "Jane Private"));
  assert.ok(!has(bytes, "trainedAlgorithmicMedia"));
  const after = (await exifr.parse(Buffer.from(bytes), { xmp: true })) || {};
  assert.equal(after.DigitalSourceType, undefined);
});

test("JPEG: C2PA is removed, with its AI statement", async () => {
  const src = jpegWith(app11C2pa());
  const { bytes, c2pa, removed } = stripJpeg(src);
  assert.equal(c2pa, true);
  assert.ok(removed.includes("Content Credentials (C2PA)"));
  assert.ok(!has(bytes, "jumb"));
  assert.ok(!has(bytes, "trainedAlgorithmicMedia"));
});

test("JPEG: a cut-short file is refused instead of returning a broken image", async () => {
  const src = jpegWith(exifWithGps());
  for (const cut of [10, 60, src.length - 3]) {
    assert.throws(() => stripJpeg(src.subarray(0, cut)), BrokenFileError, `cut at ${cut}`);
  }
});

function pngChunk(type, data) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const t = cat(enc(type), data);
  let c = 0xffffffff;
  for (const v of t) c = crcTable[(c ^ v) & 255] ^ (c >>> 8);
  const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, data.length); head.set(enc(type), 4);
  const crc = new Uint8Array(4); new DataView(crc.buffer).setUint32(0, (c ^ 0xffffffff) >>> 0);
  return cat(head, data, crc);
}

test("PNG: text with an AI prompt is removed, image chunks stay", async () => {
  const base = fx("base.png");
  const iend = base.length - 12;
  const src = cat(base.subarray(0, iend), pngChunk("tEXt", enc("parameters\0a flat at 12 Example Street, Steps: 30")), base.subarray(iend));
  const { bytes, removed } = await stripPng(src);
  assert.ok(!has(bytes, "Example Street"));
  assert.ok(removed.includes("Text"));
  assert.ok(has(bytes, "IDAT") && has(bytes, "IEND"));
});

test("PNG: a cut-short file is refused", async () => {
  const base = fx("base.png");
  await assert.rejects(() => stripPng(base.subarray(0, base.length - 20)), BrokenFileError);
});

function webpWithExif() {
  const base = fx("base.webp");
  const img = base.subarray(12); // VP8L chunk
  const vp8x = cat(enc("VP8X"), new Uint8Array([10, 0, 0, 0, 0x08, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
  const exifBody = exifWithGps().subarray(4 + 6); // TIFF without the JPEG APP1 header and "Exif\0\0"
  const exifChunk = cat(enc("EXIF"), new Uint8Array([exifBody.length & 255, (exifBody.length >> 8) & 255, 0, 0]), exifBody, exifBody.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  const body = cat(enc("WEBP"), vp8x, img, exifChunk);
  const head = cat(enc("RIFF"), new Uint8Array([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]));
  return cat(head, body);
}

test("WebP: EXIF chunk is removed and the EXIF flag cleared", async () => {
  const src = webpWithExif();
  assert.equal(detectFormat(src), "webp");
  const { bytes, removed } = stripWebp(src);
  assert.ok(removed.includes("EXIF"));
  assert.ok(!has(bytes, "TestCam"));
  const flags = bytes[12 + 8];
  assert.equal(flags & 0x08, 0);
});

test("C2PA scan finds the AI statement in formats we don't rebuild", async () => {
  const r = scanC2pa(app11C2pa());
  assert.equal(r.present, true);
  assert.equal(r.ai, AI);
});

test("WebP: XMP with the AI label is removed and the XMP flag cleared", async () => {
  const base = fx("base.webp");
  const vp8x = cat(enc("VP8X"), new Uint8Array([10, 0, 0, 0, 0x04, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
  const xmp = enc(XMP(`Iptc4xmpExt:DigitalSourceType="${AI}"`));
  const pad = xmp.length & 1 ? new Uint8Array(1) : new Uint8Array(0);
  const xmpChunk = cat(enc("XMP "), new Uint8Array([xmp.length & 255, (xmp.length >> 8) & 255, 0, 0]), xmp, pad);
  const body = cat(enc("WEBP"), vp8x, base.subarray(12), xmpChunk);
  const src = cat(enc("RIFF"), new Uint8Array([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]), body);
  const { bytes, removed } = stripWebp(src);
  assert.ok(removed.includes("XMP"));
  assert.ok(!has(bytes, "trainedAlgorithmicMedia"));
  assert.equal(bytes[12 + 8] & 0x04, 0);
});

// ---------- only picture blocks stay (audit of f5360bc) ----------
const pngWith = (...chunks) => {
  const base = fx("base.png");
  const iend = base.length - 12;
  return cat(base.subarray(0, iend), ...chunks, base.subarray(iend));
};

test("PNG: a private chunk no standard knows is removed", async () => {
  const src = pngWith(pngChunk("prIv", enc("owner=AUDIT-CANARY-42")));
  const { bytes, removed } = await stripPng(src);
  assert.ok(!has(bytes, "AUDIT-CANARY"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(fx("base.png")), "the rest is copied as is");
});

test("PNG: an unknown chunk the picture depends on is refused, so it is saved again instead", async () => {
  await assert.rejects(() => stripPng(pngWith(pngChunk("ZZZZ", enc("x")))), BrokenFileError);
});

// Settings go before the image data: right after the 33-byte signature and header.
const pngSetting = (...chunks) => { const base = fx("base.png"); return cat(base.subarray(0, 33), ...chunks, base.subarray(33)); };

test("PNG: transparency and color chunks stay", async () => {
  const src = pngSetting(pngChunk("pHYs", new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1])));
  const { bytes, removed } = await stripPng(src);
  assert.deepEqual(removed, []);
  assert.ok(has(bytes, "pHYs"));
  const alpha = fx("alpha.png");
  assert.deepEqual(Buffer.from((await stripPng(alpha)).bytes), Buffer.from(alpha));
});

test("WebP: a chunk no standard knows is removed", async () => {
  const base = fx("base.webp");
  const extra = cat(enc("prIv"), new Uint8Array([22, 0, 0, 0]), enc("owner=AUDIT-CANARY-42!"));
  const body = cat(base.subarray(8), extra);
  const src = cat(enc("RIFF"), new Uint8Array([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]), body);
  const { bytes, removed } = stripWebp(src);
  assert.ok(!has(bytes, "AUDIT-CANARY"));
  assert.ok(removed.includes("Other data blocks"));
});

test("JPEG: an APP0 that isn't JFIF and extension markers are removed", async () => {
  const seg = (m, text) => { const b = enc(text); return cat(new Uint8Array([0xff, m, (b.length + 2) >> 8, (b.length + 2) & 255]), b); };
  const src = jpegWith(seg(0xe0, "AVI1 owner=AUDIT-CANARY-1"), seg(0xf7, "owner=AUDIT-CANARY-2"), seg(0xee, "NotAdobe AUDIT-CANARY-3"));
  const { bytes, removed } = stripJpeg(src);
  assert.ok(!has(bytes, "AUDIT-CANARY"));
  for (const l of ["APP0", "Other data blocks", "APP14"]) assert.ok(removed.includes(l), l);
});

test("A cleaned file has no leftovers, Unpin's own rotation flag included", async () => {
  const jpeg = stripJpeg(jpegWith(exifWithGps({ orientation: 6 }), app1Xmp(XMP(`Iptc4xmpExt:DigitalSourceType="${AI}"`))), { orientation: 6 }).bytes;
  assert.deepEqual(await leftovers(jpeg, "jpeg"), []);
  const png = (await stripPng(pngWith(pngChunk("tEXt", enc(`XML:com.adobe.xmp\0${XMP(`Iptc4xmpExt:DigitalSourceType="${AI}"`)}`))))).bytes;
  assert.ok(!has(png, "trainedAlgorithmicMedia"), "the AI label is gone");
  assert.deepEqual(await leftovers(png, "png"), []);
  assert.deepEqual(await leftovers(stripWebp(webpWithExif()).bytes, "webp"), []);
});

test("Leftovers are found in a file that wasn't cleaned", async () => {
  assert.ok((await leftovers(pngWith(pngChunk("prIv", enc("x"))), "png")).includes("Other data blocks"));
  assert.ok((await leftovers(jpegWith(exifWithGps()), "jpeg")).includes("EXIF"));
  await assert.rejects(() => leftovers(fx("base.png"), "heic"));
});

// ---------- hidden data that viewers skip (audit of 247e1a2) ----------
const riff = (...chunks) => {
  const body = cat(enc("WEBP"), ...chunks);
  return cat(enc("RIFF"), new Uint8Array([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, body.length >>> 24]), body);
};
const webpChunk = (type, data) => cat(enc(type), new Uint8Array([data.length & 255, (data.length >> 8) & 255, (data.length >> 16) & 255, data.length >>> 24]), data, new Uint8Array(data.length & 1));
const vp8l = () => fx("base.webp").subarray(12); // one VP8L chunk, padded
const vp8xFlags = (flags) => webpChunk("VP8X", new Uint8Array([flags, 0, 0, 0, 14, 0, 0, 14, 0, 0]));

test("WebP: a second picture in the file is never saved as is", async () => {
  const second = fx("lossy.webp").subarray(12); // another picture's VP8 chunk
  for (const src of [riff(vp8l(), second), riff(vp8xFlags(0), vp8l(), second)]) {
    assert.throws(() => stripWebp(src), BrokenFileError);
    await assert.rejects(() => leftovers(src, "webp"));
  }
});

test("WebP: frames in a still picture, and anything after the picture, are removed", () => {
  const frame = webpChunk("ANMF", cat(new Uint8Array(16), fx("lossy.webp").subarray(12)));
  const { bytes, removed } = stripWebp(riff(vp8xFlags(0), frame, vp8l(), webpChunk("ICCP", enc("after the picture"))));
  assert.ok(removed.includes("Other data blocks"));
  assert.equal(bytes.length, 12 + 18 + vp8l().length, "only the header and the one picture are left");
});

test("JPEG: the Adobe block keeps its 12 bytes and nothing after them", async () => {
  const adobe = cat(enc("Adobe"), new Uint8Array([0, 100, 0, 0, 0, 0, 1]), enc("private-user-479"));
  const seg = cat(new Uint8Array([0xff, 0xee, 0, adobe.length + 2]), adobe);
  const { bytes, removed } = stripJpeg(jpegWith(seg));
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  const at = Buffer.from(bytes).indexOf(Buffer.from("Adobe"));
  assert.deepEqual([...bytes.subarray(at - 4, at + 12)], [0xff, 0xee, 0, 14, ...enc("Adobe"), 0, 100, 0, 0, 0, 0, 1]);
  assert.deepEqual(await leftovers(bytes, "jpeg"), []);
});

// A small v2 RGB profile: a white point, one tone curve shared by three channels, and the tags
// that carry names: its description, the monitor's maker and model, and a copyright.
function iccProfile() {
  const text = (s) => cat(enc("text"), new Uint8Array(4), enc(s + "\0"));
  const desc = (s) => cat(enc("desc"), new Uint8Array(4), new Uint8Array([0, 0, 0, s.length + 1]), enc(s + "\0"), new Uint8Array(8 + 3 + 67));
  const tags = [
    ["desc", desc("Calibrated by Alice Example")],
    ["wtpt", cat(enc("XYZ "), new Uint8Array(4), new Uint8Array([0, 0, 0xf6, 0xd6, 0, 1, 0, 0, 0, 0, 0xd3, 0x2d]))],
    ["rXYZ", cat(enc("XYZ "), new Uint8Array(4), new Uint8Array([0, 0, 0x6f, 0xa2, 0, 0, 0x38, 0xf5, 0, 0, 0x03, 0x90]))],
    ["gXYZ", cat(enc("XYZ "), new Uint8Array(4), new Uint8Array([0, 0, 0x62, 0x99, 0, 0, 0xb7, 0x85, 0, 0, 0x18, 0xda]))],
    ["bXYZ", cat(enc("XYZ "), new Uint8Array(4), new Uint8Array([0, 0, 0x24, 0xa0, 0, 0, 0x0f, 0x84, 0, 0, 0xb6, 0xcf]))],
    ["rTRC", cat(enc("curv"), new Uint8Array(4), new Uint8Array([0, 0, 0, 1, 2, 0x33]))],
    ["dmnd", desc("Alice's monitor maker")],
    ["dmdd", desc("Alice's monitor model")],
    ["cprt", text("Alice Example")],
  ];
  const parts = [], table = [];
  let at = 132 + (tags.length + 2) * 12;
  const align = (n) => (n + 3) & ~3;
  const offs = {};
  for (const [sig, data] of tags) { offs[sig] = at; parts.push(data, new Uint8Array(align(data.length) - data.length)); at += align(data.length); }
  const entry = (sig, off, len) => { const e = new Uint8Array(12); e.set(enc(sig)); new DataView(e.buffer).setUint32(4, off); new DataView(e.buffer).setUint32(8, len); return e; };
  for (const [sig, data] of tags) table.push(entry(sig, offs[sig], data.length));
  const curve = tags.find(([sig]) => sig === "rTRC")[1].length;
  table.push(entry("gTRC", offs.rTRC, curve), entry("bTRC", offs.rTRC, curve));
  const head = new Uint8Array(128);
  const dv = new DataView(head.buffer);
  dv.setUint32(0, at);
  head.set(enc("appl"), 4); head[8] = 2; head.set(enc("mntrRGB XYZ "), 12);
  dv.setUint16(24, 2026); dv.setUint16(26, 11); dv.setUint16(28, 6);
  head.set(enc("acsp"), 36); head.set(enc("ALICmon1"), 48); head.set(enc("alic"), 80);
  const count = new Uint8Array(4); new DataView(count.buffer).setUint32(0, tags.length + 2);
  return cat(head, count, ...table, ...parts);
}
const PRIVATE = ["Alice", "ALIC", "alic"];

test("Color profile: names and the device go, the colors stay", async () => {
  const { cleanIcc } = await import("../js/strip.js");
  const p = iccProfile();
  const c = cleanIcc(p);
  for (const s of PRIVATE) assert.ok(!has(c, s), s);
  assert.ok(has(c, "Color profile"));
  const sigs = Array.from({ length: new DataView(c.buffer).getUint32(128) }, (_, k) => new TextDecoder().decode(c.subarray(132 + k * 12, 136 + k * 12)));
  assert.deepEqual(sigs, ["desc", "wtpt", "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC"]);
  const at = (sig) => new DataView(c.buffer).getUint32(136 + sigs.indexOf(sig) * 12);
  assert.equal(at("rTRC"), at("bTRC"), "the shared curve is still shared");
  assert.deepEqual([...c.subarray(at("wtpt"), at("wtpt") + 20)], [...enc("XYZ "), 0, 0, 0, 0, 0, 0, 0xf6, 0xd6, 0, 1, 0, 0, 0, 0, 0xd3, 0x2d]);
  assert.deepEqual(Buffer.from(cleanIcc(c)), Buffer.from(c), "cleaning twice changes nothing");
});

test("Color profile: cleaned in PNG (with its name), JPEG and WebP", async () => {
  const p = iccProfile();
  const { deflateSync } = await import("node:zlib");
  const png = await stripPng(pngSetting(pngChunk("iCCP", cat(enc("Calibrated by Alice Example\0\0"), deflateSync(p)))));
  const { inflateSync } = await import("node:zlib");
  const iccp = Buffer.from(png.bytes).indexOf(Buffer.from("iCCP"));
  assert.ok(png.removed.includes("Color profile details"));
  assert.ok(has(png.bytes, "ICC Profile\0"));
  for (const s of PRIVATE) assert.ok(!has(png.bytes, s) && !has(inflateSync(png.bytes.subarray(iccp + 4 + 13)), s), `PNG ${s}`);
  assert.deepEqual(await leftovers(png.bytes, "png"), []);

  // JPEG: the profile split over two APP2 blocks, out of order.
  const app2 = (seq, data) => { const body = cat(enc("ICC_PROFILE\0"), new Uint8Array([seq, 2]), data); return cat(new Uint8Array([0xff, 0xe2, (body.length + 2) >> 8, (body.length + 2) & 255]), body); };
  const jpeg = stripJpeg(jpegWith(app2(2, p.subarray(200)), app2(1, p.subarray(0, 200))));
  assert.ok(jpeg.removed.includes("Color profile details"));
  for (const s of PRIVATE) assert.ok(!has(jpeg.bytes, s), `JPEG ${s}`);
  assert.ok(has(jpeg.bytes, "ICC_PROFILE\0\x01\x01"), "joined into one block");
  assert.deepEqual(await leftovers(jpeg.bytes, "jpeg"), []);

  const webp = stripWebp(riff(vp8xFlags(0x20), webpChunk("ICCP", p), vp8l()));
  assert.ok(webp.removed.includes("Color profile details"));
  for (const s of PRIVATE) assert.ok(!has(webp.bytes, s), `WebP ${s}`);
  assert.deepEqual(await leftovers(webp.bytes, "webp"), []);
});

test("PNG: a hidden animation frame, a second run of image data and late settings are removed", async () => {
  const base = fx("base.png");
  const iend = base.length - 12;
  const hidden = enc("a second picture");
  const src = cat(base.subarray(0, iend), pngChunk("fdAT", hidden), pngChunk("tRNS", new Uint8Array([1, 2])), pngChunk("IDAT", hidden), base.subarray(iend));
  const { bytes, removed } = await stripPng(src);
  assert.ok(!has(bytes, "a second picture"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(base));
});

test("A file packed with empty blocks is read without building a list, and refused when cleaning", async () => {
  const { imageInfo, webpMetadata, MAX_BLOCKS } = await import("../js/inspect.js");
  const empty = webpChunk("JUNK", new Uint8Array(0));
  const junk = new Uint8Array(empty.length * (MAX_BLOCKS + 5));
  for (let k = 0; k < MAX_BLOCKS + 5; k++) junk.set(empty, k * empty.length);
  const src = riff(vp8l(), junk);
  assert.deepEqual(imageInfo(src, "webp"), imageInfo(fx("base.webp"), "webp"));
  assert.equal(webpMetadata(src), null);
  assert.throws(() => stripWebp(src), BrokenFileError);
});

// ---------- second audit of 247e1a2 ----------
// Rewrite one tag entry of a profile: its offset and length.
function retag(p, sig, off, len) {
  const out = p.slice();
  const dv = new DataView(out.buffer);
  for (let k = 0; k < dv.getUint32(128); k++) {
    const e = 132 + k * 12;
    if (new TextDecoder().decode(out.subarray(e, e + 4)) === sig) { if (off != null) dv.setUint32(e + 4, off); dv.setUint32(e + 8, len); }
  }
  return out;
}
const tagAt = (p, sig) => {
  const dv = new DataView(p.buffer, p.byteOffset);
  for (let k = 0; k < dv.getUint32(128); k++) if (new TextDecoder().decode(p.subarray(132 + k * 12, 136 + k * 12)) === sig) return dv.getUint32(136 + k * 12);
};

test("Color profile: text after a tag's numbers is not copied", async () => {
  const { cleanIcc } = await import("../js/strip.js");
  // The copyright tag's text sits right after the white point in the test profile: stretching
  // the white point over it hides that text "inside" the white point.
  const p = iccProfile();
  const stretched = retag(p, "wtpt", null, tagAt(p, "rTRC") - tagAt(p, "wtpt"));
  const c = cleanIcc(stretched);
  for (const s of PRIVATE) assert.ok(!has(c, s), s);
  assert.deepEqual(Buffer.from(c), Buffer.from(cleanIcc(p)), "the same profile as without the trick");
});

test("Color profile: overlapping tags are refused before anything big is made", async () => {
  const { cleanIcc } = await import("../js/strip.js");
  const p = iccProfile();
  // The green point starting inside the red one: not the same range, not apart.
  assert.throws(() => cleanIcc(retag(p, "gXYZ", tagAt(p, "rXYZ") + 4, 20)), BrokenFileError);
  // A tone curve that claims far more points than the profile holds.
  const big = p.slice();
  new DataView(big.buffer).setUint32(tagAt(p, "rTRC") + 8, 1e8);
  assert.throws(() => cleanIcc(big), BrokenFileError);
  // A repeated tag name.
  const twice = p.slice();
  twice.set(new TextEncoder().encode("rXYZ"), 132 + 2 * 12 + 12);
  assert.throws(() => cleanIcc(twice), BrokenFileError);
});

test("Color profile: lookup tables and CMYK are saved again instead", async () => {
  const { cleanIcc } = await import("../js/strip.js");
  const p = iccProfile();
  const lut = p.slice();
  lut.set(new TextEncoder().encode("A2B0"), 132 + 3 * 12); // dmnd becomes a lookup table
  assert.throws(() => cleanIcc(lut), /can't check/);
  const cmyk = p.slice();
  cmyk.set(new TextEncoder().encode("CMYK"), 16);
  assert.throws(() => cleanIcc(cmyk), /can't check/);
});

test("PNG: the end marker is written empty", async () => {
  const base = fx("base.png");
  const src = cat(base.subarray(0, base.length - 12), pngChunk("IEND", enc("private-user-479")));
  const { bytes, removed } = await stripPng(src);
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(base));
});

// ---------- third audit of 247e1a2 ----------
test("PNG: a setting longer than its fixed size is removed, not copied", async () => {
  const phys = new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1]);
  for (const [type, data] of [["pHYs", cat(phys, enc("private-user-479"))], ["gAMA", cat(new Uint8Array([0, 0, 0xb1, 0x8f]), enc("private-user-479"))],
    ["sRGB", enc("\0private-user-479")], ["bKGD", enc("private-user-479")]]) {
    const { bytes, removed } = await stripPng(pngSetting(pngChunk(type, data)));
    assert.ok(!has(bytes, "private-user-479"), type);
    assert.ok(removed.includes("Other data blocks"), type);
    assert.deepEqual(Buffer.from(bytes), Buffer.from(fx("base.png")), type);
  }
  const ok = await stripPng(pngSetting(pngChunk("pHYs", phys)));
  assert.deepEqual(ok.removed, [], "the right size stays");
});

test("PNG: a damaged header is refused, so the picture is saved again", async () => {
  const base = fx("base.png");
  const ihdr = cat(base.subarray(16, 29), enc("x"));
  await assert.rejects(() => stripPng(cat(base.subarray(0, 8), pngChunk("IHDR", ihdr), base.subarray(33))), BrokenFileError);
});

test("Color profile: an RGB profile drops a gray curve and other unused tags", async () => {
  const { cleanIcc } = await import("../js/strip.js");
  const p = iccProfile();
  // Turn the maker tag into a well-formed gray curve whose values spell text.
  const kt = p.slice();
  const n = new DataView(kt.buffer).getUint32(128);
  const e = 132 + 12 * Array.from({ length: n }, (_, k) => new TextDecoder().decode(kt.subarray(132 + k * 12, 136 + k * 12))).indexOf("dmnd");
  kt.set(enc("kTRC"), e);
  const off = new DataView(kt.buffer).getUint32(e + 4);
  kt.set(cat(enc("curv"), new Uint8Array(4), new Uint8Array([0, 0, 0, 8]), enc("private-user-479")), off);
  const c = cleanIcc(kt);
  assert.ok(!has(c, "private-user-479"));
  assert.deepEqual(Buffer.from(c), Buffer.from(cleanIcc(p)));
});

test("WebP: an extended header of the wrong size is refused", () => {
  const long = webpChunk("VP8X", cat(new Uint8Array([0, 0, 0, 0, 14, 0, 0, 14, 0, 0]), enc("private-user-479")));
  assert.throws(() => stripWebp(riff(long, vp8l())), BrokenFileError);
});

// ---------- fourth audit of 247e1a2 ----------
test("PNG: a palette in a picture that isn't indexed is removed", async () => {
  // base.png is RGB: a palette there is only a suggestion that viewers may ignore.
  const { bytes, removed } = await stripPng(pngSetting(pngChunk("PLTE", enc("private-user-479\0\0"))));
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(fx("base.png")));
});

test("PNG: an indexed picture's palette may not hold more colors than its indices reach", async () => {
  const src = fx("alpha.png"); // 1 bit per pixel: two colors at most
  const at = Buffer.from(src).indexOf(Buffer.from("PLTE")) - 4;
  const len = new DataView(src.buffer, src.byteOffset).getUint32(at);
  const big = cat(src.subarray(0, at), pngChunk("PLTE", cat(src.subarray(at + 8, at + 8 + len), enc("private-user-479\0\0"))), src.subarray(at + 12 + len));
  await assert.rejects(() => stripPng(big), BrokenFileError);
});

const dqt = (id, text) => {
  const body = cat(new Uint8Array([id]), enc(text.padEnd(64, ".")));
  return cat(new Uint8Array([0xff, 0xdb, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
};

test("JPEG: a table defined after the last scan is removed", async () => {
  const base = fx("base.jpg");
  const src = cat(base.subarray(0, base.length - 2), dqt(0, "private-user-479"), base.subarray(base.length - 2));
  const { bytes, removed } = stripJpeg(src);
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(stripJpeg(base).bytes));
  assert.deepEqual(await leftovers(bytes, "jpeg"), []);
});

test("JPEG: a table under a number no scan uses is removed", () => {
  const base = fx("base.jpg");
  const { bytes, removed } = stripJpeg(jpegWith(dqt(3, "private-user-479")));
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(stripJpeg(jpegWith()).bytes));
});

test("JPEG: a progressive picture keeps the tables defined between its scans", () => {
  const src = fx("progressive.jpg"); // made with ImageMagick: -interlace JPEG
  const scans = Buffer.from(src).toString("latin1").split("\xff\xda").length - 1;
  assert.ok(scans > 2, "several scans");
  const { bytes, removed } = stripJpeg(src);
  assert.deepEqual(removed, []);
  assert.deepEqual(Buffer.from(bytes), Buffer.from(src));
});

// ---------- fifth audit of 247e1a2 ----------
// A Huffman table block: class (0 DC, 1 AC), number, and the symbols, all of code length 8.
const dht = (cls, id, symbols) => {
  const counts = new Uint8Array(16);
  counts[7] = symbols.length;
  const body = cat(new Uint8Array([(cls << 4) | id]), counts, symbols);
  return cat(new Uint8Array([0xff, 0xc4, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
};
const beforeFirstScan = (src, ...segs) => {
  const at = Buffer.from(src).indexOf(Buffer.from([0xff, 0xda]));
  return cat(src.subarray(0, at), ...segs, src.subarray(at));
};

test("JPEG: a file with thousands of table definitions is refused before they are listed", () => {
  const empty = cat(new Uint8Array([0x00]), new Uint8Array(16)); // a DC table with no codes
  const body = cat(...Array.from({ length: 300 }, () => empty));
  const seg = cat(new Uint8Array([0xff, 0xc4, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
  assert.throws(() => stripJpeg(jpegWith(seg)), BrokenFileError);
});

test("JPEG: a progressive picture's first DC pass doesn't read an AC table", () => {
  const src = fx("progressive.jpg");
  // An AC table 0 before the first scan (a DC pass); the file defines AC table 0 again before
  // its first AC pass, so this one is read by nothing.
  const hidden = beforeFirstScan(src, dht(1, 0, enc("private-user-479")));
  const { bytes, removed } = stripJpeg(hidden);
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(src));
});

test("JPEG: a line count block is kept only where it sets the height", async () => {
  const base = fx("base.jpg");
  const end = base.length - 2;
  // Wrong size: viewers refuse it, so Unpin saves the picture again.
  const long = cat(new Uint8Array([0xff, 0xdc, 0, 20, 0, 16]), enc("private-user-479"));
  assert.throws(() => stripJpeg(cat(base.subarray(0, end), long, base.subarray(end))), BrokenFileError);
  // The right size, but after the last scan of a picture that has its height: read by nothing.
  const { bytes, removed } = stripJpeg(cat(base.subarray(0, end), new Uint8Array([0xff, 0xdc, 0, 4, 0x47, 0x11]), base.subarray(end)));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(stripJpeg(base).bytes));
  assert.deepEqual(await leftovers(bytes, "jpeg"), []);
});

// ---------- sixth audit of 247e1a2 ----------
const beforeLastScan = (src, ...segs) => {
  const at = Buffer.from(src).lastIndexOf(Buffer.from([0xff, 0xda]));
  return cat(src.subarray(0, at), ...segs, src.subarray(at));
};

test("JPEG: a quantization table defined again after its component started is read by nothing", () => {
  const src = fx("progressive.jpg"); // every component is in the first scan
  const { bytes, removed } = stripJpeg(beforeLastScan(src, dqt(0, "private-user-479")));
  assert.ok(!has(bytes, "private-user-479"));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(src));
});

test("JPEG: arithmetic conditioning is removed from a Huffman picture", () => {
  const src = fx("progressive.jpg");
  const text = enc("private-user-479");
  const body = cat(...[...text].map((v, k) => new Uint8Array([k & 3, v]))); // DC entries 0–3, text as values
  const dac = cat(new Uint8Array([0xff, 0xcc, (body.length + 2) >> 8, (body.length + 2) & 255]), body);
  const { bytes, removed } = stripJpeg(beforeFirstScan(src, dac));
  assert.ok(!has(bytes, "private-user-479") && !Buffer.from(bytes).includes(Buffer.from([0xff, 0xcc])));
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(src));
});

test("JPEG: an arithmetic-coded picture keeps the conditioning its scans read", () => {
  for (const name of ["arithmetic.jpg", "arithmetic-progressive.jpg"]) { // made with ImageMagick
    const src = fx(name);
    const { bytes } = stripJpeg(src);
    assert.ok(Buffer.from(bytes).includes(Buffer.from([0xff, 0xcc])), `${name}: DAC kept`);
    assert.ok(!Buffer.from(bytes).includes(Buffer.from([0xff, 0xc4])), `${name}: no Huffman tables`);
  }
  assert.deepEqual(Buffer.from(stripJpeg(fx("arithmetic.jpg")).bytes), Buffer.from(fx("arithmetic.jpg")));
});

// ---------- seventh audit of 247e1a2 ----------
test("JPEG: only the restart interval a scan starts with is kept", async () => {
  const dri = (a, b) => new Uint8Array([0xff, 0xdd, 0, 4, a, b]);
  const text = enc("private-user-479");
  const hidden = Array.from({ length: 8 }, (_, k) => dri(text[2 * k], text[2 * k + 1]));
  const { bytes, removed } = stripJpeg(jpegWith(...hidden, dri(0, 0)));
  assert.equal(Buffer.from(bytes).toString("latin1").split("\xff\xdd").length - 1, 1, "one restart interval left");
  assert.ok(removed.includes("Other data blocks"));
  assert.deepEqual(Buffer.from(bytes), Buffer.from(stripJpeg(jpegWith(dri(0, 0))).bytes));
  assert.deepEqual(await leftovers(bytes, "jpeg"), []);
  // A restart interval of the wrong size is refused, so the picture is saved again.
  assert.throws(() => stripJpeg(jpegWith(new Uint8Array([0xff, 0xdd, 0, 5, 0, 0, 0]))), BrokenFileError);
});

// ---------- PNG image data (decision after the seventh audit) ----------
// Rebuild a PNG with new IDAT data: everything before the first IDAT, one IDAT, then IEND.
function withImageData(src, data) {
  const at = Buffer.from(src).indexOf(Buffer.from("IDAT")) - 4;
  return cat(src.subarray(0, at), pngChunk("IDAT", data), src.subarray(src.length - 12));
}
// The error the image data check gives, and no other: a test can't pass on some unrelated refusal.
const IMAGE_DATA = (e) => e instanceof BrokenFileError && /image data doesn't match/.test(e.message);
async function imageDataOf(src) {
  const { inflateSync } = await import("node:zlib");
  const parts = [];
  for (let i = 8; i < src.length; ) {
    const len = new DataView(src.buffer, src.byteOffset).getUint32(i);
    if (new TextDecoder().decode(src.subarray(i + 4, i + 8)) === "IDAT") parts.push(src.subarray(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const z = cat(...parts);
  return { z, raw: inflateSync(z) };
}

test("PNG: a byte after the end of the image data stream makes Unpin save the picture again", async () => {
  const base = fx("base.png");
  const { z } = await imageDataOf(base);
  const src = withImageData(base, cat(z, enc("private-user-479")));
  assert.ok(src instanceof Uint8Array);
  await assert.rejects(() => stripPng(src), IMAGE_DATA);
  await assert.rejects(() => leftovers(src, "png"), IMAGE_DATA, "a saved file like this fails the check too");
  // The same data, split over several IDAT chunks, is still one stream: it passes.
  const at = Buffer.from(base).indexOf(Buffer.from("IDAT")) - 4;
  const split = cat(base.subarray(0, at), pngChunk("IDAT", z.subarray(0, 10)), pngChunk("IDAT", z.subarray(10)), base.subarray(base.length - 12));
  assert.deepEqual((await stripPng(split)).removed, []);
});

test("PNG: a valid stream that unpacks to a row the picture doesn't have makes Unpin save it again", async () => {
  const { deflateSync } = await import("node:zlib");
  const base = fx("base.png");
  const { raw } = await imageDataOf(base);
  const rowBytes = raw.length / new DataView(base.buffer, base.byteOffset).getUint32(20);
  const extra = cat(new Uint8Array([0]), enc("private-user-479".padEnd(rowBytes - 1, ".")).subarray(0, rowBytes - 1));
  const longer = withImageData(base, deflateSync(cat(raw, extra)));
  const shorter = withImageData(base, deflateSync(raw.subarray(0, raw.length - 1)));
  const same = withImageData(base, deflateSync(raw)); // the same rows packed again: accepted
  assert.deepEqual((await stripPng(same)).removed, []);
  await assert.rejects(() => stripPng(longer), IMAGE_DATA);
  // One byte short is refused as well.
  await assert.rejects(() => stripPng(shorter), IMAGE_DATA);
});

test("PNG: interlaced pictures and every bit depth pass the image data check unchanged", async () => {
  // ImageMagick: -interlace PNG (16-bit RGB, 4-bit gray); the others are 16-bit RGB, 1-bit palette, 8-bit RGB.
  for (const name of ["interlaced.png", "interlaced-gray4.png", "base.png", "alpha.png", "anim.png"]) {
    const src = fx(name);
    const { bytes, removed } = await stripPng(src);
    assert.deepEqual(removed, [], name);
    assert.deepEqual(Buffer.from(bytes), Buffer.from(src), name);
  }
});
