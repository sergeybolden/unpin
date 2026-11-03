// Remove personal metadata without re-encoding the image.
// JPEG, PNG and WebP are rebuilt block by block; pixels are never touched.
// Kept: the color profile (ICC) and, for JPEG, the rotation flag.
// Removed: everything else, including Content Credentials (C2PA). C2PA is signed over the
// whole file, so it can't stay valid once other blocks are removed, and it can carry a
// location or a preview. If C2PA or XMP said "made with AI", that label is written back.

const te = new TextEncoder();
const td = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

export class BrokenFileError extends Error {}

function startsWith(bytes, offset, text) {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const note = (list, label) => { if (!list.includes(label)) list.push(label); };

export function detectFormat(bytes) {
  if (bytes.length < 12) return "other";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (startsWith(bytes, 0, "\x89PNG\r\n\x1a\n")) return "png";
  if (startsWith(bytes, 0, "RIFF") && startsWith(bytes, 8, "WEBP")) return "webp";
  if (startsWith(bytes, 4, "ftyp")) {
    const brand = td.decode(bytes.subarray(8, 12));
    if (/^(heic|heix|hevc|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return "heic";
    if (/^(avif|avis)$/.test(brand)) return "avif";
  }
  return "other";
}

// ---------- AI labels ----------
const AI_XMP = /(?:Iptc4xmpExt:)?DigitalSourceType\s*(?:=\s*"|>)\s*(https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/[A-Za-z]+)/;
const AI_ANY = /https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia|compositeSynthetic)/;

export function aiSourceType(text) {
  const m = AI_XMP.exec(text);
  return m && /algorithmicMedia|AlgorithmicMedia|compositeSynthetic/.test(m[1]) ? m[1] : null;
}

// C2PA stores the same IPTC term as plain text inside its (CBOR) actions assertion.
function aiFromC2pa(bytes) {
  const m = AI_ANY.exec(td.decode(bytes));
  return m ? m[0] : null;
}

function minimalXmp(sourceType) {
  return (
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" ' +
    `Iptc4xmpExt:DigitalSourceType="${sourceType}"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`
  );
}

function jpegXmpApp1(sourceType) {
  const body = concat([te.encode("http://ns.adobe.com/xap/1.0/\0"), te.encode(minimalXmp(sourceType))]);
  const len = body.length + 2;
  return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), body]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(te.encode(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(concat([te.encode(type), data])));
  return concat([head, data, crc]);
}

const pngXmpChunk = (label) => pngChunk("iTXt", concat([te.encode("XML:com.adobe.xmp\0\0\0\0\0"), te.encode(minimalXmp(label))]));

// ---------- JPEG ----------
// A minimal EXIF block that only says how to rotate the image.
function orientationApp1(orientation) {
  const tiff = new Uint8Array([
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, IFD at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation SHORT
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ]);
  const body = concat([te.encode("Exif\0\0"), tiff]);
  const len = body.length + 2;
  return concat([new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), body]);
}

// JFIF header without its optional preview picture.
function jfixNoThumb(seg) {
  const head = seg.subarray(4, 4 + 12); // "JFIF\0", version, units, densities
  return concat([new Uint8Array([0xff, 0xe0, 0x00, 0x10]), head, new Uint8Array([0, 0])]);
}

export function stripJpeg(bytes, { orientation = 1 } = {}) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new BrokenFileError("Not a JPEG file");
  const out = [bytes.subarray(0, 2)];
  const removed = [];
  let i = 2;
  let wroteOrientation = orientation === 1;
  let aiLabel = null;
  let c2pa = false;
  let orientIdx = -1;
  let sawScan = false;
  let sawEnd = false;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff || i + 1 >= bytes.length) throw new BrokenFileError("The JPEG is damaged");
    const m = bytes[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd9) { out.push(bytes.subarray(i, i + 2)); i += 2; sawEnd = true; break; } // EOI
    if (m >= 0xd0 && m <= 0xd7) { out.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > bytes.length) throw new BrokenFileError("The JPEG is cut short");
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) throw new BrokenFileError("The JPEG is cut short");
    const seg = bytes.subarray(i, i + 2 + len);
    const p = i + 4;
    let keep = true;
    let label = null;
    if (m === 0xe1) {
      keep = false;
      label = startsWith(bytes, p, "Exif") ? "EXIF" : "XMP";
      if (label === "XMP") aiLabel = aiLabel || aiSourceType(utf8.decode(seg));
    } else if (m === 0xe2) {
      if (!startsWith(bytes, p, "ICC_PROFILE")) { keep = false; label = startsWith(bytes, p, "MPF") ? "Extra images (MPF)" : "APP2"; }
    } else if (m === 0xe0) {
      if (startsWith(bytes, p, "JFXX")) { keep = false; label = "Preview image (JFIF)"; }
      else if (startsWith(bytes, p, "JFIF\0") && len >= 16) {
        if (bytes[p + 12] * bytes[p + 13] > 0 || len > 16) note(removed, "Preview image (JFIF)");
        out.push(jfixNoThumb(seg));
        i += 2 + len;
        continue;
      }
    } else if (m === 0xeb) {
      keep = false;
      label = "Content Credentials (C2PA)";
      c2pa = true;
      aiLabel = aiLabel || aiFromC2pa(seg);
    } else if (m === 0xed) { keep = false; label = "IPTC / Photoshop"; }
    else if (m === 0xfe) { keep = false; label = "Comment"; }
    else if ((m >= 0xe3 && m <= 0xea) || m === 0xec || m === 0xef) { keep = false; label = `APP${m - 0xe0}`; }
    // Kept: APP0 JFIF (without preview), APP2 ICC, APP14 Adobe (needed to decode colors), image data.
    if (keep) {
      if (!wroteOrientation && m !== 0xe0) { orientIdx = out.length; out.push(orientationApp1(orientation)); wroteOrientation = true; }
      out.push(seg);
    } else if (label) note(removed, label);
    i += 2 + len;
    if (m === 0xda) {
      sawScan = true;
      // Entropy-coded data: copy until the next real marker.
      let j = i;
      while (j < bytes.length) {
        if (bytes[j] === 0xff) {
          const n = bytes[j + 1];
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        j++;
      }
      if (j >= bytes.length) throw new BrokenFileError("The JPEG is cut short");
      out.push(bytes.subarray(i, j));
      i = j;
    }
  }
  if (!sawScan || !sawEnd) throw new BrokenFileError("The JPEG is cut short");
  if (i < bytes.length) note(removed, "Data after the image (extra photos, depth, HDR map)");
  if (aiLabel) {
    const at = orientIdx >= 0 ? orientIdx + 1 : out.length > 1 && out[1][1] === 0xe0 ? 2 : 1;
    out.splice(at, 0, jpegXmpApp1(aiLabel));
  }
  return { bytes: concat(out), removed, keptAiLabel: aiLabel, c2pa, animated: false };
}

