// A small offline map: Natural Earth land outlines. No map server ever sees the location.
// The pin and its pulsing circle are page elements on top (index.html, #map-spot);
// drawMap returns where they go, as fractions of the map's width and height.
let land = null;

export async function drawMap(canvas, lat, lon) {
  if (!land) land = await (await fetch(new URL("../vendor/data/land.json", import.meta.url))).json();
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 520;
  const H = canvas.clientHeight || 260;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  const spanLon = 56;
  const spanLat = spanLon * (H / W) / Math.max(0.35, Math.cos((lat * Math.PI) / 180));
  const x0 = lon - spanLon / 2, y0 = lat + spanLat / 2;
  const px = (lo) => ((lo - x0) / spanLon) * W;
  const py = (la) => ((y0 - la) / spanLat) * H;

  ctx.fillStyle = color("--map-sea");
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = color("--map-land");
  ctx.strokeStyle = color("--map-coast");
  ctx.lineWidth = 0.8;
  for (const ring of land) {
    // Draw each ring in the copy of the world closest to the pin.
    for (const shift of [-360, 0, 360]) {
      ctx.beginPath();
      ring.forEach(([lo, la], i) => (i ? ctx.lineTo(px(lo + shift), py(la)) : ctx.moveTo(px(lo + shift), py(la))));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  return { x: px(lon) / W, y: py(lat) / H };
}
