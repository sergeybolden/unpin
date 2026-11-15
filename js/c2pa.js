// Read Content Credentials (C2PA): who made the picture, with what, when, and whether a model made it.
// Only reads what the file says; the signature is not checked (that needs certificate chains).
// No DOM here, so it runs in Node tests too.

import { MAX_BLOCKS } from "./inspect.js";

const td = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");
const str = (v) => (typeof v === "string" && v ? v : null);
const at = (b, o, s) => o >= 0 && o + s.length <= b.length && [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));

// ---------- find the manifest store in the file ----------
// PNG keeps it in a caBX chunk, WebP in a C2PA chunk, JPEG in APP11 segments (split, to be joined),
// HEIC/AVIF in a box. Returns the JUMBF bytes of the store, or null.
export function findJumbf(bytes, format) {
  if (format === "jpeg") return jpegJumbf(bytes);
  if (format === "png") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 8, n = 0; i + 12 <= bytes.length && n < MAX_BLOCKS; n++) {
      const len = dv.getUint32(i);
      if (at(bytes, i + 4, "caBX")) return bytes.subarray(i + 8, i + 8 + len);
      if (at(bytes, i + 4, "IEND")) break;
      i += 12 + len;
    }
    return null;
  }
  if (format === "webp") {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 12, n = 0; i + 8 <= bytes.length && n < MAX_BLOCKS; n++) {
      const size = dv.getUint32(i + 4, true);
      if (at(bytes, i, "C2PA")) return bytes.subarray(i + 8, i + 8 + size);
      i += 8 + size + (size & 1);
    }
    return null;
  }
  return scanJumbf(bytes);
}

// APP11 segments: "JP", instance (2), sequence number (4), then the box; every segment after the
// first repeats the box header (8 bytes), which is dropped when joining.
function jpegJumbf(bytes) {
  const parts = [];
  for (let i = 2; i + 4 < bytes.length; ) {
    if (bytes[i] !== 0xff) break;
    const m = bytes[i + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (m === 0xeb && at(bytes, i + 4, "JP")) {
      const seq = new DataView(bytes.buffer, bytes.byteOffset + i + 8, 4).getUint32(0);
      const body = bytes.subarray(i + 12, i + 2 + len);
      if (at(body, 4, "jumb")) parts.push({ seq, body });
    }
    i += 2 + len;
  }
  if (!parts.length) return null;
  parts.sort((a, b) => a.seq - b.seq);
  const out = [parts[0].body, ...parts.slice(1).map((p) => p.body.subarray(8))];
  const all = new Uint8Array(out.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of out) { all.set(p, o); o += p.length; }
  return all;
}

// Anywhere else: look for a "jumb" box whose description is labelled "c2pa".
function scanJumbf(bytes) {
  for (let i = 4; i + 40 < bytes.length; i++) {
    if (bytes[i] !== 0x6a || !at(bytes, i, "jumb") || !at(bytes, i + 8, "jumd")) continue;
    if (!at(bytes, i + 29, "c2pa")) continue;
    const len = new DataView(bytes.buffer, bytes.byteOffset + i - 4, 4).getUint32(0);
    return bytes.subarray(i - 4, Math.min(bytes.length, i - 4 + len));
  }
  return null;
}

// ---------- JUMBF boxes ----------
// A box is length (4), type (4), payload. A "jumb" superbox starts with a "jumd" description
// (16-byte type, toggles, optional label) and holds further boxes.
function boxes(b) {
  const out = [];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i + 8 <= b.length; ) {
    let len = dv.getUint32(i), head = 8;
    if (len === 1) { len = Number(dv.getBigUint64(i + 8)); head = 16; }
    if (len === 0) len = b.length - i;
    if (len < head || i + len > b.length) break;
    out.push({ type: td.decode(b.subarray(i + 4, i + 8)), data: b.subarray(i + head, i + len) });
    i += len;
  }
  return out;
}

function superbox(data) {
  const kids = boxes(data);
  const d = kids[0]?.type === "jumd" ? kids[0].data : null;
  let label = "";
  if (d && d.length > 17 && d[16] & 0x02) {
    const end = d.indexOf(0, 17);
    label = utf8.decode(d.subarray(17, end < 0 ? d.length : end));
  }
  return { label, kids: kids.slice(1) };
}

