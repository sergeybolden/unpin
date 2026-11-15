import exifr from "../vendor/exifr.mjs";
import { detectFormat, stripLossless, scanC2pa, leftovers, BrokenFileError } from "./strip.js";
import { xray, nearestCity, OPTIONS, SERIAL_KEYS, OWNER_KEYS, DATE_KEYS, DEVICE_KEYS, first, saysWhere } from "./xray.js";
import { findFacesOffPage, findCodes } from "./detect.js";
import { redact, canvasToBytes } from "./redact.js";
import { imageInfo, webpMetadata } from "./inspect.js";
import { exportPlan, codeCheck } from "./plan.js";
import { drawMap } from "./map.js";
import { liveLogo } from "./logo.js";
import { dropScene, developScene, afterScene, errorScene, questionsScene, footerScene } from "./mascot-places.js";

const $ = (id) => document.getElementById(id);

// Phosphor icons from one sprite (built by scripts/icons.mjs).
const SVG = "http://www.w3.org/2000/svg";
function icon(name) {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "ic");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG, "use");
  use.setAttribute("href", `assets/icons.svg?v=b917973d#${name}`);
  svg.append(use);
  return svg;
}
function label(el, name, text) {
  const span = document.createElement("span");
  span.textContent = text;
  el.replaceChildren(icon(name), span);
}
const FINDING_ICONS = {
  location: "map-pin", place: "map-pin", time: "clock", device: "device-mobile", serial: "hash", owner: "user-circle",
  note: "note-pencil", prompt: "magic-wand", thumb: "image", extra: "stack", c2pa: "seal-check", ai: "sparkle",
};
const state = { queue: [], cur: null, op: 0, urls: [] };
const SUPPORTED = new Set(["jpeg", "png", "webp", "heic", "avif"]);
const MAX_BYTES = 80 * 1024 * 1024;
const MAX_PIXELS = 64 * 1000 * 1000;

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

// ---------- offline ----------
// The big parts are cached by the service worker the first time they are fetched.
// This button fetches them now and then checks that each one really is in the cache.
const HEAVY_FILES = [
  "vendor/mediapipe/vision_bundle.mjs", "vendor/mediapipe/wasm/vision_wasm_internal.js",
  "vendor/mediapipe/wasm/vision_wasm_internal.wasm", "vendor/mediapipe/blaze_face_short_range.tflite",
  "vendor/heic-to.js", "vendor/data/cities.json", "assets/demo/sample.jpg",
];
$("offline").addEventListener("click", async () => {
  const btn = $("offline");
  const say = (t) => { $("offline-status").textContent = t; };
  if (!("serviceWorker" in navigator) || !("caches" in window)) return say("This browser can't save the page for offline use.");
  btn.disabled = true;
  try {
    say("Preparing…");
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      btn.disabled = false;
      return say("Reload the page once, then press the button again.");
    }
    let done = 0;
    for (const f of HEAVY_FILES) {
      say(`Saving ${++done} of ${HEAVY_FILES.length}…`);
      const r = await fetch(f);
      if (!r.ok) throw new Error(f);
      await r.arrayBuffer();
    }
    const missing = [];
    for (const f of HEAVY_FILES) if (!(await caches.match(new URL(f, location.href).href, { ignoreSearch: true }))) missing.push(f);
    if (missing.length) throw new Error(missing.join(", "));
    say("Saved. Unpin now works without internet in this browser.");
  } catch {
    btn.disabled = false;
    say("Couldn't save everything. Check the connection and try again.");
  }
});

// ---------- GitHub stars ----------
// stars.json is written by the deploy workflow, so the count comes from this site, not from GitHub's API.
fetch("stars.json", { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => {
    if (!d || typeof d.stars !== "number") return;
    const n = d.stars;
    const el = $("gh-count");
    el.textContent = n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
    el.hidden = false;
  })
  .catch(() => {});

// ---------- input ----------
for (const b of document.querySelectorAll("[data-choose]")) b.addEventListener("click", () => $("file").click());

// ---------- the left column stays while the report scrolls (computers) ----------
// A column taller than the window sticks by its bottom edge instead of its top, so its end
// (the download button) is reachable: it scrolls with the page until its bottom meets the window's, then stays.
const leftCol = document.querySelector(".work .left");
function fitSticky() {
  if (!leftCol || getComputedStyle(leftCol).position !== "sticky") return;
  // Line the report up with the photo: skip the back button's row and the gap under it.
  const bar = leftCol.querySelector(".bar");
  leftCol.parentElement.style.setProperty("--bar-h", `${bar.offsetHeight + parseFloat(getComputedStyle(leftCol).rowGap || 0)}px`);
  leftCol.style.top = `${Math.min(16, window.innerHeight - leftCol.offsetHeight - 16)}px`;
}
if (leftCol) {
  new ResizeObserver(fitSticky).observe(leftCol);
  window.addEventListener("resize", fitSticky);
}

// ---------- how to use the tools: the ? in the toolbar ----------
// A popover (the browser opens and closes it: tap elsewhere, Esc). Placed before it shows, so it
// never jumps: above the toolbar by its bottom edge (its height doesn't matter then), or under
// it when there is little room above; centred on the toolbar but never past the window's sides
// (its width is fixed in css: 340 px or the window less 24 px). Scrolling closes it.
const help = $("tools-help");
help.addEventListener("beforetoggle", (e) => {
  if (e.newState !== "open") return;
  const b = toolbar.getBoundingClientRect(), gap = 10, edge = 12;
  const w = Math.min(340, window.innerWidth - 2 * edge);
  help.style.setProperty("--x", `${Math.round(Math.min(Math.max(edge, b.left + b.width / 2 - w / 2), window.innerWidth - w - edge))}px`);
  const above = b.top > 260;
  help.classList.toggle("below", !above);
  help.style.setProperty("--y", `${Math.round(above ? window.innerHeight - b.top + gap : b.bottom + gap)}px`);
});
help.addEventListener("toggle", (e) => $("help").classList.toggle("open", e.newState === "open")); // the ? stays lit while open
window.addEventListener("scroll", () => { try { if (help.matches(":popover-open")) help.hidePopover(); } catch {} }, { passive: true });

// ---------- the mascot ----------
// One mascot per place, each with its own scene (js/mascot-places.js): the drop frame, over the photo
// while it is checked, the result after a download, the error screen, under "Questions", behind the name.
const mascot = {
  drop: dropScene($("mascot-drop")),
  develop: developScene($("mascot-develop"), $("photo").parentElement),
  error: errorScene($("mascot-error")),
};
questionsScene($("mascot-faq"), $("faq"), { away: $("mascot-peek") });
// The logo in the header is alive too. A tap on it leads home from the work and error screens;
// on the home page it only bounces and scrolls back up.
liveLogo(document.querySelector(".nav .brand"), { navigate: () => document.body.classList.contains("working") });
footerScene($("mascot-peek"), { handsHost: $("mascot-peek-hands"), button: document.querySelector(".final [data-choose]"), end: $("wm-end") });

// ---------- demo on a real photo ----------
// The sample keeps its real metadata (location, time, phone), so the tool has something to find.
$("demo-try").addEventListener("click", async () => {
  const btn = $("demo-try");
  btn.disabled = true;
  try {
    const r = await fetch("assets/demo/sample.jpg");
    if (!r.ok) throw new Error();
    start([new File([await r.blob()], "IMG_1994.jpg", { type: "image/jpeg" })]);
  } catch {
    fail(state.op, "The sample photo couldn't be loaded. Check the connection and try again.");
  } finally {
    btn.disabled = false;
  }
});
$("file").addEventListener("change", (e) => start([...e.target.files]));
// Drag and drop. On the home page of a wide screen a photo goes into the left column, which
// turns into a drop frame; elsewhere there the cursor says no. On the work screen, the error
// screen and narrow screens (where the column has no box of its own) it goes anywhere.
let dragDepth = 0;
const dropZone = $("drop");
const zoneOnly = () => !$("hero").hidden && !document.body.classList.contains("working") && getComputedStyle(dropZone).display !== "contents";
const canDrop = (e) => !zoneOnly() || dropZone.contains(e.target);
const endDrag = () => { dragDepth = 0; document.body.classList.remove("dragging"); dropZone.classList.remove("over"); mascot.drop.end(); };
document.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  if (!dragDepth++) mascot.drop.enter();
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => { if (--dragDepth <= 0) endDrag(); });
document.addEventListener("dragover", (e) => {
  e.preventDefault(); // without it the browser would open the file itself
  const ok = canDrop(e);
  if (e.dataTransfer) e.dataTransfer.dropEffect = ok ? "copy" : "none";
  const over = ok && zoneOnly();
  dropZone.classList.toggle("over", over);
  // Over the frame the mascot watches the file; off it, it looks around for it.
  if (over) mascot.drop.over(e.clientX, e.clientY); else mascot.drop.away();
});
document.addEventListener("drop", (e) => {
  e.preventDefault();
  const files = canDrop(e) && e.dataTransfer?.files?.length ? [...e.dataTransfer.files] : null;
  // Dropped on the home page's frame: the mascot catches the photo before the tool opens.
  if (files && zoneOnly() && !reduceMotion.matches) {
    mascot.drop.drop();
    setTimeout(() => { endDrag(); start(files); }, 450);
    return;
  }
  endDrag();
  if (files) start(files);
});
document.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) start(files);
});
$("again").addEventListener("click", () => {
  if (state.queue.length) return open(state.queue.shift());
  home();
});
$("error-again").addEventListener("click", () => { home(); $("file").click(); });

