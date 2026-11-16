// Turn raw metadata into plain-language findings: what a stranger can learn from this file.
import exifr from "../vendor/exifr.mjs";
import { scanC2pa } from "./strip.js";
import { readC2pa } from "./c2pa.js";
import { aiReport, aiFinding } from "./ai.js";
import { MAX_BLOCKS } from "./inspect.js";

export const OPTIONS = {
  tiff: true, exif: true, gps: true, xmp: true, iptc: true, icc: false,
  interop: false, makerNote: false, userComment: true, ihdr: true,
  translateValues: true, reviveValues: true, mergeOutput: true,
};

// The same lists are used to report what a file says and to check the clean file.
export const SERIAL_KEYS = ["BodySerialNumber", "SerialNumber", "CameraSerialNumber", "InternalSerialNumber", "LensSerialNumber", "ImageUniqueID"];
export const OWNER_KEYS = ["Artist", "OwnerName", "CameraOwnerName", "creator", "Copyright", "Rights", "rights", "By-line", "Writer-Editor", "Credit"];
export const DATE_KEYS = ["DateTimeOriginal", "CreateDate", "DateCreated", "ModifyDate", "DateTimeDigitized", "GPSDateStamp"];
export const DEVICE_KEYS = ["Make", "Model", "LensModel", "Lens", "HostComputer"];
// Place names: IPTC (City, Sublocation, State, Country) and their XMP twins (photoshop:City,
// Iptc4xmpCore:Location…). A photo can name the place without any coordinates.
export const PLACE_KEYS = ["Sublocation", "Location", "City", "State", "Country", "ContentLocationName"];
export const NOTE_KEYS =["ImageDescription", "description", "Caption-Abstract", "UserComment", "title", "Headline", "Keywords", "subject"];

// XMP "language alternative" values come as { lang, value }; empty ones carry only "x-default".
const EMPTY = /^(x-default|\s*)$/i;

function text(v) {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join(", ");
  if (typeof v === "object") return text(v.value);
  return String(v).trim();
}

export function first(meta, keys) {
  for (const k of keys) {
    const t = text(meta[k]);
    if (t && !EMPTY.test(t)) return t;
  }
  return null;
}