// ---------- CBOR (the format C2PA assertions and claims are written in) ----------
// Capped: a claim or an actions list is a few hundred items, so a block claiming millions of
// them, or nesting hundreds deep, is refused instead of filling the tab's memory.
const CBOR_MAX_ITEMS = 100000, CBOR_MAX_DEPTH = 64;
export function cbor(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 0, items = 0, depth = 0;
  const room = (n) => { if (n > bytes.length - p) throw new Error("CBOR cut short"); };
  const arg = (info) => {
    if (info < 24) return info;
    if (info === 24) return bytes[p++];
    if (info === 25) { const v = dv.getUint16(p); p += 2; return v; }
    if (info === 26) { const v = dv.getUint32(p); p += 4; return v; }
    if (info === 27) { const v = Number(dv.getBigUint64(p)); p += 8; return v; }
    if (info === 31) return -1; // indefinite length
    throw new Error("bad CBOR");
  };
  const item = () => {
    if (p >= bytes.length) throw new Error("CBOR cut short");
    if (++items > CBOR_MAX_ITEMS) throw new Error("CBOR too large");
    if (depth > CBOR_MAX_DEPTH) throw new Error("CBOR too deep");
    depth++;
    try { return one(); } finally { depth--; }
  };
  const one = () => {
    const ib = bytes[p++], major = ib >> 5, info = ib & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22 || info === 23) return null;
      if (info === 25) { p += 2; return 0; } // half float: not needed here
      if (info === 26) { const v = dv.getFloat32(p); p += 4; return v; }
      if (info === 27) { const v = dv.getFloat64(p); p += 8; return v; }
      if (info === 31) return BREAK;
      return null;
    }
    const n = arg(info);
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      let chunk;
      if (n < 0) { const parts = []; for (let x; (x = item()) !== BREAK; ) parts.push(x); return major === 3 ? parts.join("") : parts; }
      room(n);
      chunk = bytes.subarray(p, p + n); p += n;
      return major === 3 ? utf8.decode(chunk) : chunk;
    }
    if ((major === 4 || major === 5) && n > 0) room(n); // every item takes at least a byte
    if (major === 4) { const a = []; if (n < 0) for (let x; (x = item()) !== BREAK; ) a.push(x); else for (let i = 0; i < n; i++) a.push(item()); return a; }
    if (major === 5) {
      const o = {};
      // Keys come from the file: a "__proto__" key would replace the object's prototype.
      const pair = () => { const k = item(); if (k === BREAK) return false; const v = item(); if (String(k) !== "__proto__") o[String(k)] = v; return true; };
      if (n < 0) while (pair()); else for (let i = 0; i < n; i++) pair();
      return o;
    }
    if (major === 6) return item(); // tag: keep the value
    throw new Error("bad CBOR");
  };
  return item();
}
const BREAK = Symbol("break");

const IPTC = "http://cv.iptc.org/newscodes/digitalsourcetype/";
const MADE = /\/(trainedAlgorithmicMedia|algorithmicMedia)$/;
const EDITED = /\/(compositeWithTrainedAlgorithmicMedia|compositeSynthetic)$/;

