// Remove personal metadata without re-encoding the image.
// JPEG, PNG and WebP are rebuilt block by block; pixels are never touched.
// Only blocks needed to show the picture are kept (a fixed list per format): image data, color
// (including the ICC profile), transparency, animation and, for JPEG, the rotation flag.
// Removed: everything else, known or not, including Content Credentials (C2PA) and the "made with
// AI" label. C2PA is signed over the whole file, so it can't stay valid once other blocks are
// removed, and it can carry a location or a preview.

import { MAX_BLOCKS } from "./inspect.js";

const te = new TextEncoder();
const td = new TextDecoder("latin1");

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
const AFTER_IMAGE = "Data after the image (extra photos, depth, HDR map)";

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

// C2PA stores the IPTC "made with AI" term as plain text inside its (CBOR) actions assertion.
const AI_ANY = /https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia|algorithmicMedia|compositeSynthetic)/;
function aiFromC2pa(bytes) {
  const m = AI_ANY.exec(td.decode(bytes));
  return m ? m[0] : null;
}

// ---------- Color profile (ICC) ----------
// A profile says how to show the colors, but it can carry more: its name ("Calibrated by Alice"),
// the monitor's make and model, a calibration date, free text. The clean profile keeps only the
// tags that describe colors, a standard name ("Display P3") or a neutral one, and a header
// without the device, the creator, the date and the checksum.
// Each kept tag must have its expected type, and only as many bytes as that type needs are
// copied, so no text can ride along after the numbers. Tags may share one range of bytes (the
// three tone curves often do) but may not overlap otherwise. A profile Unpin can't check this
// way (lookup tables, CMYK) makes it save the picture again instead.
const u16 = (p, o) => (p[o] << 8) | p[o + 1];
const u32 = (p, o) => ((p[o] << 24) | (p[o + 1] << 16) | (p[o + 2] << 8) | p[o + 3]) >>> 0;
const PARA = [1, 3, 4, 5, 7]; // parameters of each parametric curve kind
const XYZ = { "XYZ ": () => 20 };
const CURVE = { curv: (p, o) => 12 + 2 * u32(p, o + 8), para: (p, o) => (PARA[u16(p, o + 8)] ? 12 + 4 * PARA[u16(p, o + 8)] : -1) };
// Only the tags a viewer uses to show this kind of profile: an RGB profile's three colorants and
// curves, a gray profile's one curve, and for both the white point, its adaptation and the
// video color code. Anything else, even a well-formed tag (a gray curve in an RGB profile, the
// black point, chromaticities, luminance), is dropped.
const ICC_COMMON = { wtpt: XYZ, chad: { sf32: () => 44 }, cicp: { cicp: () => 12 } };
const ICC_TAGS = {
  "RGB ": { ...ICC_COMMON, rXYZ: XYZ, gXYZ: XYZ, bXYZ: XYZ, rTRC: CURVE, gTRC: CURVE, bTRC: CURVE },
  GRAY: { ...ICC_COMMON, kTRC: CURVE },
};
const ICC_NEEDS = { "RGB ": ["rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC"], GRAY: ["kTRC"] };
const ICC_LUT = /^(A2B|B2A|D2B|B2D)\d$/;
const ICC_NAMES = new Set(["sRGB IEC61966-2.1", "sRGB", "sRGB built-in", "Display P3", "DCI-P3", "Adobe RGB (1998)", "ProPhoto RGB", "Linear sRGB",
  "Generic RGB Profile", "Generic Gray Gamma 2.2 Profile", "Generic Gray Profile", "sGray", "Dot Gain 20%", "Rec. ITU-R BT.709-5", "Rec. ITU-R BT.2020-1"]);
const ICC_NEUTRAL = "Color profile";
const ICC_MAX = 4 << 20;

// The text of a v2 "desc" or a v4 "mluc" tag (its first language), or "".
function iccText(p, off, size) {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  if (size >= 12 && startsWith(p, off, "desc")) {
    const n = dv.getUint32(off + 8);
    return n > 0 && 12 + n <= size ? td.decode(p.subarray(off + 12, off + 12 + n - 1)) : "";
  }
  if (size >= 28 && startsWith(p, off, "mluc") && dv.getUint32(off + 8) > 0) {
    const len = dv.getUint32(off + 20), at = dv.getUint32(off + 24);
    if (at + len > size) return "";
    let s = "";
    for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(off + at + k));
    return s;
  }
  return "";
}