// Coordinates. EXIF gives exifr numbers (latitude, longitude); XMP keeps them as text,
// "DDD,MM.mmK" or "DDD,MM,SSK" (K is N, S, E or W), which exifr passes on as it is.
function xmpCoord(v) {
  const m = /^\s*(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?(?:,(\d+(?:\.\d+)?))?\s*([NSEW])\s*$/i.exec(typeof v === "string" ? v : "");
  if (!m) return null;
  const d = +m[1] + (+m[2] || 0) / 60 + (+m[3] || 0) / 3600;
  return /[SW]/i.test(m[4]) ? -d : d;
}
const real = (n, max) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= max;
// { lat, lon } or null. The same test reports the original and checks the clean file.
export function coordinates(meta) {
  if (real(meta.latitude, 90) && real(meta.longitude, 180)) return { lat: meta.latitude, lon: meta.longitude };
  const lat = xmpCoord(meta.GPSLatitude), lon = xmpCoord(meta.GPSLongitude);
  return real(lat, 90) && real(lon, 180) ? { lat, lon } : null;
}
// Anything that says where: coordinates, or a place name.
export const saysWhere = (meta) => !!coordinates(meta) || typeof meta.latitude === "number" || typeof meta.longitude === "number" || !!first(meta, PLACE_KEYS);

// The icon for "What it was taken with": a phone, a camera, a drone, or just an app when the file
// names only the software. Decided from the maker and model fields.
const PHONE_MAKERS = /apple|samsung|google|xiaomi|redmi|poco|huawei|honor|oneplus|oppo|vivo|realme|motorola|nokia|lg electronics|zte|asus|nothing|meizu|tecno|infinix|fairphone|htc/i;
const PHONE_MODELS = /iphone|ipad|pixel|galaxy|\bsm-[a-z]\d|redmi|\bmi \d|oneplus|xperia|moto /i;
export function deviceIcon(meta) {
  const make = String(meta.Make || ""), model = String(meta.Model || "");
  if (!make && !model) return meta.HostComputer && /iphone|ipad|pixel|galaxy/i.test(meta.HostComputer) ? "device-mobile" : "app-window";
  if (/\bdji\b/i.test(make) && !/osmo|pocket|action/i.test(model)) return "drone"; // DJI's handheld cameras stay cameras
  if (PHONE_MODELS.test(model) || (PHONE_MAKERS.test(make) && !/sony/i.test(make))) return "device-mobile";
  return "camera"; // Nikon, Canon, Sony, Fujifilm, Olympus, Panasonic, Leica, Pentax, Ricoh, GoPro…
}

// XMP and IPTC dates stay text ("2026-08-03T16:05:45+03:00", "2026:08:03 16:05"). Read as the
// wall-clock time written there, the way exifr reads EXIF dates; the offset, if any, goes on top.
function asDate(v) {
  if (v instanceof Date) return { date: v, offset: null, time: true };
  const m = /^\s*(\d{4})[-:](\d\d)[-:](\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?\s*(Z|[+-]\d\d:?\d\d)?)?/.exec(typeof v === "string" ? v : "");
  if (!m) return null;
  const date = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  const offset = m[7] === "Z" ? "+00:00" : m[7] ? m[7].replace(/^([+-]\d\d)(\d\d)$/, "$1:$2") : null;
  return { date, offset, time: m[4] != null };
}

function fmtDate(v, offset) {
  const parsed = asDate(v);
  if (!parsed || isNaN(parsed.date)) return null;
  const d = parsed.date;
  offset = (typeof offset === "string" && offset) || parsed.offset;
  if (!parsed.time) return d.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  // exifr builds the Date from the camera's wall-clock time in the viewer's own time zone,
  // so formatting it in that same zone shows the time exactly as the camera wrote it.
  const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" };
  const s = d.toLocaleString("en-GB", opts);
  return offset ? `${s} (UTC${offset})` : s;
}

// Read PNG text chunks ourselves: AI tools put whole prompts there, and ComfyUI whole workflows.
// tEXt: keyword, NUL, text. zTXt: keyword, NUL, method 0, zlib text. iTXt: keyword, NUL, compressed
// flag, method 0, language tag, NUL, translated keyword, NUL, UTF-8 text (zlib when the flag is 1).
// Unpacking is capped: a few bytes of zlib can stand for gigabytes. A text over the cap, or one
// that doesn't unpack, is skipped, never shown cut off; the report only ever shows its start.
export const PNG_TEXT_MAX = 1 << 20; // one text: ComfyUI workflows run to a few hundred KB
export const PNG_TEXT_TOTAL = 4 << 20; // all compressed texts together
export const PNG_TEXT_ZIPPED = 256; // compressed chunks unpacked at most: each one starts a stream

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8", { fatal: true });
// tEXt is Latin-1 by the spec, but many tools write UTF-8 there; valid UTF-8 is read as UTF-8.
function tEXtString(b) {
  try { return utf8.decode(b); } catch { return latin1.decode(b); }
}
const utf8Lenient = new TextDecoder();

// zlib data unpacked into at most `cap` bytes, or null: too large, broken, or no streams here.
async function unzip(data, cap) {
  if (typeof DecompressionStream !== "function") return null;
  let reader;
  try {
    reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
    const parts = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > cap) { reader.cancel().catch(() => {}); return null; }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  } catch {
    reader?.cancel().catch(() => {});
    return null;
  }
}

