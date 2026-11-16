// Cleaning several photos in one go: file names, the outcome of each photo and the zip they
// go into. Kept apart from the page, like js/plan.js, so it can be tested.

// The most one zip holds, in bytes of clean photos. The zip is made in memory, and on a phone
// a few hundred MB is already a lot; photos that don't fit wait for the next zip.
export const ZIP_LIMIT = 500 * 1000 * 1000;

const EXT = { jpeg: "jpg", png: "png", webp: "webp" };

// A name that is safe in a zip and on any disk: no folders, no control or reserved characters.
function safe(name) {
  const s = String(name).replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "");
  return s.slice(0, 120) || "photo";
}

// The saved file's name. Without "keep the original name" it says nothing about the original.
export function cleanName(original, outFormat, keep) {
  const base = keep ? safe(String(original).replace(/\.[^.]+$/, "")) : "photo";
  return `${base}-unpinned.${EXT[outFormat] || outFormat}`;
}

// Names for the files in one zip, in the order the photos were opened. Without "keep", each
// photo gets its place in the batch (photo-01, photo-02…); with it, its own name. Either way
// no two are the same, whatever the case of the letters (Windows and macOS ignore it).
// items: [{ original, outFormat, at }], `at` is the photo's place in the batch from 1, `of` the batch size.
export function batchNames(items, keep, of = items.length) {
  const width = String(of).length;
  const taken = new Set();
  return items.map(({ original, outFormat, at }) => {
    const ext = EXT[outFormat] || outFormat;
    const base = keep ? safe(String(original).replace(/\.[^.]+$/, "")) : `photo-${String(at).padStart(width, "0")}`;
    let name = `${base}-unpinned.${ext}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base}-unpinned-${n}.${ext}`;
    taken.add(name.toLowerCase());
    return name;
  });
}

// What became of one photo, from the checks of its saved file (as verify() in js/app.js gives them).
// "clean": every check passed. "unchecked": saved, but some parts couldn't be checked.
// "bad": something is still in the file, so it stays out of the zip.
export function batchOutcome(checks) {
  if (checks.some((c) => c.result === "bad")) return "bad";
  if (checks.some((c) => c.result === "unknown")) return "unchecked";
  return "clean";
}

// ---------- zip ----------
// A plain zip with every file stored as it is: photos are compressed already, so packing them
// again would only cost time. Enough for any unzip tool; no zip64, which the limit above never needs.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Every file in the zip has the same date, 1 January 1980 (the earliest a zip can say):
// the zip tells nothing about when the photos were taken or cleaned.
const DOS_TIME = 0, DOS_DATE = (0 << 9) | (1 << 5) | 1;

// entries: [{ name, data, size, crc }]. `data` is a Uint8Array or anything a Blob takes
// (a Blob, so a big photo isn't copied again); `size` and `crc` are of `data`.
// Returns the zip as a list of parts, in order: new Blob(parts) is the file.
export function zipParts(entries) {
  if (entries.length > 0xffff) throw new Error("Too many files for one zip");
  const enc = new TextEncoder();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    if (e.size > 0xffffffff || offset > 0xffffffff) throw new Error("The zip is too large");
    const local = new Uint8Array(30 + name.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 10, true); // version needed: 1.0, stored
    l.setUint16(6, 0x0800, true); // names are UTF-8
    l.setUint16(8, 0, true); // stored, not compressed
    l.setUint16(10, DOS_TIME, true);
    l.setUint16(12, DOS_DATE, true);
    l.setUint32(14, e.crc, true);
    l.setUint32(18, e.size, true);
    l.setUint32(22, e.size, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const c = new DataView(cd.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true); // made by: 2.0
    c.setUint16(6, 10, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, DOS_TIME, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.size, true);
    c.setUint32(24, e.size, true);
    c.setUint16(28, name.length, true);
    // extra, comment, disk, internal and external attributes: all 0
    c.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);

    parts.push(local, e.data);
    offset += local.length + e.size;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  if (offset + cdSize > 0xffffffff) throw new Error("The zip is too large");
  const end = new Uint8Array(22);
  const d = new DataView(end.buffer);
  d.setUint32(0, 0x06054b50, true);
  d.setUint16(8, entries.length, true);
  d.setUint16(10, entries.length, true);
  d.setUint32(12, cdSize, true);
  d.setUint32(16, offset, true);
  parts.push(...central, end);
  return parts;
}
