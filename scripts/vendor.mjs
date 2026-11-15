// Copy browser libraries and data into vendor/ so the site never loads anything
// from a third-party server. Run: npm install && npm run vendor
import { copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const v = join(root, "vendor");

function cp(from, to) {
  mkdirSync(dirname(join(v, to)), { recursive: true });
  copyFileSync(join(nm, from), join(v, to));
}

// Exact text replacements in a copied file. Each one must match once, or the run stops:
// a new library version needs the patch looked at again.
function patch(to, edits) {
  const file = join(v, to);
  let s = readFileSync(file, "utf8");
  for (const [from, into] of edits) {
    if (s.split(from).length !== 2) throw new Error(`${to}: patch target not found exactly once: ${from}`);
    s = s.replace(from, () => into);
  }
  writeFileSync(file, s);
}

// Metadata reader
cp("exifr/dist/full.esm.mjs", "exifr.mjs");
cp("exifr/LICENSE", "LICENSES/exifr-MIT.txt");
// exifr's XMP reader uses names from the file as object keys. A namespace or tag named
// "__proto__" or "constructor" then wrote into Object.prototype, which every object on the page
// shares: one crafted photo changed the report and the check of every photo opened after it.
// Such names are dropped, and a namespace is looked up only among the object's own keys.
const UNSAFE = "/^(__proto__|constructor|prototype)$/";
patch("exifr.mjs", [
  ["function _e(e,t){let i=e.serialize();void 0!==i&&(t[e.name]=i)}",
    `function _e(e,t){let i=e.serialize();void 0===i||${UNSAFE}.test(e.name)||(t[e.name]=i)}`],
  ["Je=(e,t)=>t[e]?t[e]:t[e]={}",
    `Je=(e,t)=>${UNSAFE}.test(e)?{}:Object.prototype.hasOwnProperty.call(t,e)?t[e]:t[e]={}`],
  // Each XMP namespace becomes a group of the output ("toString" was a valid one, and merged
  // into the inherited function): only the output's own groups are merged into.
  ["e[t]?Object.assign(e[t],i):e[t]=i}",
    `${UNSAFE}.test(t)||(Object.prototype.hasOwnProperty.call(e,t)?Object.assign(e[t],i):e[t]=i)}`],
]);

// Face detection
cp("@mediapipe/tasks-vision/vision_bundle.mjs", "mediapipe/vision_bundle.mjs");
cp("@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "mediapipe/wasm/vision_wasm_internal.js");
cp("@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "mediapipe/wasm/vision_wasm_internal.wasm");

// QR codes and barcodes
cp("zxing-wasm/dist/es/reader/index.js", "zxing/reader/index.js");
cp("zxing-wasm/dist/es/share.js", "zxing/share.js");
cp("zxing-wasm/dist/reader/zxing_reader.wasm", "zxing/zxing_reader.wasm");
cp("zxing-wasm/LICENSE", "LICENSES/zxing-wasm-MIT.txt");

// HEIC for browsers that can't open it (everything but Safari)
cp("heic-to/dist/csp/heic-to.js", "heic-to.js");
cp("heic-to/LICENSE", "LICENSES/heic-to-LGPL-3.0.txt");

async function download(url, to) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

// MediaPipe face model (Apache-2.0)
const model = join(v, "mediapipe/blaze_face_short_range.tflite");
if (!existsSync(model)) {
  await download(
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
    model,
  );
}

// World outline, Natural Earth 1:110m land (public domain), simplified to rings of [lon, lat]
const landPath = join(v, "data/land.json");
if (!existsSync(landPath)) {
  const res = await fetch("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson");
  const geo = await res.json();
  const rings = [];
  for (const f of geo.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const p of polys) rings.push(p[0].map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]));
  }
  mkdirSync(dirname(landPath), { recursive: true });
  writeFileSync(landPath, JSON.stringify(rings));
}

// Cities with population over 15,000, GeoNames (CC BY 4.0): [name, country, lat, lon]
const citiesPath = join(v, "data/cities.json");
if (!existsSync(citiesPath)) {
  const zip = join(root, "node_modules/.cache-cities15000.zip");
  await download("https://download.geonames.org/export/dump/cities15000.zip", zip);
  const txt = execFileSync("unzip", ["-p", zip, "cities15000.txt"], { maxBuffer: 64 * 1024 * 1024 }).toString("utf8");
  const rows = [];
  for (const line of txt.split("\n")) {
    const c = line.split("\t");
    if (c.length < 9) continue;
    rows.push([c[1], c[8], Math.round(+c[4] * 1000) / 1000, Math.round(+c[5] * 1000) / 1000]);
  }
  writeFileSync(citiesPath, JSON.stringify(rows));
}

writeFileSync(
  join(v, "LICENSES/README.md"),
  [
    "# Third-party code and data",
    "",
    "- exifr — MIT (exifr-MIT.txt)",
    "- MediaPipe Tasks Vision and BlazeFace short-range model — Apache-2.0, https://github.com/google-ai-edge/mediapipe",
    "- zxing-wasm — MIT (zxing-wasm-MIT.txt)",
    "- heic-to (libheif) — LGPL-3.0 (heic-to-LGPL-3.0.txt). Loaded only to open HEIC files in browsers without HEIC support.",
    "- data/land.json — Natural Earth 1:110m land, public domain, https://www.naturalearthdata.com",
    "- data/cities.json — GeoNames cities15000, CC BY 4.0, https://www.geonames.org",
    "- fonts/figtree-latin.woff2 — Figtree, SIL Open Font License 1.1 (figtree-OFL.txt), https://github.com/erikdkennedy/figtree",
    "- ../assets/icons.svg — Phosphor Icons, MIT (phosphor-icons-MIT.txt), https://phosphoricons.com. Built by `npm run icons`.",
    "",
  ].join("\n"),
);
console.log("vendor ok");