// { keyword: text }. The last chunk with a keyword wins, as before. Never throws.
export async function pngTexts(bytes) {
  const out = {};
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let budget = PNG_TEXT_TOTAL, zipped = 0;
  const unpack = async (data) => {
    if (zipped >= PNG_TEXT_ZIPPED || budget <= 0) return null;
    zipped++;
    const raw = await unzip(data, Math.min(PNG_TEXT_MAX, budget));
    if (raw) budget -= raw.length;
    return raw;
  };
  for (let i = 8, n = 0; i + 12 <= bytes.length && n < MAX_BLOCKS; n++) {
    const len = dv.getUint32(i);
    if (len > bytes.length - i - 12) break; // runs past the end of the file
    const type = latin1.decode(bytes.subarray(i + 4, i + 8));
    if (type === "IEND") break;
    const data = bytes.subarray(i + 8, i + 8 + len);
    i += 12 + len;
    if (type !== "tEXt" && type !== "zTXt" && type !== "iTXt") continue;
    const z = data.indexOf(0);
    if (z < 1 || z > 79) continue; // keywords are 1 to 79 bytes
    const key = latin1.decode(data.subarray(0, z));
    let value = null;
    try {
      if (type === "tEXt") value = tEXtString(data.subarray(z + 1));
      else if (type === "zTXt") {
        if (data[z + 1] !== 0 || z + 2 > data.length) continue;
        const raw = await unpack(data.subarray(z + 2));
        if (raw) value = latin1.decode(raw);
      } else {
        const flag = data[z + 1], method = data[z + 2];
        if (z + 3 > data.length || flag > 1 || (flag === 1 && method !== 0)) continue;
        const lang = data.indexOf(0, z + 3);
        const tkey = lang < 0 ? -1 : data.indexOf(0, lang + 1);
        if (tkey < 0) continue;
        const body = data.subarray(tkey + 1);
        const raw = flag ? await unpack(body) : body;
        if (raw) value = utf8Lenient.decode(raw);
      }
    } catch {
      value = null;
    }
    if (value != null) out[key] = value;
  }
  return out;
}

