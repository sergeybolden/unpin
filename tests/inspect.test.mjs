// Tests for header facts (size, transparency, animation), WebP metadata reading and export decisions.
// Run: npm test. All images are tiny generated files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import exifr from "exifr";
import { imageInfo, webpMetadata } from "../js/inspect.js";
import { exportPlan, codeCheck } from "../js/plan.js";
import { stripPng, stripWebp } from "../js/strip.js";

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

// A big-endian TIFF with Make "TestCam" and Orientation 6.
function tiffMakeOrientation() {
  const b = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2];
  const makeOff = 8 + 2 + 2 * 12 + 4;
  b.push(0x01, 0x0f, 0, 2, 0, 0, 0, 8, 0, 0, 0, makeOff); // Make, ASCII, 8 bytes
  b.push(0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0); // Orientation = 6
  b.push(0, 0, 0, 0);
  for (const ch of "TestCam\0") b.push(ch.charCodeAt(0));
  return new Uint8Array(b);
}

function riff(...chunks) {
  const body = cat(enc("WEBP"), ...chunks);
  const head = cat(enc("RIFF"), new Uint8Array([body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0]));
  return cat(head, body);
}
const chunk = (type, data) => cat(enc(type), new Uint8Array([data.length & 255, (data.length >> 8) & 255, 0, 0]), data, data.length & 1 ? new Uint8Array(1) : new Uint8Array(0));

function webpWithExif() {
  const img = fx("base.webp").subarray(12); // the VP8L chunk
  const vp8x = chunk("VP8X", new Uint8Array([0x08, 0, 0, 0, 15, 0, 0, 15, 0, 0]));
  return riff(vp8x, img, chunk("EXIF", tiffMakeOrientation()));
}

test("WebP: EXIF is read through a JPEG shell, including the rotation", async () => {
  const src = webpWithExif();
  await assert.rejects(() => exifr.parse(Buffer.from(src)), "exifr can't read WebP by itself");
  const meta = webpMetadata(src);
  assert.ok(meta && !meta.partial);
  const parsed = await exifr.parse(Buffer.from(meta.bytes), { tiff: true });
  assert.equal(parsed.Make, "TestCam");
  assert.equal(await exifr.orientation(Buffer.from(meta.bytes)), 6);
});

test("WebP: a file without EXIF or XMP has nothing to read", async () => {
  assert.equal(webpMetadata(fx("base.webp")), null);
});

test("Header sizes are read before decoding", async () => {
  assert.deepEqual(imageInfo(fx("base.jpg"), "jpeg"), { width: 16, height: 16, alpha: false, animated: false });
  assert.deepEqual(imageInfo(fx("base.png"), "png"), { width: 16, height: 16, alpha: false, animated: false });
  assert.deepEqual(imageInfo(fx("lossy.webp"), "webp"), { width: 24, height: 12, alpha: false, animated: false });
  assert.equal(imageInfo(fx("base.webp"), "webp").width, 16);
});

// A HEIC header as an iPhone writes it: tiles, the whole picture and a thumbnail, each with an
// "ispe" box, and the picture turned 270°. Boxes only, no picture data.
function heifHeader(rotate) {
  const box = (type, body) => {
    const out = new Uint8Array(8 + body.length);
    new DataView(out.buffer).setUint32(0, out.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(body, 8);
    return out;
  };
  const ispe = (w, h) => { const b = new Uint8Array(12); const dv = new DataView(b.buffer); dv.setUint32(4, w); dv.setUint32(8, h); return box("ispe", b); };
  const parts = [box("ftyp", new TextEncoder().encode("heic\0\0\0\0mif1heic")), ispe(512, 512), ispe(4032, 3024), ispe(320, 240)];
  if (rotate !== undefined) parts.push(box("irot", new Uint8Array([rotate])));
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { all.set(p, at); at += p.length; }
  return all;
}

test("HEIC size comes from its largest ispe box, turned by irot", async () => {
  assert.deepEqual(imageInfo(heifHeader(3), "heic"), { width: 3024, height: 4032, alpha: false, animated: false });
  assert.deepEqual(imageInfo(heifHeader(2), "heic"), { width: 4032, height: 3024, alpha: false, animated: false });
  assert.deepEqual(imageInfo(heifHeader(), "avif"), { width: 4032, height: 3024, alpha: false, animated: false });
  assert.equal(imageInfo(new Uint8Array(64), "heic"), null);
});

test("Transparency comes from the format, not from a sample of pixels", async () => {
  assert.equal(imageInfo(fx("alpha.png"), "png").alpha, true);
  assert.equal(imageInfo(fx("alpha.webp"), "webp").alpha, true);
  assert.equal(imageInfo(fx("base.png"), "png").alpha, false);
});

test("Animations are recognised in PNG and WebP", async () => {
  assert.equal(imageInfo(fx("anim.png"), "png").animated, true);
  assert.equal(imageInfo(fx("anim.webp"), "webp").animated, true);
  assert.equal((await stripPng(fx("anim.png"))).animated, true);
  assert.equal(stripWebp(fx("anim.webp")).animated, true);
});

test("An animation is never saved as is: only the checked first frame is", async () => {
  const plan = exportPlan({ format: "png", lossless: true, animated: true, alpha: false, covering: false });
  assert.deepEqual(plan, { mode: "redraw", outFormat: "png" });
  assert.equal(exportPlan({ format: "webp", lossless: true, animated: true, alpha: false, covering: false }).mode, "redraw");
});

test("Export: lossless when nothing is covered, PNG when there is transparency", async () => {
  assert.deepEqual(exportPlan({ format: "jpeg", lossless: true, animated: false, alpha: false, covering: false }), { mode: "lossless", outFormat: "jpeg" });
  assert.deepEqual(exportPlan({ format: "webp", lossless: true, animated: false, alpha: true, covering: true }), { mode: "redraw", outFormat: "png" });
  assert.deepEqual(exportPlan({ format: "webp", lossless: true, animated: false, alpha: false, covering: true }), { mode: "redraw", outFormat: "jpeg" });
  assert.deepEqual(exportPlan({ format: "heic", lossless: false, animated: false, alpha: false, covering: false }), { mode: "redraw", outFormat: "jpeg" });
});

test("Codes: a code kept on purpose is reported as kept, not gone", async () => {
  const qr = { format: "QRCode", text: "https://example.com/a" };
  assert.equal(codeCheck([qr], [qr]).result, "kept");
  assert.equal(codeCheck([], []).result, "ok");
});

test("Codes: a covered code that is still readable is caught, even when another was kept", async () => {
  const kept = { format: "QRCode", text: "https://example.com/keep" };
  const covered = { format: "QRCode", text: "https://example.com/hide" };
  assert.equal(codeCheck([kept], [covered]).result, "bad");
  assert.equal(codeCheck([kept], [kept, covered]).result, "bad");
  assert.equal(codeCheck([], [covered]).result, "bad");
});