function home() {
  state.op++;
  mascot.develop.stop();
  state.cur?.farStop?.(); // the background face search is for this photo only
  state.cur = null;
  showFarStatus();
  document.body.classList.remove("working");
  $("result").hidden = true;
  $("error").hidden = true;
  $("hero").hidden = false;
  $("file").value = "";
}

function start(files) {
  if (!files.length) return;
  state.queue = files.slice(1);
  open(files[0]);
}

// ---------- states ----------
// ---------- motion ----------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
// The scan line starts at the top with the check and always finishes its pass to the bottom
// (at least one), so a fast phone still sees a whole sweep. It never delays the results:
// they appear underneath while it finishes. SWEEP_MS is the pass in css/app.css (sweep, 1.15 s).
const SWEEP_MS = 1150;
// The findings appear no sooner than the mascot's scene over the photo needs after a photo is
// opened (1.9 s the first time, 1.1 s after that; purely for the eye: the work is already done;
// with "reduce motion" they appear at once).
let scanStart = 0, scanTimer = 0;
function setScanning(on) {
  const frame = $("photo").parentElement;
  clearTimeout(scanTimer);
  if (on) {
    if (!frame.classList.contains("scanning")) scanStart = performance.now();
    frame.classList.add("scanning");
  } else {
    const passed = performance.now() - scanStart;
    const left = Math.max(1, Math.ceil(passed / SWEEP_MS)) * SWEEP_MS - passed;
    if (left > 0 && !reduceMotion.matches) scanTimer = setTimeout(() => frame.classList.remove("scanning"), left);
    else frame.classList.remove("scanning");
  }
}
// If the frame still changes size during the check (a file without its size in the header),
// the line starts its pass again from the top, over the new size.
{
  const frame = $("photo").parentElement, line = frame.querySelector(".scanline");
  let box = "";
  new ResizeObserver(() => {
    const now = `${frame.clientWidth}x${frame.clientHeight}`;
    if (now === box) return;
    box = now;
    if (!frame.classList.contains("scanning")) return;
    line.classList.add("restart");
    void line.offsetWidth; // let the browser see the line without its animation once
    line.classList.remove("restart");
    scanStart = performance.now();
  }).observe(frame);
}
// The photo tools stay hidden while a photo is checked: the status line stands in their place.
// When everything is found and the photo develops, they hop in.
const toolbar = document.querySelector(".editor .toolbar");
function showTools(on) {
  toolbar.classList.toggle("waiting", !on);
  toolbar.classList.toggle("hop", on);
}
// Mark list items so they come in one after another.
function enter(el, i) {
  el.classList.add("enter");
  el.style.setProperty("--i", String(i));
}

function setPhase(cur, phase, text) {
  cur.phase = phase;
  const busy = phase === "reading" || phase === "scanning";
  $("status").classList.toggle("busy", busy);
  setScanning(busy);
  const btn = $("clean");
  btn.disabled = phase !== "ready" && phase !== "partial";
  label(btn, "download-simple", phase === "partial" ? "Remove the data and download (picture not checked)" : phase === "ready" ? "Remove it and download" : "Checking the photo…");
  if (text != null) $("status").textContent = text;
  if (cur === state.cur) showFarStatus();
}

function fail(id, message) {
  if (id !== state.op) return;
  state.cur?.farStop?.();
  state.cur = null;
  showFarStatus();
  mascot.develop.stop();
  setScanning(false);
  $("status").classList.remove("busy");
  $("result").hidden = true;
  $("error").hidden = false;
  $("error-text").textContent = message;
  mascot.error.show();
  $("error-again").focus();
}