function iccDescTag(text, v4) {
  if (v4) {
    const body = new Uint8Array(28 + text.length * 2);
    const dv = new DataView(body.buffer);
    body.set(te.encode("mluc"), 0);
    dv.setUint32(8, 1);
    dv.setUint32(12, 12);
    body.set(te.encode("enUS"), 16);
    dv.setUint32(20, text.length * 2);
    dv.setUint32(24, 28);
    for (let k = 0; k < text.length; k++) dv.setUint16(28 + k * 2, text.charCodeAt(k));
    return body;
  }
  const body = new Uint8Array(12 + text.length + 1 + 8 + 3 + 67);
  body.set(te.encode("desc"), 0);
  new DataView(body.buffer).setUint32(8, text.length + 1);
  body.set(te.encode(text), 12);
  return body;
}

export function cleanIcc(p) {
  const bad = () => new BrokenFileError("The color profile is damaged");
  if (p.length < 132 || p.length > ICC_MAX || !startsWith(p, 36, "acsp")) throw bad();
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const size = dv.getUint32(0);
  const count = dv.getUint32(128);
  if (size > p.length || size < 132 + count * 12 || count > 1000) throw bad();
  const unsure = () => new BrokenFileError("Unpin can't check this color profile");
  const space = td.decode(p.subarray(16, 20));
  if (!ICC_NEEDS[space]) throw unsure();
  const v4 = p[8] >= 4;
  let name = ICC_NEUTRAL;
  const kept = [];
  const sigs = new Set();
  for (let k = 0; k < count; k++) {
    const e = 132 + k * 12;
    const sig = td.decode(p.subarray(e, e + 4));
    const off = dv.getUint32(e + 4), len = dv.getUint32(e + 8);
    if (off + len > size || off < 132 || sigs.has(sig)) throw bad();
    sigs.add(sig);
    if (ICC_LUT.test(sig)) throw unsure();
    if (sig === "desc") { const t = iccText(p, off, len); if (ICC_NAMES.has(t)) name = t; continue; }
    if (!ICC_TAGS[space][sig]) continue; // not used to show this profile's colors: dropped
    const rule = ICC_TAGS[space][sig][td.decode(p.subarray(off, off + 4))];
    const need = rule && len >= 12 ? rule(p, off) : -1;
    if (need < 12 || need > len) throw bad();
    kept.push({ sig, off, len: need });
  }
  if (ICC_NEEDS[space].some((s) => !sigs.has(s))) throw unsure();
  // Tags that share their data still share it; any other overlap is refused.
  const shared = new Map();
  for (const t of kept) {
    const key = `${t.off}:${t.len}`;
    if (!shared.has(key)) shared.set(key, { off: t.off, data: p.subarray(t.off, t.off + t.len) });
    t.ref = shared.get(key);
  }
  const ranges = [...shared.values()].sort((a, b) => a.off - b.off);
  for (let k = 1; k < ranges.length; k++) if (ranges[k - 1].off + ranges[k - 1].data.length > ranges[k].off) throw bad();
  const tags = [{ sig: "desc", ref: { data: iccDescTag(name, v4) } }, ...kept];
  const blocks = [tags[0].ref, ...ranges];
  let at = 132 + tags.length * 12;
  for (const b of blocks) { b.at = at; at += (b.data.length + 3) & ~3; }
  if (at > ICC_MAX) throw bad();
  const out = new Uint8Array(at);
  const o = new DataView(out.buffer);
  out.set(p.subarray(0, 128), 0);
  out.fill(0, 4, 8); // the program that reads it
  out.fill(0, 10, 12); // version bytes that carry nothing
  out.fill(0, 24, 36); // date and time
  out.fill(0, 40, 64); // platform, flags, device maker, model and attributes
  out.fill(0, 80, 128); // creator, profile checksum, reserved bytes
  o.setUint32(0, at);
  o.setUint32(128, tags.length);
  tags.forEach((t, k) => {
    out.set(te.encode(t.sig), 132 + k * 12);
    o.setUint32(136 + k * 12, t.ref.at);
    o.setUint32(140 + k * 12, t.ref.data.length);
  });
  for (const b of blocks) {
    out.set(b.data, b.at);
    out.fill(0, b.at + 4, b.at + 8); // each tag's reserved bytes
  }
  return out;
}

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

const OWN_ORIENTATION = [2, 3, 4, 5, 6, 7, 8].map(orientationApp1);
// Markers that carry the picture itself: frame headers and Huffman/arithmetic tables (C0–CF,
// except the reserved C8), the scan, quantization tables, restart interval and line count.
// Not the hierarchical blocks (DHP, EXP): browsers can't show a hierarchical picture, and those
// blocks' bytes were copied unread, so they could carry anything.
const JPEG_IMAGE = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xda, 0xdb, 0xdc, 0xdd]);

