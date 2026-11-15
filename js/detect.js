// Find things on the picture itself: faces, QR codes and barcodes. Everything runs in this tab:
// the heavy parts in workers (js/faces-worker.js, js/codes-worker.js), so the page keeps drawing;
// if a worker can't start, right here on the page. This file also runs inside the faces worker.
const base = new URL("../vendor/", import.meta.url).href;
const onPage = typeof document !== "undefined";
// A canvas here or in a worker.
const canvas = (w = 1, h = 1) => (onPage ? Object.assign(document.createElement("canvas"), { width: w, height: h }) : new OffscreenCanvas(w, h));

let faceDetector = null;
export async function loadFaceDetector(onStatus) {
  if (faceDetector) return faceDetector;
  onStatus?.("Loading the face finder (about 15 MB, only once)…");
  const { FaceDetector } = await import(base + "mediapipe/vision_bundle.mjs");
  faceDetector = await FaceDetector.createFromOptions(
    { wasmLoaderPath: base + "mediapipe/wasm/vision_wasm_internal.js", wasmBinaryPath: base + "mediapipe/wasm/vision_wasm_internal.wasm" },
    { baseOptions: { modelAssetPath: base + "mediapipe/blaze_face_short_range.tflite", delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.55 },
  );
  return faceDetector;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}

function nms(boxes, threshold = 0.3) {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const b of sorted) if (!keep.some((k) => iou(k, b) > threshold || contains(k, b) || contains(b, k))) keep.push(b);
  return keep;
}

function contains(a, b) {
  return b.x >= a.x - 2 && b.y >= a.y - 2 && b.x + b.w <= a.x + a.w + 2 && b.y + b.h <= a.y + a.h + 2;
}

// The short-range model is made for faces close to the camera: a face has to fill a good part of
// what it looks at. So the photo is scanned whole and then in overlapping tiles, down to tiles
// of about 180 px, which catches faces of ~25 px. Small tiles also produce false hits (a wheel,
// a pattern), so every candidate gets a second look: a crop three times its size around it.
// Real faces come back with a high score there; false hits mostly don't come back at all.
const WORK_MAX = 2048; // faces are searched on a copy this big at most
const MIN_TILE = 180;
const CONFIRM = 0.7;
// Speed: each look of the model costs ~17 ms whatever its size, so the work is the number of looks.
// - Tiles overlap by a quarter: a face up to a quarter of a tile always fits whole in one tile;
//   bigger ones are caught at the next, bigger tile size.
// - Small tiles with no skin-coloured pixel at all are skipped: on big photos that leaves 20–50%
//   of them (sky, leaves, water, road). The skin range is wide, to cover all skin tones.
//   Black-and-white photos have no colour to judge by, so there every tile is looked at.
const STEP = 0.75;
const SKIN_MIN = 2; // skin-coloured pixels out of a 16×16 thumbnail of the tile

const tick = () => new Promise((r) => setTimeout(r)); // let the page breathe between passes
// Hand the thread back whenever the work has held it for a couple of frames (one look of the model
// is ~17 ms; a big photo takes hundreds of them): on the page so it keeps drawing, in the worker so
// it hears a "stop" for a search nobody needs any more.
let slice = 0;
const breathe = async () => {
  if (performance.now() - slice < 30) return;
  await tick();
  slice = performance.now();
};
const stopped = () => Object.assign(new Error("stopped"), { name: "AbortError" });

const probe = canvas(16, 16);
const pctx = probe.getContext("2d", { willReadFrequently: true });
const isSkin = (r, g, b) => {
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return cr >= 135 && cr <= 180 && cb >= 75 && cb <= 130 && r > g;
};
function skinPixels(img, x, y, w, h) {
  pctx.drawImage(img, x, y, w, h, 0, 0, 16, 16);
  const d = pctx.getImageData(0, 0, 16, 16).data;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (isSkin(d[i], d[i + 1], d[i + 2])) n++;
  return n;
}
// Average colourfulness of the whole photo; near 0 means black and white (or sepia-flat).
function colourful(img) {
  pctx.drawImage(img, 0, 0, 16, 16);
  const d = pctx.getImageData(0, 0, 16, 16).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
  return sum / (d.length / 4);
}

export const faceStats = { looks: 0, skipped: 0, candidates: 0, confirms: 0 }; // for tests and tuning