// ---------- open a photo ----------
async function open(file) {
  const id = ++state.op;
  for (const u of state.urls) URL.revokeObjectURL(u);
  state.urls = [];
  state.cur?.farStop?.(); // the previous photo's background face search
  state.cur = null;
  showFarStatus();
  document.body.classList.add("working");
  $("hero").hidden = true;
  $("error").hidden = true;
  $("result").hidden = false;
  window.scrollTo({ top: 0 });
  showView("report");
  setShowOriginal(false);
  drag = null; // the chosen tool stays, like in an editor
  $("filename").textContent = file.name;
  $("queue").textContent = state.queue.length ? `· ${state.queue.length} more waiting` : "";
  if (state.queue.length) label($("again"), "arrow-right", "Next photo");
  else label($("again"), "arrow-left", "Another photo");
  $("verdict").textContent = "Checking the photo…";
  $("report").classList.add("pending");
  const opened = performance.now();
  $("findings").innerHTML = "";
  $("marks").innerHTML = "";
  $("mapwrap").hidden = true;
  $("map-spot").hidden = true;
  $("format-note").textContent = "";
  $("photo").getContext("2d").clearRect(0, 0, $("photo").width, $("photo").height);
  $("overlay").getContext("2d").clearRect(0, 0, $("overlay").width, $("overlay").height);
  $("clean").disabled = true;
  label($("clean"), "download-simple", "Checking the photo…");
  $("status").textContent = "Reading the file…";
  $("status").classList.add("busy");
  showTools(false);
  setScanning(true);
  const reveal = mascot.develop.minMs();
  mascot.develop.start();

  try {
    if (file.size > MAX_BYTES) throw new Error(`This file is ${Math.round(file.size / 1e6)} MB. Unpin opens photos up to 80 MB.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (id !== state.op) return;
    const format = detectFormat(bytes);
    if (!SUPPORTED.has(format)) throw new Error("This doesn't look like a JPEG, PNG, WebP, HEIC or AVIF photo.");

    // Size from the header first: a small file can still be a huge picture.
    const head = imageInfo(bytes, format);
    if (head) checkPixels(head.width, head.height);

    // What exifr reads. WebP metadata goes through a JPEG shell, because exifr can't read WebP.
    let metaSrc = bytes;
    let metaPartial = false;
    if (format === "webp") {
      const m = webpMetadata(bytes);
      metaSrc = m ? m.bytes : null;
      metaPartial = !!m?.partial;
    }

    let orientation = 1;
    if (metaSrc) try { orientation = (await exifr.orientation(metaSrc)) || 1; } catch {}
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) orientation = 1; // 1–8 are the only turns there are
    if (id !== state.op) return;
    // The photo's shape before decoding. EXIF turns of 90° (orientation 5–8) swap the sides;
    // HEIC and AVIF sizes are already turned (their own irot box).
    if (head) {
      const turned = orientation >= 5 && format !== "heic" && format !== "avif";
      sizeFrame(turned ? head.height : head.width, turned ? head.width : head.height);
    }

    let preview = null;
    let brokenNote = "";
    try {
      preview = await stripLossless(bytes, format, { orientation });
    } catch (e) {
      preview = null;
      if (e instanceof BrokenFileError) brokenNote = `${e.message}. The picture will be saved again instead of cleaned in place.`;
    }
    // PNG and WebP keep no rotation flag after cleaning; re-save turned pictures upright instead.
    if (preview && format !== "jpeg" && orientation !== 1) preview = null;

    const src = await decode(file, format, id, orientation);
    if (id !== state.op) return;

    const animated = !!(head?.animated || preview?.animated);
    const cur = {
      id, file, bytes, format, preview, src, shown: src, regions: [], info: null, orientation, brokenNote, rev: 0,
      alpha: !!head?.alpha, animated, metaPartial,
    };
    state.cur = cur;
    setPhase(cur, "reading", "Reading what the file says…");
    paint();
    mascot.develop.photo();

    cur.info = await xray(file, bytes, format, preview, metaSrc);
    if (id !== state.op) return;
    if (cur.info.thumbUrl) state.urls.push(cur.info.thumbUrl);
    // The findings come out together, once the picture has been looked at too.
    // Until then the panel shows placeholders, long enough for the scene, so the work is visible.
    await scan(cur);
    if (id !== state.op) return;
    const wait = reveal - (performance.now() - opened);
    if (wait > 0 && !reduceMotion.matches) await new Promise((r) => setTimeout(r, wait));
    if (id !== state.op) return;
    const found = personal(cur.info.findings).length > 0 || cur.regions.some((r) => r.kind === "face" || r.kind === "code");
    mascot.develop.done(found ? "found" : cur.scanned ? "clean" : "partial");
    showTools(true); // the photo develops now; the tools hop in as it does
    $("report").classList.remove("pending"); // first, so the map can measure its width
    await renderFindings(cur);
    if (id !== state.op) return;
    renderPicture(cur);
    cur.done?.();
    $("verdict").focus();
  } catch (e) {
    fail(id, e.message || "This photo couldn't be opened.");
  }
}

// Does this browser turn a picture by its EXIF flag while decoding it? Every browser does for JPEG;
// for PNG and WebP they differ (Chrome turns PNG but not WebP). So each is tried once on a 2×1
// picture flagged "turn 90°": it comes out 1×2 only if the browser turns it.
// HEIC and AVIF are turned by their own irot box, never by EXIF.
const TURN_PROBE = {
  png: "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAGmVYSWZNTQAqAAAACAABARIAAwAAAAEABgAAAAAAANZnS2kAAAANSURBVHicY/jPAAT/AQcAAf/iI55ZAAAAAElFTkSuQmCC",
  webp: "UklGRlIAAABXRUJQVlA4WAoAAAAIAAAAAQAAAAAAVlA4TBEAAAAvAQAAAA8Q87//8x8OMqL/AQBFWElGGgAAAE1NACoAAAAIAAEBEgADAAAAAQAGAAAAAAAA",
};
const turnsItself = {};
function browserTurns(format) {
  if (!TURN_PROBE[format]) return Promise.resolve(true);
  return (turnsItself[format] ??= (async () => {
    try {
      const bytes = Uint8Array.from(atob(TURN_PROBE[format]), (c) => c.charCodeAt(0));
      const b = await createImageBitmap(new Blob([bytes], { type: `image/${format}` }));
      const turned = b.height > b.width;
      b.close?.();
      return turned;
    } catch {
      return true; // can't tell: leave the picture as the browser shows it
    }
  })());
}

// Draw a picture upright by its EXIF orientation (2–8: mirrored and/or turned).
function drawUpright(c, bitmap, o) {
  const w = bitmap.width, h = bitmap.height;
  c.width = o >= 5 ? h : w;
  c.height = o >= 5 ? w : h;
  const g = c.getContext("2d");
  const m = { 2: [-1, 0, 0, 1, w, 0], 3: [-1, 0, 0, -1, w, h], 4: [1, 0, 0, -1, 0, h], 5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, h, 0], 7: [0, -1, -1, 0, h, w], 8: [0, -1, 1, 0, 0, w] }[o];
  if (m) g.transform(...m);
  g.drawImage(bitmap, 0, 0); // an animation gives its first frame
}

async function decode(file, format, id, orientation = 1) {
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file); // turned by EXIF in some browsers and formats, see above
  } catch {
    if (format === "heic") {
      if (id === state.op) $("status").textContent = "Opening a HEIC photo (loads a 3 MB decoder once)…";
      const { heicTo } = await import("../vendor/heic-to.js");
      const jpeg = await heicTo({ blob: file, type: "image/jpeg", quality: 0.95 });
      bitmap = await createImageBitmap(jpeg);
    } else {
      throw new Error("This browser can't open this picture. It may be damaged.");
    }
  }
  // Check again before the full-size canvas: HEIC and AVIF sizes are only known now.
  try {
    checkPixels(bitmap.width, bitmap.height);
  } catch (e) {
    bitmap.close?.();
    throw e;
  }
  const c = document.createElement("canvas");
  const turn = orientation !== 1 && !(await browserTurns(format)) ? orientation : 1;
  drawUpright(c, bitmap, turn);
  bitmap.close?.();
  return c;
}

function checkPixels(width, height) {
  if (width * height > MAX_PIXELS) throw new Error(`This picture is ${Math.round((width * height) / 1e6)} megapixels. Unpin opens up to 64.`);
}

// ---------- drawing ----------
// The photo shows the result as it will be saved; the overlay shows the boxes.
// Every change to the boxes goes through here, so a check report of an earlier version is marked stale.
function refreshPreview() {
  const cur = state.cur;
  if (!cur) return;
  cur.rev++;
  const active = cur.regions.filter((r) => r.on);
  cur.shown = active.length ? redact(cur.src, active) : cur.src;
  paint();
  renderFormatNote(cur);
  renderPicture(cur); // the "3 of 4 blurred" count follows your changes
  // A check report describes the earlier version: put the findings back instead.
  if (!$("after").hidden) {
    showView("report");
    $("status").textContent = "You changed the boxes after the download. Press the button again to save and check this version.";
  }
}

let showOriginal = false;
// How much a w×h picture is scaled down in the editor. Tall photos fit the window, so the toolbar
// and the download button under them stay in view (on phones the button is stuck to the bottom
// of the screen anyway).
function fitScale(w, h) {
  // Full screen: the whole window less room for the × above and the tools below; a small photo
  // is shown up to twice its size, so a small sign is easier to box.
  if (fsOn) return Math.min(2, (window.innerWidth - 32) / w, (window.innerHeight - 168) / h);
  const maxW = Math.max(200, $("stage").clientWidth || 620);
  const below = window.matchMedia("(max-width: 860px)").matches ? 270 : 360;
  const maxH = Math.max(300, Math.min(640, viewH - below));
  return Math.min(1, maxW / w, maxH / h);
}
// The frame takes the photo's shape as soon as the file's header gives its size, before the
// picture is decoded (seconds for a big HEIC). So the scan line starts over the whole photo:
// Safari works out the line's path in pixels once, when it starts.
function sizeFrame(w, h) {
  const s = fitScale(w, h);
  for (const c of [$("photo"), $("overlay")]) {
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
  }
}
function paint() {
  const cur = state.cur;
  if (!cur) return;
  const { src, regions } = cur;
  const shown = showOriginal ? src : cur.shown || src;
  const photo = $("photo"), overlay = $("overlay");
  const scale = fitScale(src.width, src.height);
  cur.scale = scale;
  for (const c of [photo, overlay]) {
    c.width = Math.round(src.width * scale);
    c.height = Math.round(src.height * scale);
  }
  photo.getContext("2d").drawImage(shown, 0, 0, photo.width, photo.height);
  const ctx = overlay.getContext("2d");
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  const colors = { face: "#e8a23a", code: "#e5484d", hand: "#3b82f6" };
  const now = performance.now();
  let moving = false;
  for (const r of regions) {
    // A found box "locks on": it shrinks from a little larger onto its place and fades in.
    let e = 1;
    if (r.born && !reduceMotion.matches) {
      const t = Math.min(1, Math.max(0, (now - r.born) / POP_MS));
      if (t < 1) moving = true;
      e = 1 - (1 - t) ** 3;
    }
    if (e <= 0) continue;
    const grow = 1 + 0.35 * (1 - e);
    const w = r.w * scale * grow, h = r.h * scale * grow;
    const x = (r.x + r.w / 2) * scale - w / 2, y = (r.y + r.h / 2) * scale - h / 2;
    ctx.globalAlpha = e;
    if (e < 1) {
      ctx.fillStyle = colors[r.kind];
      ctx.globalAlpha = 0.25 * (1 - e);
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = e;
    }
    ctx.strokeStyle = colors[r.kind];
    ctx.lineWidth = r === cur.selected ? 4 : 2;
    ctx.setLineDash(r.on ? [] : [6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
  }
  // The chosen box gets corner handles with the Move tool: drag one to resize.
  const sel = cur.selected;
  if (sel && tool === "move" && regions.includes(sel)) {
    const hs = cssPx(4.5);
    ctx.setLineDash([]);
    ctx.lineWidth = Math.max(1.5, cssPx(1.5));
    ctx.strokeStyle = colors[sel.kind];
    ctx.fillStyle = "#fff";
    for (const [hx, hy] of [[sel.x, sel.y], [sel.x + sel.w, sel.y + sel.h], [sel.x, sel.y + sel.h]]) { // top-right: the × is there
      ctx.fillRect(hx * scale - hs, hy * scale - hs, hs * 2, hs * 2);
      ctx.strokeRect(hx * scale - hs, hy * scale - hs, hs * 2, hs * 2);
    }
  }
  if (moving && !popFrame) popFrame = requestAnimationFrame(() => { popFrame = 0; paint(); });
  placeMarks(cur); // boxes moved with the keyboard take their buttons along
}
const POP_MS = 380;
let popFrame = 0;

// The window height the photo is fitted to. On a phone the height changes while you scroll
// (Safari's address bar hides and shows), and refitting then made the photo grow and shrink;
// so on touch screens only a change of width (turning the phone) refits it.
let viewW = window.innerWidth, viewH = window.innerHeight;
const touchScreen = matchMedia("(pointer: coarse)");
window.addEventListener("resize", () => {
  if (touchScreen.matches && window.innerWidth === viewW) return;
  viewW = window.innerWidth;
  viewH = window.innerHeight;
  paint();
});

// Toolbar buttons are icons only; their name goes to the tooltip and to screen readers.
function setTool(btn, iconName, name) {
  btn.replaceChildren(icon(iconName));
  btn.setAttribute("aria-label", name);
  btn.dataset.tip = name;
}

function setShowOriginal(on) {
  showOriginal = on;
  $("original").setAttribute("aria-pressed", String(on));
  setTool($("original"), on ? "eye-slash" : "eye", on ? "Show the clean version" : "Show the original");
}
$("original").addEventListener("click", () => {
  setShowOriginal(!showOriginal);
  paint();
});

// ---------- tools: Move and Box, like in a photo editor ----------
// One tool is always chosen, and its button stays highlighted.
// Move (default): drag a box to move it, drag a corner of the chosen box to resize it,
//   click a box to choose it (its × shows), click elsewhere to let go.
// Box: drag on the photo to add a box; the tool stays on for the next one.
// Canvas pixels can differ from CSS pixels on small screens, hence toCanvas.
let tool = "move";
let drag = null; // { mode: "draw" | "move" | "resize", from, r, start, corner }
const overlay = $("overlay");
const toCanvas = (e) => {
  const r = overlay.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * overlay.width) / r.width, y: ((e.clientY - r.top) * overlay.height) / r.height };
};
const cssPx = (n) => (n * overlay.width) / (overlay.getBoundingClientRect().width || overlay.width);

// Which corner handle of the chosen box is under the pointer: 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left.
function cornerAt(p) {
  const cur = state.cur, r = cur?.selected;
  if (!r || tool !== "move") return -1;
  const s = cur.scale, m = cssPx(12);
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]];
  // The top-right corner is under the box's × button, so only the other three resize.
  return pts.findIndex(([x, y], i) => i !== 1 && Math.abs(p.x - x * s) <= m && Math.abs(p.y - y * s) <= m);
}
function insideBox(p) {
  const cur = state.cur;
  if (!cur) return null;
  const s = cur.scale;
  for (let i = cur.regions.length - 1; i >= 0; i--) {
    const r = cur.regions[i];
    if (p.x >= r.x * s && p.x <= (r.x + r.w) * s && p.y >= r.y * s && p.y <= (r.y + r.h) * s) return r;
  }
  return null;
}
function choose(r) {
  const cur = state.cur;
  cur.selected = r;
  cur.pinned = r;
  showButtons(cur);
  paint();
}

overlay.addEventListener("pointerdown", (e) => {
  const cur = state.cur;
  if (!cur) return;
  const p = toCanvas(e);
  overlay.setPointerCapture(e.pointerId);
  if (tool === "box") { drag = { mode: "draw", from: p }; return; }
  const corner = cornerAt(p);
  if (corner >= 0) { drag = { mode: "resize", from: p, r: cur.selected, start: { ...cur.selected }, corner }; return; }
  const r = insideBox(p);
  if (r) { choose(r); drag = { mode: "move", from: p, r, start: { ...r } }; }
  else { choose(null); drag = null; }
});

overlay.addEventListener("pointermove", (e) => {
  const cur = state.cur;
  if (!cur) return;
  const p = toCanvas(e);
  if (!drag) {
    if (e.pointerType === "mouse") setHover(regionAt(p));
    const c = cornerAt(p);
    overlay.style.cursor = tool === "box" ? "crosshair" : c === 0 || c === 2 ? "nwse-resize" : c >= 0 ? "nesw-resize" : insideBox(p) ? "move" : "default";
    return;
  }
  const s = cur.scale, W = cur.src.width, H = cur.src.height;
  const dx = (p.x - drag.from.x) / s, dy = (p.y - drag.from.y) / s;
  if (drag.mode === "draw") {
    paint();
    const ctx = overlay.getContext("2d");
    ctx.strokeStyle = "#3b82f6";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(drag.from.x, drag.from.y, p.x - drag.from.x, p.y - drag.from.y);
    return;
  }
  const { r, start } = drag;
  if (drag.mode === "move") {
    r.x = clamp(start.x + dx, 0, W - start.w);
    r.y = clamp(start.y + dy, 0, H - start.h);
  } else {
    // Resize: the opposite corner stays where it is.
    const ax = drag.corner === 0 || drag.corner === 3 ? start.x + start.w : start.x;
    const ay = drag.corner < 2 ? start.y + start.h : start.y;
    const bx = clamp((drag.corner === 0 || drag.corner === 3 ? start.x : start.x + start.w) + dx, 0, W);
    const by = clamp((drag.corner < 2 ? start.y : start.y + start.h) + dy, 0, H);
    const min = 8 / s;
    r.x = Math.min(ax, bx); r.y = Math.min(ay, by);
    r.w = Math.max(min, Math.abs(bx - ax)); r.h = Math.max(min, Math.abs(by - ay));
  }
  drag.moved = true;
  livePreview();
});

overlay.addEventListener("pointerup", (e) => {
  const cur = state.cur;
  if (!cur || !drag) return;
  const d = drag;
  drag = null;
  if (d.mode === "draw") {
    const s = cur.scale, p = toCanvas(e);
    const box = { kind: "hand", on: true, x: Math.min(d.from.x, p.x) / s, y: Math.min(d.from.y, p.y) / s, w: Math.abs(p.x - d.from.x) / s, h: Math.abs(p.y - d.from.y) / s };
    if (box.w > 6 && box.h > 6) { addRegion(box); choose(box); }
    else { choose(insideBox(p)); } // a tap with the Box tool still chooses a box
    return;
  }
  if (d.moved) refreshPreview(); // a real change: re-blur, and an earlier check report goes stale
});
overlay.addEventListener("pointerleave", () => setHover(null));
// Touch: the page scrolls under a swipe on the photo (touch-action in css), except where the
// finger grabs something. Cancelling touchstart there keeps the drag on the box instead.
overlay.addEventListener("touchstart", (e) => {
  if (!state.cur || e.touches.length !== 1) return;
  const p = toCanvas(e.touches[0]);
  if (tool === "box" || cornerAt(p) >= 0 || insideBox(p)) e.preventDefault();
}, { passive: false });
// The browser took the swipe for a scroll: drop whatever drag had begun.
overlay.addEventListener("pointercancel", () => { drag = null; });

// While dragging, redraw the blur at most once a frame.
let liveFrame = 0;
function livePreview() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => {
    liveFrame = 0;
    const cur = state.cur;
    if (!cur) return;
    const active = cur.regions.filter((r) => r.on);
    cur.shown = active.length ? redact(cur.src, active) : cur.src;
    paint();
  });
}

// The × buttons stay hidden until you point at a box, so they don't cover small boxes.
// Mouse: hovering the box (or the button's corner) shows it. Touch: tapping the box shows it.
// Keyboard: the button shows when it, or your box, has focus (css).
function regionAt(p) {
  const cur = state.cur;
  if (!cur || !p) return null;
  const s = cur.scale;
  const m = (16 * overlay.width) / (overlay.getBoundingClientRect().width || overlay.width); // reach the corner button
  for (let i = cur.regions.length - 1; i >= 0; i--) {
    const r = cur.regions[i];
    const x = r.x * s, y = r.y * s, w = r.w * s, h = r.h * s;
    const inBox = p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
    const atCorner = Math.abs(p.x - (x + w)) <= m && Math.abs(p.y - y) <= m; // where its × sits
    if (inBox || atCorner) return r;
  }
  return null;
}
function setHover(r) {
  const cur = state.cur;
  if (!cur || cur.hover === r) return;
  cur.hover = r;
  showButtons(cur);
}
function setPinned(r) {
  const cur = state.cur;
  if (!cur) return;
  cur.pinned = cur.pinned === r ? null : r;
  showButtons(cur);
}
function showButtons(cur) {
  for (const r of cur.regions) r.el?.btn.classList.toggle("show", r === cur.hover || r === cur.pinned);
}

function selectTool(name) {
  tool = name;
  $("tool-move").setAttribute("aria-pressed", String(name === "move"));
  $("addbox").setAttribute("aria-pressed", String(name === "box"));
  $("stage").classList.toggle("drawing", name === "box"); // the photo is outlined while the Box tool is on
  overlay.style.cursor = name === "box" ? "crosshair" : "default";
  paint(); // corner handles show only with the Move tool
}
$("tool-move").addEventListener("click", () => selectTool("move"));
// From the keyboard (no pointer, so click.detail is 0) there is nothing to drag with:
// the Box button then puts a box in the middle, which the arrow keys move and resize.
$("addbox").addEventListener("click", (e) => {
  const cur = state.cur;
  if (!cur) return;
  if (e.detail === 0) {
    const w = cur.src.width * 0.3, h = cur.src.height * 0.2;
    addRegion({ kind: "hand", on: true, x: (cur.src.width - w) / 2, y: (cur.src.height - h) / 2, w, h }, true);
    return;
  }
  selectTool("box");
});
// Editor keys: V = Move, B = Box, F = full screen, Esc = out of full screen, else back to Move.
// Not while typing in a field.
document.addEventListener("keydown", (e) => {
  if (!state.cur || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === "Escape") { if (fsOn) setFullscreen(false); else selectTool("move"); }
  else if (e.key === "v" || e.key === "V") selectTool("move");
  else if (e.key === "b" || e.key === "B") selectTool("box");
  else if ((e.key === "f" || e.key === "F") && !$("result").hidden) setFullscreen(!fsOn);
});

// ---------- full screen ----------
// The photo fills the window on a dark ground, the tools float over it at the bottom and a ×
// sits top right: the same tools, just a bigger photo for drawing boxes on small things.
// It fills the browser window, over the page; it doesn't ask for the browser's own full screen
// (the owner's choice). Out: ×, Esc, F, the button, or Back on a phone.
let fsOn = false;
function setFullscreen(on, fromHistory = false) {
  if (on === fsOn || (on && !state.cur)) return;
  fsOn = on;
  document.body.classList.toggle("fullscreen", on);
  $("fullscreen").setAttribute("aria-pressed", String(on));
  setTool($("fullscreen"), on ? "corners-in" : "corners-out", on ? "Exit full screen (F)" : "Full screen (F)");
  try { if (help.matches(":popover-open")) help.hidePopover(); } catch {}
  if (on && !fromHistory) history.pushState({ unpinFullscreen: true }, ""); // Back closes it
  if (!on && !fromHistory && history.state?.unpinFullscreen) history.back();
  paint();
}
$("fullscreen").addEventListener("click", () => setFullscreen(!fsOn));
$("fs-close").addEventListener("click", () => setFullscreen(false));
window.addEventListener("popstate", () => { if (fsOn) setFullscreen(false, true); });
// A double click on the photo (outside a box, with the arrow tool) opens it too.
overlay.addEventListener("dblclick", (e) => {
  if (tool === "move" && state.cur && !insideBox(toCanvas(e))) setFullscreen(!fsOn);
});

function addRegion(box, focus = false) {
  state.cur.regions.push(box);
  state.cur.selected = box;
  refreshPreview(); // also updates the format note: a box means a re-saved picture
  renderRegions();
  if (focus) box.el?.area.focus();
}

// ---------- findings ----------
function infoItem(iconName, title, text, level = "low") {
  const li = document.createElement("li");
  li.className = `finding ${level}`;
  li.innerHTML = `<span class="finding-ic"></span><div><strong></strong><p></p></div>`;
  li.querySelector(".finding-ic").append(icon(iconName));
  li.querySelector("strong").textContent = title;
  li.querySelector("p").textContent = text;
  return li;
}

// "VN" → "Vietnam", from the browser's own list of country names (no download, works offline).
// Falls back to the code where the browser doesn't have the list.
let regionNames = null;
function countryName(code) {
  try {
    regionNames ||= new Intl.DisplayNames(["en"], { type: "region" });
    return regionNames.of(code) || code;
  } catch {
    return code;
  }
}

// The AI check is always in the list; only what the file says about you counts as "personal".
const personal = (findings) => findings.filter((f) => f.id !== "ai");

function verdictFor(cur) {
  const { findings, readError, aiReport: ai } = cur.info;
  const mine = personal(findings);
  const people = cur.scanned && cur.regions.some((r) => r.kind === "face" || r.kind === "code");
  const madeByAi = ai && (ai.kind === "created" || ai.kind === "edited");
  if (mine.some((f) => f.id === "location" || f.id === "place")) return "This photo gives away where you were";
  if (mine.some((f) => f.level === "high")) return "This photo gives away personal details";
  if (madeByAi) return ai.kind === "created" ? "This picture was made with AI" : "This picture was edited with AI";
  if (mine.length) return "What this photo tells";
  if (readError || cur.metaPartial) return "Unpin couldn't read the hidden data";
  if (people) return "What the picture shows";
  return "Nothing personal in the file";
}

// What the face and code finder saw, as one item next to what the file says.
function renderPicture(cur) {
  const ul = $("findings");
  const old = ul.querySelector(".picture");
  if (!cur.scanned) return;
  const faces = cur.regions.filter((r) => r.kind === "face");
  const codes = cur.regions.filter((r) => r.kind === "code");
  const where = cur.animated ? " in the first frame" : "";
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  // The far pass (farFaces) may still be running, or may have failed: say so.
  const far = cur.farBusy ? " Still looking for small faces far away." : cur.farProblem ? " Small faces far away couldn't be looked for: check the photo." : "";
  let li;
  if (!faces.length && !codes.length) {
    li = infoItem("smiley", `No faces or codes found${where}`, `Signs, plates and landmarks aren't found automatically: blur them with a box.${far}`);
  } else {
    const what = [faces.length && plural(faces.length, "face", "faces"), codes.length && plural(codes.length, "code", "codes")].filter(Boolean).join(" and ");
    const off = [...faces, ...codes].filter((r) => !r.on).length;
    const done = [faces.length && `${faces.filter((r) => r.on).length} of ${faces.length} blurred`, codes.length && `${codes.filter((r) => r.on).length} of ${codes.length} covered`].filter(Boolean).join(", ");
    const all = !codes.length ? "Blurred" : !faces.length ? "Covered" : "Blurred and covered";
    const text = `${off ? done : all}. Signs, plates and landmarks are up to you.${far}`;
    li = infoItem(faces.length ? "smiley" : "qr-code", `${what[0].toUpperCase()}${what.slice(1)} on the picture${where}`, text, "medium");
  }
  li.classList.add("picture");
  if (old) old.replaceWith(li);
  else { enter(li, ul.children.length); ul.append(li); }
  $("verdict").textContent = verdictFor(cur);
}

async function renderFindings(cur) {
  const { findings, readError, removedBlocks } = cur.info;
  const ul = $("findings");
  ul.innerHTML = "";
  const unreadable = readError || cur.metaPartial;
  $("verdict").textContent = verdictFor(cur);
  // "Couldn't read" and "removed without reading" are said out loud, never shown as "nothing there".
  if (unreadable) {
    const blocks = removedBlocks.length ? ` (${removedBlocks.join(", ")})` : "";
    ul.append(infoItem("question", readError ? "Some hidden data couldn't be read" : "Part of the hidden data is too large to read",
      `It's removed anyway${blocks}, but Unpin can't tell you what was in it.`));
  } else if (!personal(findings).length && !["created", "edited"].includes(cur.info.aiReport?.kind)) {
    // Not for a generated picture: it has no place or camera to give away.
    ul.append(infoItem("info", "No location, time, device or names found",
      removedBlocks.length ? `Unpin still removes these blocks: ${removedBlocks.join(", ")}. Check the picture itself.` : "Check the picture itself."));
  }
  for (const f of findings) {
    if (f.id === "location") continue; // told on the map above the list
    const li = document.createElement("li");
    li.className = `finding ${f.level}`;
    li.innerHTML = `<span class="finding-ic"></span><div><strong></strong><p></p></div>`;
    if (f.logo) {
      // The tool's own logo, as its Content Credentials carry it. In an <img> an SVG runs nothing.
      const url = URL.createObjectURL(new Blob([f.logo.bytes], { type: f.logo.type }));
      state.urls.push(url);
      const img = Object.assign(document.createElement("img"), { src: url, alt: "", className: "finding-logo" });
      li.querySelector(".finding-ic").append(img);
      li.classList.add("has-logo");
    } else li.querySelector(".finding-ic").append(icon(f.icon || FINDING_ICONS[f.id] || "info"));
    li.querySelector("strong").textContent = f.title;
    li.querySelector("p").textContent = f.text;
    if (f.tip) li.title = f.tip;
    if (f.thumbUrl) {
      const img = document.createElement("img");
      img.src = f.thumbUrl;
      img.alt = "Hidden preview stored in the file";
      img.className = "thumb";
      li.querySelector("div").append(img);
    }
    // "Made with AI" leads the list; "no AI label" stays where it is, at the end.
    if (f.id === "ai" && f.level !== "low") ul.prepend(li);
    else ul.append(li);
  }
  [...ul.children].forEach((li, i) => enter(li, i + 1)); // after the map, which comes in first
  enter($("mapwrap"), 0);
  const loc = findings.find((f) => f.id === "location");
  if (loc) {
    $("mapwrap").hidden = false;
    $("map-coords").textContent = loc.text;
    $("near").hidden = true;
    const spot = await drawMap($("map"), loc.lat, loc.lon);
    $("map-spot").style.setProperty("--x", `${(spot.x * 100).toFixed(2)}%`);
    $("map-spot").style.setProperty("--y", `${(spot.y * 100).toFixed(2)}%`);
    $("map-spot").hidden = false;
    if (state.cur !== cur) return;
    const near = await nearestCity(loc.lat, loc.lon);
    if (state.cur !== cur) return;
    if (near) {
      const place = `${near.name}, ${countryName(near.cc)}`;
      $("near").textContent = near.km < 1 ? `In ${place}` : `About ${near.km < 10 ? near.km.toFixed(1) : Math.round(near.km)} km from ${place}`;
      $("near").hidden = false;
    }
  }
  renderFormatNote(cur);
}

function planFor(cur) {
  return exportPlan({ format: cur.format, lossless: !!cur.preview, animated: cur.animated, alpha: cur.alpha, covering: cur.regions.some((r) => r.on) });
}

function renderFormatNote(cur) {
  const notes = [];
  const covering = cur.regions.some((r) => r.on);
  const plan = planFor(cur);
  const out = plan.outFormat.toUpperCase();
  if (cur.brokenNote) notes.push(cur.brokenNote);
  if (cur.animated) notes.push(`This is an animation. Unpin checks only the first frame, so it saves only that frame, as a still ${out}.`);
  else if (!cur.preview) {
    if (cur.format === "heic" || cur.format === "avif") notes.push(`${cur.format.toUpperCase()} is saved as JPEG: it can't be cleaned in place.`);
    else if (cur.orientation !== 1 && cur.format !== "jpeg") notes.push(`This picture is turned by a flag that cleaning removes, so it's saved upright as a new ${out}.`);
  } else if (covering) {
    notes.push(`Covered areas are drawn into a new ${out} file.`);
  } else {
    notes.push("The picture itself is not re-compressed.");
  }
  if (plan.mode === "redraw" && cur.format === "webp" && !cur.animated) notes.push(cur.alpha ? "Transparency is kept (saved as PNG)." : "WebP is saved as JPEG.");
  $("format-note").textContent = notes.join(" ");
}

// ---------- scan the picture ----------
async function scan(cur) {
  const live = () => state.cur === cur;
  const status = (t) => live() && ($("status").textContent = t);
  setPhase(cur, "scanning", "Looking for faces and codes…");
  // Codes and faces at the same time (each in its own worker); each one's boxes lock on as soon
  // as it is done. Faces in two passes: the near one now, the far one then in the background.
  const found = (boxes) => {
    const t0 = performance.now();
    cur.regions.push(...boxes.map((b, i) => ({ ...b, on: true, born: t0 + i * 90 })));
    refreshPreview();
    renderRegions();
  };
  let codesProblem = null, facesProblem = null;
  await Promise.all([
    findCodes(cur.src).then((codes) => { if (live()) found(codes); }, (e) => { codesProblem = e; }),
    findFacesOffPage(cur.src, status, { pass: "near" }).then((faces) => {
      if (!live()) return;
      found(faces);
      cur.far = farFaces(cur);
    }, (e) => { facesProblem = e; }),
  ]);
  if (!live()) return;
  const problem = codesProblem && facesProblem ? `couldn't look for codes (${codesProblem.message}) and faces`
    : codesProblem ? `couldn't look for codes (${codesProblem.message})`
    : facesProblem ? `couldn't look for faces (${facesProblem.message})` : null;
  renderFormatNote(cur);
  cur.codesProblem = !!codesProblem; // carried into the check of the saved file
  cur.facesProblem = !!facesProblem;
  cur.scanned = !problem; // the result is shown with the rest of the findings (open)
  // open() switches to this once the findings are on screen, so the button and the panel agree.
  cur.done = problem
    ? () => setPhase(cur, "partial", `This browser ${problem}. Cover anything you need by hand before you download.`)
    : () => setPhase(cur, "ready", ""); // the result is in the findings; the status line clears
}

// The far pass: small faces in a crowd or far off. It runs in the background while the report
// is out and the tools are in your hands; a face it finds gets its box (locking on, like the
// others) unless a box is already there. A line under the tools says it's still looking; the
// download waits for it, so nothing is saved before every face has been looked for. Opening
// another photo, or going home, stops it. Never rejects: a failure is said in the report.
function farFaces(cur) {
  const ctrl = new AbortController();
  cur.farStop = () => ctrl.abort();
  cur.farBusy = true;
  showFarStatus();
  return findFacesOffPage(cur.src, null, { pass: "far", signal: ctrl.signal })
    .then((found) => {
      if (state.cur !== cur) return;
      const fresh = found.filter((f) => !cur.regions.some((r) => r.kind === "face" && sameFace(r, f)));
      if (!fresh.length) return;
      const t0 = performance.now();
      cur.regions.push(...fresh.map((f, i) => ({ ...f, on: true, born: t0 + i * 90 })));
      refreshPreview();
      renderRegions();
    })
    .catch((e) => {
      if (e?.name !== "AbortError" && state.cur === cur) cur.farProblem = true;
    })
    .finally(() => {
      cur.farBusy = false;
      cur.far = null;
      if (state.cur !== cur) return;
      showFarStatus();
      renderPicture(cur);
    });
}
// The same face found twice (once near, once far): boxes overlapping by a third, or one's centre
// inside the other.
function sameFace(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inside = (p, q) => p.x + p.w / 2 >= q.x && p.x + p.w / 2 <= q.x + q.w && p.y + p.h / 2 >= q.y && p.y + p.h / 2 <= q.y + q.h;
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h) > 0.33 || inside(a, b) || inside(b, a);
}
// "Still looking for faces far away…" under the tools, while the far pass runs and the tools are out.
function showFarStatus() {
  const cur = state.cur;
  $("far-status").hidden = !(cur?.farBusy && (cur.phase === "ready" || cur.phase === "partial"));
}