function same(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// JFIF header without its optional preview picture.
function jfixNoThumb(seg) {
  const head = seg.subarray(4, 4 + 12); // "JFIF\0", version, units, densities
  return concat([new Uint8Array([0xff, 0xe0, 0x00, 0x10]), head, new Uint8Array([0, 0])]);
}

// Quantization (DQT), Huffman (DHT) and arithmetic conditioning (DAC) tables. A table is kept
// only if a scan reads it before it is defined again: a table no scan reads (a number nothing
// refers to, one defined after the last scan or after its component started, or the other coding
// kind's tables) could carry text in its values. Progressive pictures define tables between
// scans for the scans that follow; those are read, so they stay.
const JPEG_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const JPEG_HUFFMAN = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7]); // the others code arithmetically
const JPEG_PROGRESSIVE = new Set([0xc2, 0xc6, 0xca, 0xce]);
const JPEG_LOSSLESS = new Set([0xc3, 0xc7, 0xcb, 0xcf]); // no quantization, no AC tables
// A real picture defines a few dozen tables at most (a progressive one: one or two per scan).
const MAX_TABLES = 256;
function jpegTables(m, seg, budget) {
  const bad = () => new BrokenFileError("The JPEG has a damaged table");
  const tables = [];
  // The restart interval (DRI) is one value, kept like a table: only the one a scan starts with.
  if (m === 0xdd) {
    if (seg.length !== 6 || --budget.left < 0) throw bad();
    return { marker: m, tables: [{ key: "r", bytes: seg.subarray(4, 6), used: false }] };
  }
  for (let o = 4; o < seg.length; ) {
    if (--budget.left < 0) throw new BrokenFileError("The JPEG has too many tables");
    let size;
    if (seg[o] >> 4 > 1) throw bad();
    if (m === 0xdb) size = 1 + (seg[o] >> 4 ? 128 : 64);
    else if (m === 0xcc) size = 2; // arithmetic conditioning: class and number, then one value
    else {
      if (o + 17 > seg.length) throw bad();
      size = 17;
      for (let k = 1; k <= 16; k++) size += seg[o + k];
    }
    if ((seg[o] & 15) > 3 || o + size > seg.length) throw bad();
    // q: quantization; d, a: Huffman DC, AC; cd, ca: arithmetic DC, AC conditioning.
    const cls = seg[o] >> 4 ? "a" : "d";
    const key = m === 0xdb ? `q${seg[o] & 15}` : `${m === 0xcc ? "c" : ""}${cls}${seg[o] & 15}`;
    tables.push({ key, bytes: seg.subarray(o, o + size), used: false });
    o += size;
  }
  return { marker: m, tables };
}
function jpegTableSegment(t) {
  const used = t.tables.filter((x) => x.used);
  if (!used.length) return new Uint8Array(0);
  const body = concat(used.map((x) => x.bytes));
  const len = body.length + 2;
  return concat([new Uint8Array([0xff, t.marker, len >> 8, len & 0xff]), body]);
}

