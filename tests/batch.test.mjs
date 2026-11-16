// Cleaning several photos at once: the zip must open in any tool, its names must not give the
// original names away, and a photo that failed its check never counts as clean.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
import { crc32, zipParts, batchNames, cleanName, batchOutcome } from "../js/batch.js";

const bytes = (s) => new TextEncoder().encode(s);
const concat = (parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
const entry = (name, data) => ({ name, data, size: data.length, crc: crc32(data) });

// Read a zip back by its central directory, the way unzip tools do, and check every field
// against the local header and the data.
function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const endAt = buf.length - 22;
  assert.equal(v.getUint32(endAt, true), 0x06054b50, "end of central directory");
  const count = v.getUint16(endAt + 10, true);
  const cdSize = v.getUint32(endAt + 12, true);
  let at = v.getUint32(endAt + 16, true);
  assert.equal(at + cdSize, endAt, "central directory ends where the end record starts");
  const files = [];
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(at, true), 0x02014b50, "central header");
    const flags = v.getUint16(at + 8, true), method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true), size = v.getUint32(at + 20, true), raw = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true), extra = v.getUint16(at + 30, true), comment = v.getUint16(at + 32, true);
    const offset = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(buf.subarray(at + 46, at + 46 + nameLen));
    assert.equal(method, 0, "stored");
    assert.equal(flags & 0x0800, 0x0800, "UTF-8 names");
    assert.equal(size, raw);
    // The local header says the same.
    assert.equal(v.getUint32(offset, true), 0x04034b50, "local header");
    assert.equal(v.getUint32(offset + 14, true), crc);
    assert.equal(v.getUint32(offset + 18, true), size);
    const localName = v.getUint16(offset + 26, true), localExtra = v.getUint16(offset + 28, true);
    assert.equal(new TextDecoder().decode(buf.subarray(offset + 30, offset + 30 + localName)), name);
    const data = buf.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    assert.equal(crc32(data), crc, `CRC of ${name}`);
    files.push({ name, data: Buffer.from(data), date: v.getUint16(at + 14, true) });
    at += 46 + nameLen + extra + comment;
  }
  return files;
}

test("CRC-32 matches the standard one", () => {
  assert.equal(crc32(bytes("")), 0);
  assert.equal(crc32(bytes("123456789")), 0xcbf43926); // the check value of CRC-32
  const big = new Uint8Array(100000).map((_, i) => (i * 31) ^ (i >> 3));
  if (zlib.crc32) assert.equal(crc32(big), zlib.crc32(big));
  // In pieces, as the same CRC.
  assert.equal(crc32(big.subarray(5000), crc32(big.subarray(0, 5000))), crc32(big));
});

test("the zip holds every file, byte for byte, with its CRC", () => {
  const a = new Uint8Array(3000).map((_, i) => i & 0xff);
  const b = bytes("second file");
  const files = readZip(concat(zipParts([entry("photo-1-unpinned.jpg", a), entry("Фото · 2-unpinned.png", b)])));
  assert.deepEqual(files.map((f) => f.name), ["photo-1-unpinned.jpg", "Фото · 2-unpinned.png"]);
  assert.deepEqual(files[0].data, Buffer.from(a));
  assert.deepEqual(files[1].data, Buffer.from(b));
  // The same date on every file, the earliest a zip can say: nothing about when.
  for (const f of files) assert.equal(f.date, (0 << 9) | (1 << 5) | 1);
});

test("an empty zip is still a zip", () => {
  assert.deepEqual(readZip(concat(zipParts([]))), []);
});

test("the zip opens in the system's unzip", (t) => {
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch { return t.skip("no unzip here"); }
  const dir = mkdtempSync(join(tmpdir(), "unpin-zip-"));
  try {
    const file = join(dir, "photos.zip");
    writeFileSync(file, concat(zipParts([entry("a-unpinned.jpg", bytes("one")), entry("b-unpinned.jpg", bytes("two"))])));
    const out = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    assert.match(out, /No errors detected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("names inside the zip say nothing about the originals unless asked", () => {
  const items = [
    { original: "IMG_1994.HEIC", outFormat: "jpeg", at: 1 },
    { original: "Anna at home.png", outFormat: "png", at: 2 },
    { original: "IMG_1994.jpg", outFormat: "jpeg", at: 3 },
  ];
  assert.deepEqual(batchNames(items, false), ["photo-1-unpinned.jpg", "photo-2-unpinned.png", "photo-3-unpinned.jpg"]);
  // Padded to the batch size, so they sort in order.
  assert.deepEqual(batchNames([{ original: "x.jpg", outFormat: "jpeg", at: 3 }], false, 12), ["photo-03-unpinned.jpg"]);
  // Kept names, made unique (whatever the case of the letters).
  assert.deepEqual(batchNames(items, true), ["IMG_1994-unpinned.jpg", "Anna at home-unpinned.png", "IMG_1994-unpinned-2.jpg"]);
  assert.deepEqual(
    batchNames([{ original: "a.jpg", outFormat: "jpeg", at: 1 }, { original: "A.JPG", outFormat: "jpeg", at: 2 }], true),
    ["a-unpinned.jpg", "A-unpinned-2.jpg"],
  );
});

test("a kept name can't climb out of the zip or break a disk", () => {
  const [n] = batchNames([{ original: "../../etc/pass\u0000wd.jpg", outFormat: "jpeg", at: 1 }], true);
  assert.ok(!n.includes("/") && !n.includes("\\") && !n.includes("\u0000") && !n.startsWith("."), n);
  assert.equal(cleanName("", "png", true), "photo-unpinned.png");
  assert.equal(cleanName("C:\\Users\\me\\IMG_1.jpg", "jpeg", true), "C_Users_me_IMG_1-unpinned.jpg");
  assert.equal(cleanName("IMG_1.jpg", "jpeg", false), "photo-unpinned.jpg");
});

test("a photo with anything still in it is never counted as clean", () => {
  assert.equal(batchOutcome([{ result: "ok" }, { result: "info" }]), "clean");
  assert.equal(batchOutcome([{ result: "ok" }, { result: "unknown" }]), "unchecked");
  assert.equal(batchOutcome([{ result: "unknown" }, { result: "bad" }, { result: "ok" }]), "bad");
  assert.equal(batchOutcome([{ result: "kept" }]), "clean"); // a code left readable on purpose
});