// Two passes, so the first answer comes fast:
// - "near": the whole photo, then tiles of a half and a third of it (about 14 looks). Finds faces
//   from about 4% of the photo's long side: everyone not photographed from far away.
// - "far": tiles of a sixth and a tenth (about 120 looks, ~90% of the time). Faces down to ~25 px,
//   in a crowd or far off. The page runs it in the background after the report is out.
// "all" does both. options.signal (an AbortSignal, or { aborted }) stops a search midway.
export async function findFaces(source, onStatus, { pass = "all", signal } = {}) {
  const det = await loadFaceDetector(onStatus);
  onStatus?.(pass === "far" ? "Looking for small faces…" : "Looking for faces…");
  const k = Math.min(1, WORK_MAX / Math.max(source.width, source.height));
  const img = canvas(Math.round(source.width * k), Math.round(source.height * k));
  img.getContext("2d", { willReadFrequently: true }).drawImage(source, 0, 0, img.width, img.height);
  const W = img.width, H = img.height, L = Math.max(W, H);

  const divisors = pass === "near" ? [1, 2, 3.5] : pass === "far" ? [6, 10] : [1, 2, 3.5, 6, 10];
  const sizes = divisors.map((n) => L / n).filter((s, i) => s === L || s >= MIN_TILE);

  Object.assign(faceStats, { looks: 0, skipped: 0, candidates: 0, confirms: 0 });
  const useSkin = colourful(img) >= 12;
  const boxes = [];
  // Kept in memory, not on the GPU: the model reads every tile back, and readbacks are slow there.
  const c = canvas();
  const ctx = c.getContext("2d", { willReadFrequently: true });
  slice = performance.now();
  for (const s of sizes) {
    if (s < L && pass === "all") onStatus?.("Looking for small faces…");
    const step = s * STEP;
    for (let y = 0; y < H; y += step) {
      for (let x = 0; x < W; x += step) {
        const w = Math.min(s, W - x), h = Math.min(s, H - y);
        if ((w < s * 0.5 || h < s * 0.5) && s < L) continue; // the edge is covered by the tile before
        if (useSkin && s < L / 2 && skinPixels(img, x, y, w, h) < SKIN_MIN) { faceStats.skipped++; continue; }
        faceStats.looks++;
        const scale = Math.min(1, 1024 / Math.max(w, h));
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
        for (const d of det.detect(c).detections) {
          const bb = d.boundingBox;
          boxes.push({ x: x + bb.originX / scale, y: y + bb.originY / scale, w: bb.width / scale, h: bb.height / scale, score: d.categories?.[0]?.score ?? 0.5 });
        }
        await breathe();
        if (signal?.aborted) throw stopped();
      }
    }
    await tick();
  }

  const faces = [];
  const candidates = nms(boxes);
  faceStats.candidates = candidates.length;
  for (const b of candidates) {
    const sure = confirm(det, img, b);
    if (sure) faces.push(sure);
    await breathe();
    if (signal?.aborted) throw stopped();
  }
  return nms(faces)
    .map((b) => ({ x: b.x / k, y: b.y / k, w: b.w / k, h: b.h / k, score: b.score }))
    .map((b) => grow(b, 0.25, source.width, source.height))
    .map((b) => ({ ...b, kind: "face" }));
}

// The page calls this: the search runs in a worker on a copy no bigger than WORK_MAX, and the boxes
// come back in the photo's own pixels. Status lines ("Looking for small faces…") come through too.
let facesWorker = null, facesId = 0;
const facesWaiting = new Map();
function facesInWorker(bitmap, onStatus, pass, signal) {
  if (!facesWorker) {
    // A classic worker on purpose: MediaPipe loads its wasm loader with importScripts.
    facesWorker = new Worker(new URL("./faces-worker.js", import.meta.url));
    facesWorker.onmessage = ({ data }) => {
      const p = facesWaiting.get(data.id);
      if (!p) return;
      if (data.status) { p.onStatus?.(data.status); return; }
      facesWaiting.delete(data.id);
      if (data.aborted) p.reject(stopped());
      else if (data.error) p.reject(new Error(data.error));
      else p.resolve(data.faces);
    };
    facesWorker.onerror = (e) => {
      e.preventDefault?.();
      for (const p of facesWaiting.values()) p.reject(new Error("worker failed"));
      facesWaiting.clear();
      facesWorker = null;
    };
  }
  const id = ++facesId;
  const worker = facesWorker;
  signal?.addEventListener?.("abort", () => worker.postMessage({ stop: id }), { once: true });
  return new Promise((resolve, reject) => {
    facesWaiting.set(id, { resolve, reject, onStatus });
    worker.postMessage({ id, bitmap, pass }, [bitmap]);
  });
}

// options: { pass: "near" | "far" | "all", signal } as for findFaces.
export async function findFacesOffPage(source, onStatus, { pass = "all", signal } = {}) {
  const k = Math.min(1, WORK_MAX / Math.max(source.width, source.height));
  let faces;
  try {
    const bitmap = await createImageBitmap(source, { resizeWidth: Math.round(source.width * k), resizeHeight: Math.round(source.height * k), resizeQuality: "high" });
    faces = await facesInWorker(bitmap, onStatus, pass, signal);
  } catch (e) {
    if (e?.name === "AbortError" || signal?.aborted) throw stopped();
    return findFaces(source, onStatus, { pass, signal }); // no worker: on the page
  }
  return faces.map((b) => ({ ...b, x: b.x / k, y: b.y / k, w: Math.min(source.width, b.w / k), h: Math.min(source.height, b.h / k) }));
}