export function stripJpeg(bytes, { orientation = 1 } = {}) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new BrokenFileError("Not a JPEG file");
  // Only 2–8 turn or mirror the picture; any other value is written as no flag at all.
  if (!Number.isInteger(orientation) || orientation < 2 || orientation > 8) orientation = 1;
  const out = [bytes.subarray(0, 2)];
  const removed = [];
  const damaged = () => new BrokenFileError("The JPEG is damaged");
  const tables = []; // table blocks, rebuilt at the end with the tables a scan read
  const current = {}; // the table now in force under each number
  const quantOf = {}; // each color component's quantization table number, from the frame header
  const quantFixed = {}; // each component's quantization table, taken at its first scan
  let afterScan = []; // blocks after the latest scan: unused if no scan follows
  const tableBudget = { left: MAX_TABLES };
  let frame = null, frameHeight = -1, scans = 0;
  let scanData = false; // the block just before was a scan's data
  let i = 2;
  let wroteOrientation = orientation === 1;
  let c2pa = false;
  let sawScan = false;
  let sawEnd = false;
  let sawJfif = false;
  // The color profile can be split over several APP2 blocks: they are joined, cleaned and put
  // back where the first one was.
  const icc = [];
  let iccAt = -1;
  for (let n = 0; i < bytes.length; n++) {
    if (n > MAX_BLOCKS) throw new BrokenFileError("The JPEG has too many blocks");
    if (bytes[i] !== 0xff || i + 1 >= bytes.length) throw new BrokenFileError("The JPEG is damaged");
    const m = bytes[i + 1];
    if (m === 0xff) { i++; continue; } // fill byte
    if (m === 0xd9) { out.push(bytes.subarray(i, i + 2)); i += 2; sawEnd = true; break; } // EOI
    if (m >= 0xd0 && m <= 0xd7) { out.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    if (i + 4 > bytes.length) throw new BrokenFileError("The JPEG is cut short");
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) throw new BrokenFileError("The JPEG is cut short");
    let seg = bytes.subarray(i, i + 2 + len);
    const afterData = scanData;
    scanData = false;
    const p = i + 4;
    let keep = true;
    let label = null;
    if (m === 0xe1) {
      keep = false;
      label = startsWith(bytes, p, "Exif") ? "EXIF" : "XMP";
      if (OWN_ORIENTATION.some((o) => same(seg, o))) label = null; // Unpin's own rotation flag
    } else if (m === 0xe2) {
      if (startsWith(bytes, p, "ICC_PROFILE\0") && len >= 16) {
        icc.push({ seq: bytes[p + 12], data: seg.subarray(18) });
        if (icc.length === 1) {
          if (!wroteOrientation) { out.push(orientationApp1(orientation)); wroteOrientation = true; }
          iccAt = out.length;
          out.push(null); // filled in after the loop
        }
        i += 2 + len;
        continue;
      }
      keep = false;
      label = startsWith(bytes, p, "MPF") ? "Extra images (MPF)" : "APP2";
    } else if (m === 0xe0) {
      if (startsWith(bytes, p, "JFXX")) { keep = false; label = "Preview image (JFIF)"; }
      else if (startsWith(bytes, p, "JFIF\0") && len >= 16) {
        // One JFIF header, before the picture: viewers read no other, so a second one (seven free
        // bytes each) could carry text.
        if (sawJfif || frame != null) { note(removed, "Other data blocks"); i += 2 + len; continue; }
        sawJfif = true;
        if (bytes[p + 12] * bytes[p + 13] > 0 || len > 16) note(removed, "Preview image (JFIF)");
        out.push(jfixNoThumb(seg));
        i += 2 + len;
        continue;
      } else { keep = false; label = "APP0"; }
    } else if (m === 0xee) {
      // Adobe's block says how the colors are coded: "Adobe", version, two flag words and the
      // transform, 12 bytes. It is written anew from those fields, so nothing after them survives.
      if (startsWith(bytes, p, "Adobe") && len >= 14) {
        if (len > 14) note(removed, "Other data blocks");
        seg = concat([new Uint8Array([0xff, 0xee, 0x00, 0x0e]), bytes.subarray(p, p + 12)]);
      } else { keep = false; label = "APP14"; }
    } else if (m === 0xeb) {
      keep = false;
      label = "Content Credentials (C2PA)";
      c2pa = true;
    } else if (m === 0xed) { keep = false; label = "IPTC / Photoshop"; }
    else if (m === 0xfe) { keep = false; label = "Comment"; }
    else if ((m >= 0xe3 && m <= 0xea) || m === 0xec || m === 0xef) { keep = false; label = `APP${m - 0xe0}`; }
    else if (!JPEG_IMAGE.has(m)) { keep = false; label = "Other data blocks"; }
    // Kept: APP0 JFIF (without preview), APP2 ICC, APP14 Adobe (needed to decode colors), image data.
    if (keep) {
      if (!wroteOrientation && m !== 0xe0) { out.push(orientationApp1(orientation)); wroteOrientation = true; }
      if (m === 0xdb || m === 0xc4 || m === 0xcc || m === 0xdd) {
        const t = jpegTables(m, seg, tableBudget);
        for (const x of t.tables) current[x.key] = x;
        tables.push(t);
        out.push(t); // replaced by the rebuilt block after the loop
      } else {
        // Frame header, scan header and line count have exact sizes; viewers refuse others.
        if (JPEG_FRAME.has(m)) {
          if (len !== 8 + 3 * seg[9]) throw damaged();
          frame = m;
          frameHeight = (seg[5] << 8) | seg[6];
          for (let k = 0; k < seg[9]; k++) quantOf[seg[10 + 3 * k]] = seg[12 + 3 * k];
        } else if (m === 0xda) {
          const ns = seg[4];
          if (len !== 6 + 2 * ns || frame == null) throw damaged();
          scans++;
          // Which tables this scan reads. Quantization: a lossy picture's component takes the
          // table in force at its first scan and keeps it (as libjpeg does); a table defined again
          // later is read only by a component that first appears after that.
          // Huffman, in a Huffman-coded picture: a sequential scan reads both; a progressive one
          // reads its DC table only in a first DC pass (Ss 0, Ah 0), its AC table only in an AC
          // pass (Ss > 0); a lossless picture reads DC tables only.
          // Arithmetic conditioning (DAC), in an arithmetic-coded picture: DC in a sequential,
          // lossless or first DC pass, AC in a sequential or first AC pass (Ss > 0, Ah 0).
          // Neither kind reads the other's tables.
          const ss = seg[5 + 2 * ns], ah = seg[7 + 2 * ns] >> 4;
          const huffman = JPEG_HUFFMAN.has(frame), lossless = JPEG_LOSSLESS.has(frame), progressive = JPEG_PROGRESSIVE.has(frame);
          const dc = lossless || !progressive || (ss === 0 && ah === 0);
          const ac = !lossless && (!progressive || (ss > 0 && (huffman || ah === 0)));
          const kind = huffman ? "" : "c";
          for (let k = 0; k < ns; k++) {
            const comp = seg[5 + 2 * k], sel = seg[6 + 2 * k];
            if (!lossless && !(comp in quantFixed)) quantFixed[comp] = current[`q${quantOf[comp]}`];
            const keys = [dc && `${kind}d${sel >> 4}`, ac && `${kind}a${sel & 15}`];
            for (const key of keys) if (key && current[key]) current[key].used = true;
            if (quantFixed[comp]) quantFixed[comp].used = true;
          }
          if (current.r) current.r.used = true; // the restart interval in force as the scan starts
          afterScan = [];
        } else if (m === 0xdc) {
          if (len !== 4) throw damaged();
          // The line count only counts right after the first scan of a picture whose header left
          // the height at 0; anywhere else nothing reads it.
          if (!(frameHeight === 0 && scans === 1 && afterData)) {
            note(removed, "Other data blocks");
            i += 2 + len;
            continue;
          }
        }
        if (sawScan && m !== 0xda && m !== 0xdc) afterScan.push(out.length); // DNL belongs to the scan before it
        out.push(seg);
      }
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
      scanData = true;
      i = j;
    }
  }
  if (!sawScan || !sawEnd) throw new BrokenFileError("The JPEG is cut short");
  if (i < bytes.length) note(removed, AFTER_IMAGE);
  if (icc.length) {
    const profile = concat(icc.sort((a, b) => a.seq - b.seq).map((c) => c.data));
    const clean = cleanIcc(profile);
    if (!same(clean, profile)) note(removed, "Color profile details");
    out[iccAt] = jpegIccSegments(clean);
  }
  // Blocks after the last scan are read by nothing.
  for (const at of afterScan) { out[at] = new Uint8Array(0); note(removed, "Other data blocks"); }
  for (const t of tables) if (t.tables.some((x) => !x.used)) note(removed, "Other data blocks");
  for (let k = 0; k < out.length; k++) if (out[k]?.tables) out[k] = jpegTableSegment(out[k]);
  return { bytes: concat(out), removed, c2pa, animated: false };
}