// ---------- summary ----------
// The store holds the whole history: the active manifest is the last one, and earlier ones are the
// steps it was made from (Gemini, for one, makes the picture in one manifest, adds its SynthID
// watermark in another and converts it for download in a third). So every manifest is read, and the
// model's step is looked for in all of them, newest first.
// { signer, icon, tool, version, description, ai: "created" | "edited" | null, when, watermark, actions } or null.
export function readC2pa(bytes, format) {
  const store = findJumbf(bytes, format);
  if (!store) return null;
  const top = boxes(store).find((b) => b.type === "jumb");
  if (!top) return null;
  const { label, kids } = superbox(top.data);
  if (label !== "c2pa") return null;
  const manifests = kids.filter((k) => k.type === "jumb").map((k) => readManifest(superbox(k.data)));
  if (!manifests.length) return null;
  const active = manifests[manifests.length - 1];
  const newestFirst = [...manifests].reverse();

  const all = newestFirst.flatMap((m) => m.actions);
  const made = all.find((a) => a.sourceType && MADE.test(a.sourceType));
  const edited = all.find((a) => a.sourceType && EDITED.test(a.sourceType));
  const main = made || edited || active.actions.find((a) => a.action === "c2pa.created") || active.actions[0] || null;
  const aiManifest = main ? newestFirst.find((m) => m.actions.includes(main)) : null;
  // An invisible watermark (SynthID) matters more than a visible one in a corner.
  const watermark = all.find((a) => /synthid|imperceptible|invisible/i.test(a.description || ""));
  return {
    signer: active.signer || aiManifest?.signer || null,
    icon: active.icon || aiManifest?.icon || newestFirst.find((m) => m.icon)?.icon || null, // the signer's logo, as the file carries it
    tool: main?.tool || null,
    version: main?.version || null,
    description: main?.description || null, // e.g. "Created by Google Generative AI"
    when: main?.when || null,
    ai: made ? "created" : edited ? "edited" : null,
    sourceType: (made || edited)?.sourceType || null,
    watermark: watermark ? (/synthid/i.test(watermark.description) ? "SynthID" : "an invisible watermark") : null,
    actions: all,
  };
}

function readManifest(m) {
  let claim = null;
  const assertions = {};
  for (const k of m.kids) {
    if (k.type !== "jumb") continue;
    const sb = superbox(k.data);
    if (/^c2pa\.claim/.test(sb.label)) claim = content(sb);
    if (sb.label === "c2pa.assertions") {
      for (const a of sb.kids) {
        if (a.type !== "jumb") continue;
        const ab = superbox(a.data);
        if (/^c2pa\.(icon|actions)/.test(ab.label)) assertions[ab.label] = /^c2pa\.icon/.test(ab.label) ? embedded(ab) : content(ab);
      }
    }
  }
  // "signer" here is the program that wrote the claim (claim_generator), not the certificate's
  // owner: Unpin doesn't read the signature, so the page says "written by", never "signed by".
  // The file decides every type here: anything that should be text and isn't counts as missing.
  const gen = claim?.claim_generator_info;
  const signer = str(Array.isArray(gen) ? gen[0]?.name : gen?.name) || (typeof claim?.claim_generator === "string" ? claim.claim_generator.split("/")[0] : null) || null;
  const raw = assertions["c2pa.actions.v2"]?.actions || assertions["c2pa.actions"]?.actions;
  const list = Array.isArray(raw) ? raw.filter((a) => a && typeof a === "object") : [];
  const actions = list.map((a) => {
    const agent = a.softwareAgent;
    return {
      action: str(a.action),
      when: str(a.when),
      tool: typeof agent === "string" ? agent : str(agent?.name),
      version: str(agent?.version),
      description: str(a.description),
      sourceType: str(a.digitalSourceType) || str(a.parameters?.digitalSourceType),
    };
  });
  const iconKey = Object.keys(assertions).find((k) => /^c2pa\.icon/.test(k));
  return { signer, actions, icon: iconKey ? assertions[iconKey] : null };
}

// An embedded file: "bfdb" says its media type, "bidb" holds the bytes. Images only.
function embedded(sb) {
  const desc = sb.kids.find((k) => k.type === "bfdb")?.data;
  const data = sb.kids.find((k) => k.type === "bidb")?.data;
  if (!desc || !data) return null;
  const end = desc.indexOf(0, 1);
  const type = utf8.decode(desc.subarray(1, end < 0 ? desc.length : end));
  return /^image\/(svg\+xml|png|jpeg|webp)$/.test(type) && data.length < 200_000 ? { type, bytes: data.slice() } : null;
}

function content(sb) {
  const box = sb.kids.find((k) => k.type === "cbor" || k.type === "json");
  if (!box) return null;
  try {
    return box.type === "cbor" ? cbor(box.data) : JSON.parse(utf8.decode(box.data));
  } catch {
    return null;
  }
}

export const AI_SOURCE = IPTC;