// Each box on the photo gets a small button at its corner (#marks, on top of the canvases).
// Faces and codes: × stops covering it (the box turns dashed) and ↺ brings the cover back.
// The box stays in the list either way: the final check needs to know a code was kept on purpose.
// Your own boxes: × deletes the box. They can also be focused and moved with the keyboard.
function renderRegions() {
  const cur = state.cur;
  const marks = $("marks");
  const focused = document.activeElement?.closest?.("#marks") ? document.activeElement.dataset.key : null;
  marks.innerHTML = "";
  if (!cur) return;
  const n = { face: 0, code: 0, hand: 0 };
  for (const r of cur.regions) {
    n[r.kind]++;
    r.key ||= `${r.kind}-${Math.random().toString(36).slice(2, 8)}`;
    const name = r.kind === "face" ? `face ${n.face}` : r.kind === "code" ? `${r.format} “${shorten(r.text)}”` : `your box ${n.hand}`;

    const area = document.createElement("div");
    area.className = `mark-area ${r.kind}${r.on ? "" : " off"}`;
    if (r.kind === "hand") {
      // Keyboard: arrows move the box, Shift + arrows resize it, Delete removes it.
      area.tabIndex = 0;
      area.dataset.key = `${r.key}-area`;
      area.setAttribute("role", "group");
      area.setAttribute("aria-label", `${name[0].toUpperCase()}${name.slice(1)}. Arrow keys move it, Shift and arrow keys resize it, Delete removes it.`);
      area.addEventListener("focus", () => { cur.selected = r; paint(); });
      area.addEventListener("blur", () => { if (cur.selected === r) { cur.selected = null; paint(); } });
      area.addEventListener("keydown", (e) => {
        const step = Math.max(4, Math.round(cur.src.width * 0.02));
        const k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
        if (k) {
          e.preventDefault();
          if (e.shiftKey) { r.w = Math.max(8, r.w + k[0] * step); r.h = Math.max(8, r.h + k[1] * step); }
          else { r.x = clamp(r.x + k[0] * step, 0, cur.src.width - r.w); r.y = clamp(r.y + k[1] * step, 0, cur.src.height - r.h); }
          refreshPreview();
        } else if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault();
          removeRegion(r);
        }
      });
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `box-x ${r.kind}${r.on ? "" : " off"}`;
    btn.dataset.key = `${r.key}-btn`;
    const what = r.kind === "hand" ? `Remove ${name}` : r.on ? `Keep ${name} visible` : `${r.kind === "face" ? "Blur" : "Cover"} ${name} again`;
    btn.setAttribute("aria-label", what);
    btn.title = what;
    btn.append(icon(r.kind !== "hand" && !r.on ? "arrow-counter-clockwise" : "x"));
    btn.addEventListener("click", () => {
      if (r.kind === "hand") return removeRegion(r);
      r.on = !r.on;
      refreshPreview();
      renderRegions();
    });
    btn.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse") setHover(r); });
    btn.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") setHover(null); });

    r.el = { area, btn };
    marks.append(area, btn);
  }
  placeMarks(cur);
  showButtons(cur);
  if (focused) marks.querySelector(`[data-key="${focused}"]`)?.focus();
}