// APP2 blocks of at most 65,519 bytes of profile each, numbered 1…n.
function jpegIccSegments(profile) {
  const size = 65519;
  const count = Math.ceil(profile.length / size);
  if (count > 255) throw new BrokenFileError("The color profile is too large");
  const parts = [];
  for (let k = 0; k < count; k++) {
    const data = profile.subarray(k * size, (k + 1) * size);
    const len = data.length + 16;
    parts.push(new Uint8Array([0xff, 0xe2, len >> 8, len & 0xff]), te.encode("ICC_PROFILE\0"), new Uint8Array([k + 1, count]), data);
  }
  return concat(parts);
}

// ---------- PNG ----------
// Chunks that make up the picture: image data, palette, transparency, color, pixel size,
// background, animation. Everything else is removed, including chunks no standard knows.
// Only what a viewer actually uses is kept: each setting once and before the image data, one
// unbroken run of image data, and animation frames only in an animation. A second copy, a
// setting after the image, a later run of image data or frames in a still picture would be
// skipped by every viewer, so they could carry a hidden picture or text: they are removed.
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCV", "cLLI", "pHYs", "bKGD", "acTL", "fcTL", "fdAT"]);
const PNG_NAMED = { tEXt: "Text", zTXt: "Text", iTXt: "Text", eXIf: "EXIF", tIME: "Time", caBX: "Content Credentials (C2PA)" };
const PNG_ICC_NAME = "ICC Profile";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function pngChunk(type, data) {
  const body = concat([te.encode(type), data]);
  let c = 0xffffffff;
  for (let i = 0; i < body.length; i++) c = CRC_TABLE[(c ^ body[i]) & 0xff] ^ (c >>> 8);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(body, 4);
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}
const PNG_IEND = pngChunk("IEND", new Uint8Array(0));

