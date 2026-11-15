// Facts read straight from the file's headers, before anything is decoded.
// No DOM here, so every function runs in Node tests too.

const td = new TextDecoder("latin1");
const te = new TextEncoder();

const startsWith = (bytes, offset, text) => {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  return true;
};

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A real picture has a handful of blocks; past this many the file is not read further.
export const MAX_BLOCKS = 100000;

// The first WebP chunk of each wanted type: { type: data }. One pass, nothing kept for the others,
// so a file packed with empty chunks costs no memory. Stops quietly at a broken chunk or after
// MAX_BLOCKS chunks; stripWebp reports those.
function webpChunks(bytes, wanted) {
  const out = {};
  if (!startsWith(bytes, 0, "RIFF") || !startsWith(bytes, 8, "WEBP")) return out;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, 8 + dv.getUint32(4, true));
  let left = wanted.length;
  for (let i = 12, n = 0; i + 8 <= end && left && n < MAX_BLOCKS; n++) {
    const size = dv.getUint32(i + 4, true);
    if (i + 8 + size > end) break;
    for (const type of wanted) {
      if (!out[type] && startsWith(bytes, i, type)) { out[type] = bytes.subarray(i + 8, i + 8 + size); left--; }
    }
    i += 8 + size + (size & 1);
  }
  return out;
}

const u24 = (d, o) => d[o] | (d[o + 1] << 8) | (d[o + 2] << 16);

// { width, height, alpha, animated } from the header, or null when the header doesn't say.
export function imageInfo(bytes, format) {
  if (format === "png") {
    if (!startsWith(bytes, 12, "IHDR") || bytes.length < 33) return null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const colorType = bytes[25];
    let alpha = colorType === 4 || colorType === 6;
    let animated = false;
    for (let i = 8, n = 0; i + 8 <= bytes.length && n < MAX_BLOCKS; n++) {
      const len = dv.getUint32(i);
      const type = td.decode(bytes.subarray(i + 4, i + 8));
      if (type === "tRNS") alpha = true;
      if (type === "acTL") animated = true;
      if (type === "IDAT" || type === "IEND") break; // tRNS and acTL come before the image data
      i += 12 + len;
    }
    return { width: dv.getUint32(16), height: dv.getUint32(20), alpha, animated };
  }
  if (format === "webp") {
    const { VP8X: x, VP8L: l, "VP8 ": v } = webpChunks(bytes, ["VP8X", "VP8L", "VP8 "]);
    if (x && x.length >= 10) {
      return { width: 1 + u24(x, 4), height: 1 + u24(x, 7), alpha: !!(x[0] & 0x10), animated: !!(x[0] & 0x02) };
    }
    if (l && l.length >= 5 && l[0] === 0x2f) {
      const b = l[1] | (l[2] << 8) | (l[3] << 16) | (l[4] << 24);
      return { width: 1 + (b & 0x3fff), height: 1 + ((b >>> 14) & 0x3fff), alpha: !!((b >>> 28) & 1), animated: false };
    }
    if (v && v.length >= 10 && v[3] === 0x9d && v[4] === 0x01 && v[5] === 0x2a) {
      return { width: (v[6] | (v[7] << 8)) & 0x3fff, height: (v[8] | (v[9] << 8)) & 0x3fff, alpha: false, animated: false };
    }
    return null;
  }
  if (format === "jpeg") {
    // Frame header (SOF0–SOF15, except DHT/JPG/DAC): height, then width.
    for (let i = 2; i + 9 < bytes.length; ) {
      if (bytes[i] !== 0xff) return null;
      const m = bytes[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = (bytes[i + 2] << 8) | bytes[i + 3];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: (bytes[i + 7] << 8) | bytes[i + 8], height: (bytes[i + 5] << 8) | bytes[i + 6], alpha: false, animated: false };
      }
      if (m === 0xda || len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  if (format === "heic" || format === "avif") return heifSize(bytes);
  return null;
}

// HEIC and AVIF keep each picture's size in an "ispe" box: the tiles (512×512 on an iPhone),
// the thumbnail and the whole picture each have one, and the whole picture is the largest.
// An "irot" box turns it by 90° steps; at 90° or 270° width and height swap. The boxes sit in
// the "meta" box near the start, so only the first megabyte is searched. Gives the size as shown,
// before the slow decoder runs; null if there is no "ispe".
function heifSize(bytes) {
  const end = Math.min(bytes.length, 1 << 20);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let best = null, quarter = false;
  for (let i = 4; i + 5 <= end; i++) {
    if (bytes[i] === 0x69 && i + 16 <= end && startsWith(bytes, i, "ispe")) { // "i"
      const width = dv.getUint32(i + 8), height = dv.getUint32(i + 12);
      if (!best || width * height > best.width * best.height) best = { width, height };
    } else if (bytes[i] === 0x69 && startsWith(bytes, i, "irot") && dv.getUint32(i - 4) === 9) {
      quarter = (bytes[i + 4] & 1) === 1; // angle × 90°, counter-clockwise
    }
  }
  if (!best) return null;
  const [width, height] = quarter ? [best.height, best.width] : [best.width, best.height];
  return { width, height, alpha: false, animated: false };
}

// exifr can't read WebP. Hand it the WebP's EXIF and XMP inside a tiny JPEG shell instead.
// Returns { bytes, partial } or null when the file has no EXIF or XMP chunk at all.
export function webpMetadata(bytes) {
  const { EXIF: exif, "XMP ": xmp } = webpChunks(bytes, ["EXIF", "XMP "]);
  if (!exif && !xmp) return null;
  const segs = [new Uint8Array([0xff, 0xd8])];
  let partial = false;
  const app1 = (body) => {
    if (body.length + 2 > 0xffff) { partial = true; return; }
    const len = body.length + 2;
    segs.push(new Uint8Array([0xff, 0xe1, len >> 8, len & 0xff]), body);
  };
  if (exif) {
    const tiff = startsWith(exif, 0, "Exif\0\0") ? exif.subarray(6) : exif;
    app1(concat([te.encode("Exif\0\0"), tiff]));
  }
  if (xmp) app1(concat([te.encode("http://ns.adobe.com/xap/1.0/\0"), xmp]));
  segs.push(new Uint8Array([0xff, 0xd9]));
  return { bytes: concat(segs), partial };
}
