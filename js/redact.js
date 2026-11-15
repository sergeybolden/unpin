// Cover regions on the picture, like street-level map photos: faces get a soft oval smear,
// boxes drawn by hand a soft rectangular one that covers the whole box.
// QR codes and barcodes get a solid box: a blurred code can sometimes still be scanned.
export function redact(source, regions) {
  const c = document.createElement("canvas");
  c.width = source.width;
  c.height = source.height;
  const ctx = c.getContext("2d");
  ctx.drawImage(source, 0, 0);
  for (const r of regions) {
    const x = Math.round(r.x), y = Math.round(r.y), w = Math.round(r.w), h = Math.round(r.h);
    if (w < 2 || h < 2) continue;
    if (r.kind === "face") smear(ctx, x, y, w, h, "oval");
    else if (r.kind === "hand") smear(ctx, x, y, w, h, "rect");
    else solid(ctx, x, y, w, h);
  }
  return c;
}

const COVER = "#16181d";

function solid(ctx, x, y, w, h) {
  ctx.fillStyle = COVER;
  ctx.fillRect(x, y, w, h);
}

const canvas = (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h });
const FILTER = typeof CanvasRenderingContext2D !== "undefined" && "filter" in CanvasRenderingContext2D.prototype;

// The smear is an oval inside the face box. The box is the found face grown by a quarter on each
// side (detect.js), so it is 1.5 faces wide: an oval of 0.78 half-box still reaches ~17% past the
// face on every side. It is fully opaque up to CORE and fades out by EDGE, inside the box,
// so faces close together stay separate instead of merging into one blur.
const CORE = 0.78;
const EDGE = 0.95;
// Detail is destroyed first: the area is shrunk until it is CELLS pixels across. Nothing finer
// survives, so no sharpening can bring it back. Then it is smoothed and lightly grained.
const CELLS = 7;

function smear(ctx, x, y, w, h, shape) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const cx = x + w / 2, cy = y + h / 2;
  // An oval fits inside the face box; a rectangle covers the whole box and fades out just past it.
  const pad = shape === "rect" ? Math.max(4, Math.round(Math.min(w, h) * 0.15)) : 0;
  const rx = shape === "rect" ? w / 2 + pad : (w / 2) * EDGE;
  const ry = shape === "rect" ? h / 2 + pad : (h / 2) * EDGE;
  const ax = Math.max(0, Math.floor(cx - rx)), ay = Math.max(0, Math.floor(cy - ry));
  const aw = Math.min(W, Math.ceil(cx + rx)) - ax, ah = Math.min(H, Math.ceil(cy + ry)) - ay;
  if (aw < 2 || ah < 2) return;

  // 1. Shrink: a few pixels per face, with noise, so averaging can't recover anything.
  // On a solid backdrop, so the smear is opaque even over a transparent picture: laid over the
  // original, a see-through smear would leave the original's outline in the alpha channel.
  const k = CELLS / Math.max(w, h);
  const tiny = canvas(Math.max(2, Math.round(aw * k)), Math.max(2, Math.round(ah * k)));
  const tctx = tiny.getContext("2d", { willReadFrequently: true });
  tctx.imageSmoothingQuality = "high";
  tctx.fillStyle = COVER;
  tctx.fillRect(0, 0, tiny.width, tiny.height);
  tctx.drawImage(ctx.canvas, ax, ay, aw, ah, 0, 0, tiny.width, tiny.height);
  const t = tctx.getImageData(0, 0, tiny.width, tiny.height);
  for (let i = 0; i < t.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    t.data[i] += n; t.data[i + 1] += n; t.data[i + 2] += n;
  }
  tctx.putImageData(t, 0, 0);

  // 2. Grow back smoothly. This layer is fully opaque and already has no detail.
  const base = canvas(aw, ah);
  const bctx = base.getContext("2d");
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  bctx.drawImage(tiny, 0, 0, aw, ah);

  // 3. Soften the leftover cell pattern into a smear (where the browser supports canvas blur).
  const soft = canvas(aw, ah);
  const sctx = soft.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(base, 0, 0); // under the blur, so its faded edges show this, never the original
  if (FILTER) {
    sctx.filter = `blur(${Math.max(3, Math.round(Math.max(w, h) / 9))}px)`;
    sctx.drawImage(base, 0, 0);
    sctx.filter = "none";
  }
  // A fine grain, so the smear looks like part of the photo rather than a sticker.
  const s = sctx.getImageData(0, 0, aw, ah);
  for (let i = 0; i < s.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 8;
    s.data[i] += n; s.data[i + 1] += n; s.data[i + 2] += n;
  }
  sctx.putImageData(s, 0, 0);

  // 4. Keep only the shape, with a soft edge, and lay it on the photo.
  sctx.globalCompositeOperation = "destination-in";
  if (shape === "rect") sctx.drawImage(rectMask(aw, ah, x - ax, y - ay, w, h, pad), 0, 0);
  else {
    sctx.save();
    sctx.translate(cx - ax, cy - ay);
    sctx.scale(1, ry / rx);
    const g = sctx.createRadialGradient(0, 0, 0, 0, 0, rx);
    g.addColorStop(0, "#000");
    g.addColorStop(CORE / EDGE, "#000");
    g.addColorStop(1, "rgba(0,0,0,0)");
    sctx.fillStyle = g;
    sctx.fillRect(-rx, -rx, rx * 2, rx * 2);
    sctx.restore();
  }
  ctx.drawImage(soft, ax, ay);
}

// Fully opaque over the whole box, fading out over `pad` pixels around it.
function rectMask(aw, ah, bx, by, bw, bh, pad) {
  const m = canvas(aw, ah);
  const mctx = m.getContext("2d");
  mctx.fillStyle = "#000";
  if (FILTER) {
    mctx.filter = `blur(${Math.max(1, Math.round(pad / 2))}px)`;
    mctx.fillRect(bx - pad / 2, by - pad / 2, bw + pad, bh + pad);
    mctx.filter = "none";
  }
  mctx.fillRect(bx, by, bw, bh); // the box itself is never see-through
  return m;
}

export function canvasToBytes(canvas, type) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(async (blob) => (blob ? resolve(new Uint8Array(await blob.arrayBuffer())) : reject(new Error("Could not save the image"))), type, 0.92),
  );
}