// zlib, as PNG stores the profile. Capped, so a small file can't unpack into gigabytes.
// Refused if anything follows the end of the packed data.
async function inflate(data, cap) {
  const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  const parts = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > cap) { reader.cancel().catch(() => {}); throw new BrokenFileError("The color profile is too large"); }
      parts.push(value);
    }
  } catch (e) {
    throw e instanceof BrokenFileError ? e : new BrokenFileError("The color profile is damaged");
  }
  // The stream must end at the chunk's last byte: bytes after its end are never read by a viewer
  // but would be copied with the chunk. Some unpackers ignore them, so, as for the image data
  // below, it is tested directly: the stream without its last byte must fail to unpack.
  let endsEarly = true;
  try { await unpackedSize(new Blob([data.subarray(0, data.length - 1)]), cap); } catch { endsEarly = false; }
  if (endsEarly) throw new BrokenFileError("The color profile is damaged");
  return concat(parts);
}
const deflate = async (data) =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());

// The image data is one zlib stream over all IDAT chunks. Bytes after the stream's end, or rows
// the picture doesn't have inside it, would never be shown but would be saved. So the stream is
// unpacked (and thrown away) to check both: it must hold exactly the bytes the header calls for,
// counting a filter byte per row and the seven passes of an interlaced picture, and it must end
// at its very last byte. Some browsers ignore bytes after the end, so that is tested directly:
// the stream without its last byte must fail to unpack.
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
function pngDataSize(width, height, bitDepth, colorType, interlace) {
  const bits = PNG_CHANNELS[colorType] * bitDepth;
  const rows = (w, h) => (w > 0 && h > 0 ? h * (Math.ceil((w * bits) / 8) + 1) : 0);
  if (!interlace) return rows(width, height);
  return ADAM7.reduce((n, [x, y, dx, dy]) => n + rows(Math.ceil((width - x) / dx), Math.ceil((height - y) / dy)), 0);
}
// Bytes unpacked, stopping as soon as there are more than `cap` (then -1). Throws on a broken stream.
async function unpackedSize(blob, cap) {
  const reader = blob.stream().pipeThrough(new DecompressionStream("deflate")).getReader();
  for (let n = 0; ; ) {
    const { done, value } = await reader.read();
    if (done) return n;
    n += value.length;
    if (n > cap) { reader.cancel().catch(() => {}); return -1; }
  }
}
async function checkPngData(parts, ihdr) {
  const dv = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
  const expected = pngDataSize(dv.getUint32(0), dv.getUint32(4), ihdr[8], ihdr[9], ihdr[12]);
  const wrong = () => new BrokenFileError("The PNG's image data doesn't match the picture");
  if (!Number.isFinite(expected) || expected <= 0) throw wrong();
  const blob = new Blob(parts);
  let size;
  try { size = await unpackedSize(blob, expected); } catch { throw wrong(); }
  if (size !== expected) throw wrong();
  let endsEarly = true;
  try { await unpackedSize(blob.slice(0, blob.size - 1), expected); } catch { endsEarly = false; }
  if (endsEarly) throw wrong();
}

// An iCCP chunk with a clean profile and a neutral name; the same chunk if there was nothing to clean.
async function pngIccChunk(chunk, removed) {
  const data = chunk.subarray(8, chunk.length - 4);
  const z = data.indexOf(0);
  if (z < 1 || z > 79 || data[z + 1] !== 0) throw new BrokenFileError("The color profile is damaged");
  const name = td.decode(data.subarray(0, z));
  const profile = await inflate(data.subarray(z + 2), ICC_MAX);
  const clean = cleanIcc(profile);
  const keepName = name === PNG_ICC_NAME || ICC_NAMES.has(name);
  if (keepName && same(clean, profile)) return chunk;
  note(removed, "Color profile details");
  return pngChunk("iCCP", concat([te.encode(`${keepName ? name : PNG_ICC_NAME}\0\0`), await deflate(clean)]));
}