// Positions in % of the picture, so the buttons stay on their boxes at any size.
function placeMarks(cur) {
  for (const r of cur.regions) {
    if (!r.el) continue;
    for (const el of [r.el.area, r.el.btn]) {
      el.style.setProperty("--x", `${(r.x / cur.src.width) * 100}%`);
      el.style.setProperty("--y", `${(r.y / cur.src.height) * 100}%`);
      el.style.setProperty("--w", `${(r.w / cur.src.width) * 100}%`);
      el.style.setProperty("--h", `${(r.h / cur.src.height) * 100}%`);
    }
  }
}

function removeRegion(r) {
  const cur = state.cur;
  cur.regions = cur.regions.filter((x) => x !== r);
  if (cur.selected === r) cur.selected = null;
  if (cur.hover === r) cur.hover = null;
  if (cur.pinned === r) cur.pinned = null;
  refreshPreview();
  renderRegions();
}

const clamp = (v, a, b) => Math.min(Math.max(v, a), Math.max(a, b));
const shorten = (t) => (t && t.length > 34 ? t.slice(0, 34) + "…" : t || "");

// ---------- clean, check, download ----------
$("clean").addEventListener("click", async () => {
  const cur = state.cur;
  if (!cur || (cur.phase !== "ready" && cur.phase !== "partial")) return;
  const btn = $("clean");
  btn.disabled = true;
  // Nothing is saved before every face has been looked for: finish the far pass first.
  if (cur.far) {
    label(btn, "download-simple", "Finishing the face search…");
    await cur.far;
    if (state.cur !== cur) return;
  }
  label(btn, "download-simple", "Cleaning and checking…");
  // Work on a frozen copy of the boxes: edits made while saving can't change what gets checked.
  const rev = cur.rev;
  const regions = cur.regions.map((r) => ({ ...r }));
  const active = regions.filter((r) => r.on);
  const plan = planFor(cur);
  const outFormat = plan.outFormat;
  let bytes;
  try {
    if (plan.mode === "lossless") {
      bytes = cur.preview.bytes;
    } else {
      const canvas = active.length ? redact(cur.src, active) : cur.src;
      bytes = await canvasToBytes(canvas, `image/${outFormat}`);
      // A browser may add blocks of its own when saving; keep only the picture.
      try { bytes = (await stripLossless(bytes, outFormat)).bytes; } catch {}
    }
  } catch (e) {
    if (state.cur === cur) setPhase(cur, cur.phase, `Couldn't save the picture: ${e.message}`);
    return;
  }
  if (state.cur !== cur) return;
  const ext = { jpeg: "jpg", png: "png", webp: "webp" }[outFormat];
  const base = $("keepname").checked ? cur.file.name.replace(/\.[^.]+$/, "") : "photo";
  const name = `${base}-unpinned.${ext}`;
  const blob = new Blob([bytes], { type: `image/${outFormat}` });
  const checks = await verify(blob, bytes, outFormat, regions, { codes: !cur.codesProblem, faces: !cur.facesProblem, far: !cur.farProblem });
  if (state.cur !== cur) return;
  setPhase(cur, cur.phase);
  if (cur.rev !== rev) {
    showView("report");
    $("status").textContent = "You changed the boxes while Unpin was checking, so nothing was downloaded. Press the button again.";
    return;
  }
  const bad = checks.some((c) => c.result === "bad");
  $("status").textContent = ""; // a "you changed the boxes" hint is about the earlier version
  showChecks(checks, bad, blob, name);
  if (!bad) download(blob, name);
});

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