// Look again at crops 2, 2.5, 3 and 3.5 times the candidate's size, centred on it.
// A real face scores high at every size; a wheel or a pattern only now and then.
// So the median score decides (measured: faces ≥ 0.73 at each size, a car wheel ≈ 0.6).
// Returns the box from the 3× crop if a face is clearly there, otherwise null.
// The 3× and 2.5× crops go first. When both agree clearly (a sure face, or clearly nothing),
// the other two looks are skipped: their scores couldn't change the median's verdict much.
const LOOKS = [3, 2.5, 2, 3.5];
const SURE = 0.85, NONE = 0.5;

function confirm(det, img, b) {
  const scores = [];
  let box = null;
  for (const k of LOOKS) {
    const r = lookAt(det, img, b, k);
    faceStats.confirms++;
    scores.push(r ? r.score : 0);
    if (r && (k === 3 || !box)) box = r;
    if (scores.length === 2) {
      if (scores[0] >= SURE && scores[1] >= SURE) return box ? { ...box, score: Math.min(...scores) } : null;
      if (scores[0] < NONE && scores[1] < NONE) return null;
    }
  }
  scores.sort((a, c) => a - c);
  const median = (scores[1] + scores[2]) / 2;
  return median >= CONFIRM && box ? { ...box, score: median } : null;
}

function lookAt(det, img, b, k) {
  const side = Math.max(b.w, b.h) * k;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const size = Math.round(Math.min(side, 512));
  const f = size / side;
  const c = canvas(size, size);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#808080"; // outside the photo
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, (side / 2 - cx) * f, (side / 2 - cy) * f, img.width * f, img.height * f);
  let best = null;
  for (const d of det.detect(c).detections) {
    const score = d.categories?.[0]?.score ?? 0;
    const bb = d.boundingBox;
    const dx = bb.originX + bb.width / 2 - size / 2, dy = bb.originY + bb.height / 2 - size / 2;
    if (Math.hypot(dx, dy) > size * 0.25) continue; // must be the same spot
    if (!best || score > best.score) {
      best = { x: cx - side / 2 + bb.originX / f, y: cy - side / 2 + bb.originY / f, w: bb.width / f, h: bb.height / f, score };
    }
  }
  return best;
}

function grow(b, f, W, H) {
  const dx = b.w * f, dy = b.h * f;
  const x = Math.max(0, b.x - dx), y = Math.max(0, b.y - dy * 1.4);
  return { ...b, x, y, w: Math.min(W - x, b.w + 2 * dx), h: Math.min(H - y, b.h + dy * 2.4) };
}

let zxing = null;
async function loadZxing() {
  if (zxing) return zxing;
  zxing = await import(base + "zxing/reader/index.js");
  zxing.prepareZXingModule({
    overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? base + "zxing/zxing_reader.wasm" : prefix + path) },
  });
  return zxing;
}

// The reading itself runs in a worker (js/codes-worker.js); if workers can't start here, in this tab.
let codesWorker = null, codesId = 0;
const codesWaiting = new Map();
function readInWorker(image, options) {
  if (!codesWorker) {
    codesWorker = new Worker(new URL("./codes-worker.js", import.meta.url), { type: "module" });
    codesWorker.onmessage = ({ data }) => {
      const p = codesWaiting.get(data.id);
      codesWaiting.delete(data.id);
      if (data.error) p?.reject(new Error(data.error)); else p?.resolve(data.results);
    };
    codesWorker.onerror = () => {
      for (const p of codesWaiting.values()) p.reject(new Error("worker failed"));
      codesWaiting.clear();
      codesWorker = null;
    };
  }
  const id = ++codesId;
  return new Promise((resolve, reject) => {
    codesWaiting.set(id, { resolve, reject });
    codesWorker.postMessage({ id, image, options });
  });
}

export async function findCodes(source) {
  const scale = Math.min(1, 2400 / Math.max(source.width, source.height));
  const c = canvas(Math.round(source.width * scale), Math.round(source.height * scale));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  const image = ctx.getImageData(0, 0, c.width, c.height);
  const options = { tryHarder: true, maxNumberOfSymbols: 20 };
  let results;
  try {
    results = await readInWorker(image, options);
  } catch {
    results = await (await loadZxing()).readBarcodes(image, options);
  }
  return results
    .filter((r) => r.isValid)
    .map((r) => {
      const p = r.position;
      const xs = [p.topLeft.x, p.topRight.x, p.bottomLeft.x, p.bottomRight.x].map((v) => v / scale);
      const ys = [p.topLeft.y, p.topRight.y, p.bottomLeft.y, p.bottomRight.y].map((v) => v / scale);
      const x = Math.min(...xs), y = Math.min(...ys);
      const pad = Math.max(8, (Math.max(...xs) - x) * 0.12);
      return {
        kind: "code", format: r.format, text: r.text,
        x: Math.max(0, x - pad), y: Math.max(0, y - pad),
        w: Math.min(source.width, Math.max(...xs) - x + 2 * pad), h: Math.min(source.height, Math.max(...ys) - y + 2 * pad),
      };
    });
}