// ---------- PNG ----------
const PNG_DROP = { tEXt: "Text", zTXt: "Text", iTXt: "Text", eXIf: "EXIF", tIME: "Time", caBX: "Content Credentials (C2PA)" };

export function stripPng(bytes) {
  if (!startsWith(bytes, 0, "\x89PNG\r\n\x1a\n")) throw new BrokenFileError("Not a PNG file");
  const out = [bytes.subarray(0, 8)];
  const removed = [];
  let aiLabel = null;
  let c2pa = false;
  let animated = false;
  let sawEnd = false;
  let i = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  while (i < bytes.length) {
    if (i + 12 > bytes.length) throw new BrokenFileError("The PNG is cut short");
    const len = dv.getUint32(i);
    const type = td.decode(bytes.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > bytes.length) throw new BrokenFileError("The PNG is cut short");
    if (type === "acTL") animated = true;
    if (PNG_DROP[type]) {
      note(removed, PNG_DROP[type]);
      const data = bytes.subarray(i + 8, end - 4);
      if (type === "iTXt") aiLabel = aiLabel || aiSourceType(utf8.decode(data));
      if (type === "caBX") { c2pa = true; aiLabel = aiLabel || aiFromC2pa(data); }
    } else {
      if (type === "IEND" && aiLabel) out.push(pngXmpChunk(aiLabel));
      out.push(bytes.subarray(i, end)); // image data, color, transparency, animation
    }
    i = end;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd) throw new BrokenFileError("The PNG is cut short");
  return { bytes: concat(out), removed, keptAiLabel: aiLabel, c2pa, animated };
}