// Re-read the file that will be saved: metadata from its bytes, codes from its decoded pixels.
// Each check is "ok", "bad" or "unknown" (couldn't check) — never a silent pass.
// `searched` says which searches of the photo worked: one that failed is a "couldn't check" here
// too, so the report never says "checked" about a picture that wasn't fully looked at.
async function verify(blob, bytes, outFormat, regions, searched) {
  const checks = [];
  const active = regions.filter((r) => r.on);
  // WebP goes through the same JPEG shell as on reading; no EXIF/XMP chunk at all means nothing to find.
  let src = blob;
  if (outFormat === "webp") {
    const m = webpMetadata(bytes);
    src = m ? m.bytes : null;
  }
  let meta = null;
  if (src) { try { meta = (await exifr.parse(src, OPTIONS)) || {}; } catch { meta = null; } }
  else meta = {};
  const field = (name, test) => checks.push({ name, result: meta === null ? "unknown" : test(meta) ? "bad" : "ok" });
  field("Location", saysWhere);
  field("Time taken", (m) => DATE_KEYS.some((k) => m[k]));
  field("Phone or camera", (m) => DEVICE_KEYS.some((k) => m[k]));
  field("Serial numbers and names", (m) => !!(first(m, SERIAL_KEYS) || first(m, OWNER_KEYS)));
  let thumb = src ? "unknown" : "ok";
  if (src) { try { thumb = (await exifr.thumbnail(src)) ? "bad" : "ok"; } catch {} }
  checks.push({ name: "Hidden preview picture", result: thumb });
  checks.push({ name: "Content Credentials (C2PA)", result: scanC2pa(bytes).present ? "bad" : "ok" });
  // Not only the fields Unpin knows: any block that isn't part of the picture fails the check.
  let extra = "unknown";
  try { extra = (await leftovers(bytes, outFormat)).length ? "bad" : "ok"; } catch {}
  checks.push({ name: "Other data in the file", result: extra });
  const codeRegions = regions.filter((r) => r.kind === "code");
  if (codeRegions.length) {
    const check = { name: "Readable codes", result: "unknown" };
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      bmp.close?.();
      const left = await findCodes(c);
      const r = codeCheck(codeRegions.filter((x) => !x.on), left);
      check.result = r.result;
      if (r.result === "kept") check.note = `${r.kept} left readable, as you chose`;
    } catch {}
    checks.push(check);
  } else if (!searched.codes) checks.push({ name: "QR codes and barcodes", result: "unknown" });
  if (!searched.faces) checks.push({ name: "Faces", result: "unknown" });
  else if (!searched.far) checks.push({ name: "Small faces far away", result: "unknown" });
  if (active.some((r) => r.kind === "face")) checks.push({ name: "Faces", result: "info", note: "blurred (not re-checked)" });
  if (active.some((r) => r.kind === "hand")) checks.push({ name: "Your boxes", result: "info", note: "blurred" });
  return checks;
}