// Settings have a size fixed by the standard (some by the kind of picture): a longer chunk
// could carry text after its numbers, so a chunk of the wrong size is removed, never copied.
const PNG_SIZE = { IHDR: 13, gAMA: 4, cHRM: 32, sRGB: 1, cICP: 4, mDCV: 24, cLLI: 8, pHYs: 9, acTL: 8, fcTL: 26 };
function pngSizeOk(type, len, colorType, paletteSize, bitDepth) {
  if (PNG_SIZE[type] != null) return len === PNG_SIZE[type];
  // A palette is read only by an indexed picture, and holds at most one color per index value.
  if (type === "PLTE") return colorType === 3 && len > 0 && len % 3 === 0 && len / 3 <= 1 << Math.min(8, bitDepth);
  if (type === "sBIT") return len === { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 }[colorType];
  if (type === "bKGD") return len === { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 }[colorType];
  if (type === "tRNS") return colorType === 0 ? len === 2 : colorType === 2 ? len === 6 : colorType === 3 && len > 0 && len <= paletteSize;
  return true; // image data, frames and the profile: checked on their own
}

export async function stripPng(bytes) {
  if (!startsWith(bytes, 0, "\x89PNG\r\n\x1a\n")) throw new BrokenFileError("Not a PNG file");
  if (!startsWith(bytes, 12, "IHDR") || bytes.length < 33) throw new BrokenFileError("The PNG has no header");
  const bitDepth = bytes[24], colorType = bytes[25];
  let paletteSize = 0;
  const out = [bytes.subarray(0, 8)];
  const removed = [];
  const seen = new Set();
  const imageData = []; // the IDAT run, checked as one stream at the end
  let c2pa = false;
  let animated = false;
  let sawEnd = false;
  let image = "before"; // the run of image data: before, in, after
  let i = 8;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let n = 0; i < bytes.length; n++) {
    if (n > MAX_BLOCKS) throw new BrokenFileError("The PNG has too many blocks");
    if (i + 12 > bytes.length) throw new BrokenFileError("The PNG is cut short");
    const len = dv.getUint32(i);
    const type = td.decode(bytes.subarray(i + 4, i + 8));
    const end = i + 12 + len;
    if (end > bytes.length) throw new BrokenFileError("The PNG is cut short");
    if (type === "IDAT" && image === "before") image = "in";
    else if (type !== "IDAT" && image === "in") image = "after";
    if (type === "acTL" && image === "before") animated = true;
    if (!PNG_KEEP.has(type)) {
      // A capital first letter marks a chunk the picture can't be shown without.
      if (!PNG_NAMED[type] && type.charCodeAt(0) < 0x61) throw new BrokenFileError("The PNG has an image block Unpin doesn't know");
      if (type === "caBX") c2pa = true;
      note(removed, PNG_NAMED[type] || "Other data blocks");
    } else {
      const frame = type === "fcTL" || type === "fdAT";
      const placed = type === "IEND" || (type === "IDAT" ? image === "in"
        : frame ? animated
        : image === "before" && !seen.has(type));
      const used = placed && pngSizeOk(type, len, colorType, paletteSize / 3, bitDepth);
      if (type === "PLTE" && used) paletteSize = len;
      if (!used) {
        // An indexed picture can't be shown without its palette; other pictures ignore one.
        if (type === "IHDR" || (type === "PLTE" && colorType === 3)) throw new BrokenFileError("The PNG's header or palette is damaged or out of place");
        note(removed, "Other data blocks");
      } else if (type === "IEND") {
        if (len) note(removed, "Other data blocks"); // the end marker is empty by definition
        out.push(PNG_IEND);
      } else {
        const chunk = bytes.subarray(i, end); // image data, color, transparency, animation
        if (type === "IDAT") imageData.push(bytes.subarray(i + 8, end - 4));
        out.push(type === "iCCP" ? await pngIccChunk(chunk, removed) : chunk);
      }
      seen.add(type);
    }
    i = end;
    if (type === "IEND") { sawEnd = true; break; }
  }
  if (!sawEnd || !imageData.length) throw new BrokenFileError("The PNG is cut short");
  // Never copied, but said: a cropped screenshot's original can sit here (aCropalypse).
  if (i < bytes.length) note(removed, AFTER_IMAGE);
  await checkPngData(imageData, bytes.subarray(16, 29));
  return { bytes: concat(out), removed, c2pa, animated };
}

// ---------- WebP ----------
// Chunks that make up the picture: header, image data, transparency, animation, color profile.
// A still picture keeps exactly what a viewer uses, in the order it reads it: the extended
// header first, then a color profile and transparency once each, then one picture. A second
// picture would never be shown but would be saved, so such a file is saved again instead;
// anything after the picture, or animation frames in a still picture, is removed.
const WEBP_KEEP = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF", "ICCP"]);
const WEBP_NAMED = { EXIF: "EXIF", "XMP ": "XMP", C2PA: "Content Credentials (C2PA)" };