// ---------- WebP ----------
export function stripWebp(bytes) {
  if (!startsWith(bytes, 0, "RIFF") || !startsWith(bytes, 8, "WEBP")) throw new BrokenFileError("Not a WebP file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = 8 + dv.getUint32(4, true);
  if (riffEnd > bytes.length) throw new BrokenFileError("The WebP is cut short");
  const removed = [];
  const chunks = [];
  let aiLabel = null;
  let c2pa = false;
  let animated = false;
  let sawImage = false;
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = td.decode(bytes.subarray(i, i + 4));
    const size = dv.getUint32(i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > riffEnd) throw new BrokenFileError("The WebP is cut short");
    if (/^VP8[ L]$|^ANMF$/.test(type)) sawImage = true;
    if (type === "VP8X" && bytes[i + 8] & 0x02) animated = true;
    if (type === "EXIF" || type === "XMP " || type === "C2PA") {
      note(removed, type === "EXIF" ? "EXIF" : type === "XMP " ? "XMP" : "Content Credentials (C2PA)");
      const data = bytes.subarray(i + 8, i + 8 + size);
      if (type === "XMP ") aiLabel = aiLabel || aiSourceType(utf8.decode(data));
      if (type === "C2PA") { c2pa = true; aiLabel = aiLabel || aiFromC2pa(data); }
    } else {
      chunks.push(bytes.slice(i, Math.min(end, riffEnd)));
    }
    i = end;
  }
  if (!sawImage) throw new BrokenFileError("The WebP has no image data");
  const hasVp8x = chunks.some((c) => td.decode(c.subarray(0, 4)) === "VP8X");
  for (const c of chunks) {
    if (td.decode(c.subarray(0, 4)) === "VP8X") {
      c[8] &= ~(0x08 | 0x04); // clear EXIF and XMP flags
      if (aiLabel) c[8] |= 0x04;
    }
  }
  if (aiLabel && hasVp8x) {
    const x = te.encode(minimalXmp(aiLabel));
    const head = new Uint8Array(8);
    head.set(te.encode("XMP "), 0);
    new DataView(head.buffer).setUint32(4, x.length, true);
    chunks.push(concat([head, x, x.length & 1 ? new Uint8Array(1) : new Uint8Array(0)]));
  }
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(te.encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(te.encode("WEBP"), 8);
  return { bytes: concat([header, body]), removed, keptAiLabel: aiLabel && hasVp8x ? aiLabel : null, c2pa, animated };
}

// After a pixel edit the browser saves a file with no metadata at all.
// If the original carried an AI label, write it back.
export function withAiLabel(bytes, format, label) {
  if (!label) return bytes;
  if (format === "jpeg") return concat([bytes.subarray(0, 2), jpegXmpApp1(label), bytes.subarray(2)]);
  if (format === "png") return concat([bytes.subarray(0, bytes.length - 12), pngXmpChunk(label), bytes.subarray(bytes.length - 12)]);
  return bytes;
}

// JPEG, PNG and WebP are cleaned in place. Anything else is re-drawn and saved by the browser.
export function stripLossless(bytes, format, opts) {
  if (format === "jpeg") return stripJpeg(bytes, opts);
  if (format === "png") return stripPng(bytes);
  if (format === "webp") return stripWebp(bytes);
  return null;
}

// For formats we don't rebuild (HEIC, AVIF): is there C2PA, and does it say "made with AI"?
export function scanC2pa(bytes) {
  const n = Math.min(bytes.length, 8 * 1024 * 1024);
  const text = td.decode(bytes.subarray(0, n));
  const present = /jumd[\s\S]{0,40}c2pa|c2pa\.(claim|signature|assertions)/.test(text);
  return { present, ai: present ? aiFromC2pa(bytes.subarray(0, n)) : null };
}
