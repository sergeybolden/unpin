// The logo in the header: the brand mark itself (assets/favicon.svg, drawn inline so its parts can
// move), quietly alive. It blinks; its eyes follow the mouse, or another mascot while one is
// playing (the drop frame, over the photo); on hover the yellow bar strikes the pin out again;
// a tap squashes it; five quick taps burst it into bits and it comes back.
// The tab icon and the app icon stay the plain file. With "reduce motion" it stays still.

import { reducedMotion } from "./mascot.js";

const NS = "http://www.w3.org/2000/svg";
const BODY = "M 30 6 C 40.72 6, 49.79 14.52, 49.79 24.82 C 49.79 30.72, 47.29 36.39, 43.09 42.41 C 39.56 47.52, 35 53.74, 31.58 57.27 C 30.61 58.24, 29.39 58.24, 28.42 57.27 C 25 53.74, 20.44 47.52, 16.91 42.41 C 12.71 36.39, 10.21 30.72, 10.21 24.82 C 10.21 14.52, 19.28 6, 30 6 Z";
const EYES = { x: 30, y: 21 }; // between the eyes, in the 64-unit box
const BITS = 7;

// host: an element to draw into (it replaces an <img> of the logo if there is one).
// link: what the taps count on. navigate: follow the link after the tap's bounce (on the work
// screen); on the home page a tap only scrolls back up.
export function liveLogo(host, { link = host.closest("a"), navigate = () => true } = {}) {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 64 64");
  svg.setAttribute("class", "logo-svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.innerHTML = `<rect width="64" height="64" rx="16" fill="#171630"/>
<g class="lg-bits" fill="#ffffff">${'<circle r="2.6" cx="30" cy="30"/>'.repeat(BITS)}</g>
<g class="lg-pin"><path d="${BODY}" fill="#ffffff"/>
<g class="lg-eyes" fill="#171630"><rect class="lg-eye" x="18" y="14" width="8" height="14" rx="4"/><rect class="lg-eye" x="34" y="14" width="8" height="14" rx="4"/></g></g>
<path class="lg-bar" d="M 18.05 54.22 L 53.24 29.22" pathLength="1" stroke="#ffdd00" stroke-width="10" stroke-linecap="round" fill="none"/>`;
  const img = host.querySelector("img");
  if (img) img.replaceWith(svg); else host.append(svg);
  // Each bit flies its own way when it bursts.
  [...svg.querySelectorAll(".lg-bits circle")].forEach((c, i) => {
    const a = (i / BITS) * Math.PI * 2 + 0.4;
    c.style.setProperty("--dx", `${Math.cos(a) * 26}px`);
    c.style.setProperty("--dy", `${Math.sin(a) * 26}px`);
  });
  if (reducedMotion()) return { svg };

  const eyes = svg.querySelector(".lg-eyes");
  const look = (x, y) => {
    const b = svg.getBoundingClientRect();
    if (!b.width) return;
    const k = 64 / b.width;
    const dx = (x - (b.left + EYES.x / k)) * k, dy = (y - (b.top + EYES.y / k)) * k;
    const d = Math.hypot(dx, dy) || 1, reach = Math.min(1, d / 220);
    eyes.style.setProperty("--lx", `${((dx / d) * 3.2 * reach).toFixed(2)}px`);
    eyes.style.setProperty("--ly", `${((dy / d) * 2.6 * reach).toFixed(2)}px`);
  };
  const center = () => { eyes.style.setProperty("--lx", "0px"); eyes.style.setProperty("--ly", "0px"); };

  // Another mascot playing on screen gets its attention (one pair of eyes on the pointer at a time).
  const friend = () => document.querySelector(".develop.on .mascot, body.dragging:not(.working) .drop-hint .mascot");
  let px = null, py = null, queued = false;
  const update = () => {
    queued = false;
    const f = friend();
    if (f) { const r = f.getBoundingClientRect(); look(r.left + r.width / 2, r.top + r.height / 2); }
    else if (px != null) look(px, py);
    else center();
  };
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse") return;
    px = e.clientX; py = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(update); }
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => { px = py = null; update(); });
  setInterval(() => { if (!document.hidden && friend()) update(); }, 250);

  // Blinks, now and then, sometimes twice.
  const blink = () => {
    svg.classList.remove("blink");
    void svg.getBoundingClientRect(); // restart the animation
    svg.classList.add("blink");
    setTimeout(blink, Math.random() < 0.18 ? 260 : 2200 + Math.random() * 3800);
  };
  setTimeout(blink, 1500 + Math.random() * 2000);

  // Taps: a bounce, then the link (if it leads anywhere); five quick ones burst it.
  const play = (name, ms) => {
    svg.classList.remove(name);
    void svg.getBoundingClientRect();
    svg.classList.add(name);
    setTimeout(() => svg.classList.remove(name), ms);
  };
  let taps = 0, tapT = 0, goT = 0;
  link?.addEventListener("click", (e) => {
    if (e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // new tab and such: as usual
    e.preventDefault();
    clearTimeout(tapT);
    clearTimeout(goT);
    taps++;
    tapT = setTimeout(() => (taps = 0), 600);
    if (taps >= 5) { taps = 0; play("burst", 1700); return; }
    play("poke", 450);
    if (navigate()) goT = setTimeout(() => { location.href = link.href; }, 380);
    else scrollTo({ top: 0, behavior: "smooth" });
  });
  return { svg, look };
}