// metaSrc is what exifr reads: the file itself, a JPEG shell with a WebP's metadata, or null when
// the file has no metadata blocks. A read error is reported, never turned into "nothing found".
export async function xray(file, bytes, format, stripPreview, metaSrc = file) {
  let meta = {};
  let readError = false;
  if (metaSrc) {
    try {
      meta = (await exifr.parse(metaSrc, OPTIONS)) || {};
    } catch {
      meta = {};
      readError = true;
    }
  }
  const findings = [];
  const png = format === "png" ? await pngTexts(bytes) : {}; // PNG text chunks: names, prompts, settings, XMP
  const add = (f) => findings.push(f);

  // Location: coordinates (EXIF or XMP), and place names written into the file.
  const at = coordinates(meta);
  if (at) {
    const extra = [];
    if (real(meta.GPSHPositioningError, 1e7)) extra.push(`accurate to about ${Math.round(meta.GPSHPositioningError)} m`);
    if (real(meta.GPSAltitude, 1e7)) extra.push(`altitude ${Math.round(meta.GPSAltitude)} m`);
    if (real(meta.GPSImgDirection, 360)) extra.push(`camera facing ${Math.round(meta.GPSImgDirection)}°`);
    add({
      id: "location", level: "high", title: "Where it was taken",
      text: `${at.lat.toFixed(5)}, ${at.lon.toFixed(5)}${extra.length ? " · " + extra.join(" · ") : ""}`,
      lat: at.lat, lon: at.lon,
    });
  }
  const placeNames = [...new Set(PLACE_KEYS.map((k) => first(meta, [k])).filter(Boolean))];
  if (placeNames.length) {
    add({ id: "place", level: "high", title: at ? "The place, by name" : "Where it was taken", text: placeNames.join(", ").slice(0, 200) });
  }

  // Time
  const when = meta.DateTimeOriginal || meta.CreateDate || meta.DateCreated || meta.ModifyDate || meta.GPSDateStamp;
  const whenText = fmtDate(when, meta.OffsetTimeOriginal || meta.OffsetTime);
  let c2pa = null;
  try { c2pa = readC2pa(bytes, format); } catch { c2pa = null; }
  // No camera date (a generated picture, say): the credentials or the PNG's "Creation Time"
  // (Midjourney writes it) still say when it was made. Shown in UTC, as they store it.
  const made = c2pa?.when || png["Creation Time"] || null;
  if (whenText) add({ id: "time", level: "medium", title: "When it was taken", text: whenText });
  else if (made && !isNaN(new Date(made))) {
    const s = new Date(made).toLocaleString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    add({ id: "time", level: "medium", title: c2pa && !c2pa.ai && made === c2pa.when ? "When it was signed" : "When it was made", text: `${s} (UTC)` });
  }

  // Device
  const device = [meta.Make, meta.Model].filter(Boolean).join(" ").replace(/^(\w+) \1/i, "$1");
  const lens = meta.LensModel || meta.Lens;
  const host = meta.HostComputer;
  const sw = meta.Software || meta.CreatorTool;
  const deviceBits = [device || host, lens && !String(lens).includes(device) ? lens : null, sw ? `software: ${sw}` : null].filter(Boolean);
  if (deviceBits.length) add({ id: "device", level: "medium", title: "What it was taken with", text: deviceBits.join(" · "), icon: deviceIcon(meta) });

  // Serial numbers: they link all photos from one camera
  const serial = first(meta, SERIAL_KEYS);
  if (serial) add({ id: "serial", level: "high", title: "Camera or file serial number", text: `${serial} — links this photo to every other photo from the same camera.` });

  // Names. PNG keeps them in its own text chunks too: Midjourney writes your Discord name as "Author".
  const owner = first(meta, OWNER_KEYS) || first(png, ["Author", "Artist", "Copyright"]);
  if (owner) add({ id: "owner", level: "high", title: "A name in the file", text: owner });

  // Descriptions and comments
  const note = first(meta, NOTE_KEYS);
  if (note) add({ id: "note", level: "medium", title: "Text written into the file", text: note.slice(0, 200) });

  // PNG text: AI prompts and generator settings
  if (format === "png") {
    const t = png;
    const prompt = t.parameters || t.prompt || t.Description || t.Comment;
    if (prompt) add({ id: "prompt", level: "medium", title: "An AI prompt or generator settings", text: prompt.slice(0, 200) + (prompt.length > 200 ? "…" : "") });
  }

  // Embedded preview: may show the photo before it was cropped
  let thumbUrl = null;
  if (metaSrc) {
    try {
      thumbUrl = await exifr.thumbnailUrl(metaSrc);
    } catch {}
  }
  if (thumbUrl) add({ id: "thumb", level: "medium", title: "A hidden preview image", text: "A small copy of the photo is stored inside. It can show the picture before you cropped or edited it.", thumbUrl });

  // Extra images (depth map, Live Photo frame, HDR gain map)
  if (stripPreview && stripPreview.removed.some((r) => /MPF|after the image/.test(r))) {
    add({ id: "extra", level: "medium", title: "Extra images inside", text: "The file carries additional images (for example a depth map or HDR data) that you don't see." });
  }

  // Content Credentials: removed (see strip.js), like the "made with AI" label.
  const scanned = stripPreview ? { present: stripPreview.c2pa } : scanC2pa(bytes);
  // Made or edited with AI, and with what: from the credentials, the IPTC label, the software fields
  // or a generator's PNG settings. Always reported, including "no label", which isn't "not AI".
  const report = aiReport({ c2pa, meta, png });
  if (scanned.present && !(report.kind === "created" || report.kind === "edited")) {
    add({
      id: "c2pa", level: "low", title: "Content Credentials (C2PA)",
      text: `Signed details about which app made or edited the picture${c2pa?.signer ? ` (written by ${c2pa.signer})` : ""}. They can include a location or a small preview. They are removed: the signature covers the whole file, so it can't stay valid once the rest is cleaned.`,
    });
  }
  // A picture made or edited with AI says so first; "no label" goes last.
  const aiItem = aiFinding(report);
  if (report.kind === "created" || report.kind === "edited") findings.unshift(aiItem);
  else add(aiItem);
  const removedBlocks = stripPreview ? stripPreview.removed : [];
  return { meta, findings, removedBlocks, c2pa: scanned.present, aiReport: report, thumbUrl, readError };
}

// Offline nearest city lookup (GeoNames cities over 15,000 people).
let cities = null;
export async function nearestCity(lat, lon) {
  if (!cities) cities = await (await fetch(new URL("../vendor/data/cities.json", import.meta.url))).json();
  const rad = Math.PI / 180;
  let best = null;
  let bestD = Infinity;
  for (const [name, cc, la, lo] of cities) {
    const dLat = (la - lat) * rad;
    const dLon = (lo - lon) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * rad) * Math.cos(la * rad) * Math.sin(dLon / 2) ** 2;
    const d = 12742 * Math.asin(Math.sqrt(a));
    if (d < bestD) { bestD = d; best = { name, cc }; }
  }
  return best ? { ...best, km: bestD } : null;
}