export function stripWebp(bytes) {
  if (!startsWith(bytes, 0, "RIFF") || !startsWith(bytes, 8, "WEBP")) throw new BrokenFileError("Not a WebP file");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffEnd = 8 + dv.getUint32(4, true);
  if (riffEnd > bytes.length) throw new BrokenFileError("The WebP is cut short");
  const removed = [];
  const chunks = [];
  const seen = new Set();
  let c2pa = false;
  let animated = false;
  let extended = false;
  let sawImage = false;
  let i = 12;
  for (let n = 0; i + 8 <= riffEnd; n++) {
    if (n > MAX_BLOCKS) throw new BrokenFileError("The WebP has too many blocks");
    const type = td.decode(bytes.subarray(i, i + 4));
    const size = dv.getUint32(i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > riffEnd) throw new BrokenFileError("The WebP is cut short");
    if (type === "VP8X" && i === 12) {
      if (size !== 10) throw new BrokenFileError("The WebP header has the wrong size"); // viewers refuse it too
      extended = true;
      animated = !!(bytes[i + 8] & 0x02);
    }
    let used = WEBP_KEEP.has(type);
    if (used && !animated) {
      if (type === "VP8 " || type === "VP8L") {
        if (sawImage) throw new BrokenFileError("The WebP holds more than one picture");
        sawImage = true;
      } else if (type === "VP8X") used = i === 12;
      else if (type === "ICCP" || type === "ALPH") used = extended && !sawImage && !seen.has(type);
      else used = false; // ANIM, ANMF
      if (sawImage && type !== "VP8 " && type !== "VP8L") used = false;
    } else if (used && /^VP8[ L]$|^ANMF$/.test(type)) sawImage = true;
    seen.add(type);
    if (!used) {
      if (type === "C2PA") c2pa = true;
      note(removed, WEBP_NAMED[type] || "Other data blocks");
    } else if (type === "ICCP") {
      const profile = bytes.subarray(i + 8, i + 8 + size);
      const clean = cleanIcc(profile);
      if (!same(clean, profile)) note(removed, "Color profile details");
      const head = new Uint8Array(8);
      head.set(te.encode("ICCP"), 0);
      new DataView(head.buffer).setUint32(4, clean.length, true);
      chunks.push(concat([head, clean, new Uint8Array(clean.length & 1)]));
    } else {
      chunks.push(bytes.slice(i, Math.min(end, riffEnd)));
    }
    i = end;
  }
  if (!sawImage) throw new BrokenFileError("The WebP has no image data");
  if (riffEnd < bytes.length) note(removed, AFTER_IMAGE); // past the file's own length: never copied
  // Transparency is read only with a lossy picture; a lossless one carries its own.
  if (!animated && chunks.some((c) => startsWith(c, 0, "VP8L"))) {
    const at = chunks.findIndex((c) => startsWith(c, 0, "ALPH"));
    if (at >= 0) { chunks.splice(at, 1); note(removed, "Other data blocks"); }
  }
  for (const c of chunks) if (td.decode(c.subarray(0, 4)) === "VP8X") c[8] &= ~(0x08 | 0x04); // clear EXIF and XMP flags
  const body = concat(chunks);
  const header = new Uint8Array(12);
  header.set(te.encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, body.length + 4, true);
  header.set(te.encode("WEBP"), 8);
  return { bytes: concat([header, body]), removed, c2pa, animated };
}

// JPEG, PNG and WebP are cleaned in place. Anything else is re-drawn and saved by the browser.
// Async because a PNG's color profile is stored compressed.
export async function stripLossless(bytes, format, opts) {
  if (format === "jpeg") return stripJpeg(bytes, opts);
  if (format === "png") return stripPng(bytes);
  if (format === "webp") return stripWebp(bytes);
  return null;
}

// The check of a saved file: what would the cleaner still take out of it?
// An empty list means the file holds only picture blocks and Unpin's own rotation flag.
// A file the cleaner can't read throws, so the caller reports "couldn't check".
export async function leftovers(bytes, format) {
  const r = await stripLossless(bytes, format);
  if (!r) throw new Error(`Can't check ${format} files`);
  return r.removed;
}

// For formats we don't rebuild (HEIC, AVIF): is there C2PA, and does it say "made with AI"?
export function scanC2pa(bytes) {
  const n = Math.min(bytes.length, 8 * 1024 * 1024);
  const text = td.decode(bytes.subarray(0, n));
  const present = /jumd[\s\S]{0,40}c2pa|c2pa\.(claim|signature|assertions)/.test(text);
  return { present, ai: present ? aiFromC2pa(bytes.subarray(0, n)) : null };
}