// The right panel shows one of two things: what the original file says ("report"),
// or, after a download, the check of the saved file ("after") in its place.
function showView(view) {
  $("report").hidden = view !== "report";
  $("after").hidden = view !== "after";
  if (view === "report") clearAfter();
  // The main button matches what is on screen: a fresh check, or the same file again.
  const cur = state.cur;
  if (view === "after") label($("clean"), "download-simple", "Download again");
  else if (cur?.phase) setPhase(cur, cur.phase);
}

// The check report goes away with its mascot, so no animation keeps running for it.
let afterMascot = null;
function clearAfter() {
  afterMascot?.stop();
  afterMascot = null;
  $("after").innerHTML = "";
}

function showChecks(checks, bad, blob, name) {
  const out = $("after");
  clearAfter();
  const unknown = checks.some((c) => c.result === "unknown");
  const title = document.createElement("h2");
  title.tabIndex = -1;
  title.textContent = bad ? "Something is still in the file" : unknown ? "Downloaded, mostly checked" : "Downloaded and checked";
  const sub = document.createElement("p");
  sub.className = "after-sub";
  sub.textContent = bad
    ? "It was not downloaded. Here is what Unpin found in the saved file."
    : unknown
      ? `Saved as ${name}. Some checks couldn't run in this browser.`
      : `Saved as ${name}. Unpin read it again:`;
  const ul = document.createElement("ul");
  const words = { ok: ["check-circle", "gone"], bad: ["x-circle", "still there"], unknown: ["question", "couldn't check"], kept: ["info", ""] };
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = c.result === "kept" ? "info" : c.result;
    if (c.result === "info" || c.result === "kept") label(li, "info", `${c.name}: ${c.note}`);
    else label(li, words[c.result][0], `${c.name}: ${words[c.result][1]}`);
    enter(li, ul.children.length);
    ul.append(li);
  }
  out.append(title, sub, ul);
  // The mascot in the corner: a clean file bursts its data away and the ghost fades out of sight,
  // you're not on the map now; something left in the file makes it sad; unchecked parts, a shrug.
  const host = document.createElement("span");
  host.className = "mascot mascot-after";
  host.setAttribute("aria-hidden", "true");
  out.append(host);
  afterMascot = afterScene(host, bad ? "bad" : unknown ? "unknown" : "clean");
  const actions = document.createElement("div");
  actions.className = "after-actions";
  if (bad) {
    const again = document.createElement("button");
    again.type = "button";
    again.className = "btn btn-gray btn-sm";
    label(again, "download-simple", "Download anyway");
    again.addEventListener("click", () => download(blob, name));
    actions.append(again);
  }
  const back = document.createElement("button");
  back.type = "button";
  back.className = "btn btn-gray btn-sm";
  label(back, "arrow-left", "What the original said");
  back.addEventListener("click", () => { showView("report"); $("verdict").focus(); });
  actions.append(back);
  out.append(actions);
  showView("after");
  title.focus();
}
