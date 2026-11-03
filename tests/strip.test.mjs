// Regression tests for metadata removal. Run: npm test
// Every test file is built here from tiny generated images, so the tests carry nobody's photos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import exifr from "exifr";
import { stripJpeg, stripPng, stripWebp, detectFormat, scanC2pa, withAiLabel, BrokenFileError } from "../js/strip.js";

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

test("JPEG: the image data is copied byte for byte", () => {
  const base = fx("base.jpg");
  const src = jpegWith(exifWithGps());
  const { bytes } = stripJpeg(src);
  const sos = (b) => b.findIndex((v, i) => v === 0xff && b[i + 1] === 0xda);
  assert.deepEqual(Buffer.from(bytes.subarray(sos(bytes))), Buffer.from(base.subarray(sos(base))));
});

test("JPEG: the JFIF preview picture is removed", () => {
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

test("JPEG: XMP with a name is removed, the AI label stays", async () => {
  const src = jpegWith(app1Xmp(XMP(`Iptc4xmpExt:DigitalSourceType="${AI}"`)));
  const { bytes, keptAiLabel } = stripJpeg(src);
  assert.equal(keptAiLabel, AI);
  assert.ok(!has(bytes, "Jane Private"));
  const after = await exifr.parse(Buffer.from(bytes), { xmp: true });
  assert.equal(after.DigitalSourceType, AI);
});

test("JPEG: C2PA is removed, and its AI statement becomes the AI label", async () => {
  const src = jpegWith(app11C2pa());
  const { bytes, c2pa, keptAiLabel, removed } = stripJpeg(src);
  assert.equal(c2pa, true);
  assert.ok(removed.includes("Content Credentials (C2PA)"));
  assert.ok(!has(bytes, "jumb"));
  assert.equal(keptAiLabel, AI);
});

test("JPEG: a cut-short file is refused instead of returning a broken image", () => {
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

test("PNG: text with an AI prompt is removed, image chunks stay", () => {
  const base = fx("base.png");
  const iend = base.length - 12;
  const src = cat(base.subarray(0, iend), pngChunk("tEXt", enc("parameters\0a flat at 12 Example Street, Steps: 30")), base.subarray(iend));
  const { bytes, removed } = stripPng(src);
  assert.ok(!has(bytes, "Example Street"));
  assert.ok(removed.includes("Text"));
  assert.ok(has(bytes, "IDAT") && has(bytes, "IEND"));
});

test("PNG: a cut-short file is refused", () => {
  const base = fx("base.png");
  assert.throws(() => stripPng(base.subarray(0, base.length - 20)), BrokenFileError);
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

test("WebP: EXIF chunk is removed and the EXIF flag cleared", () => {
  const src = webpWithExif();
  assert.equal(detectFormat(src), "webp");
  const { bytes, removed } = stripWebp(src);
  assert.ok(removed.includes("EXIF"));
  assert.ok(!has(bytes, "TestCam"));
  const flags = bytes[12 + 8];
  assert.equal(flags & 0x08, 0);
});

test("C2PA scan finds the AI statement in formats we don't rebuild", () => {
  const r = scanC2pa(app11C2pa());
  assert.equal(r.present, true);
  assert.equal(r.ai, AI);
});

test("withAiLabel writes the label into a re-saved JPEG", async () => {
  const out = withAiLabel(fx("base.jpg"), "jpeg", AI);
  const meta = await exifr.parse(Buffer.from(out), { xmp: true });
  assert.equal(meta.DigitalSourceType, AI);
});
