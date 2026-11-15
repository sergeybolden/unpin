// Where the mascot appears and what it does there. Each scene owns one mascot in a host element
// and turns page events into states (js/mascot.js). The site (js/app.js) calls these functions.

import { createMascot, STATES } from "./mascot.js";

// Play states one after another: [[state, ms], ..., [state]]; the last one stays.
// A newer chain on the same mascot cancels the older one.
function chain(m, steps) {
  const token = (m.chainToken = (m.chainToken || 0) + 1);
  let i = 0;
  const next = () => {
    if (m.chainToken !== token || i >= steps.length) return;
    const [state, ms] = steps[i++];
    m.setState(state, { restart: true });
    if (ms != null) m.chainTimer = setTimeout(next, ms);
  };
  clearTimeout(m.chainTimer);
  next();
}
const hold = (state) => Math.round(STATES[state].dur * 1000);

// Drop frame on the home page: appears while a file is dragged over the page.
export function dropScene(host) {
  const m = createMascot(host, { state: "wide", shadow: false });
  m.setActive(false); // the frame is invisible until a file is dragged
  let off = 0;
  return {
    m,
    enter() { clearTimeout(off); m.setActive(true); chain(m, [["wide"]]); },
    // The pointer with the file, in page pixels: the eyes follow it while it is over the frame.
    over(x, y) { if (m.cur !== "wide") chain(m, [["wide"]]); m.lookAt(x, y); },
    // The file went off the frame but is still being dragged: he looks around for it.
    away() { if (m.cur !== "look") { m.lookAt(null); chain(m, [["look"]]); } },
    drop() { m.lookAt(null); chain(m, [["catch"]]); },
    // The drag is over: pause once the frame has faded out.
    end() { clearTimeout(off); off = setTimeout(() => m.setActive(false), 400); },
  };
}

// Over the photo on the work screen, while it is checked: "thinking" while the file is read, then it
// scans with the scan line over the still blurred photo; when the findings show, the photo develops
// out of the blur while it reacts (found something, all clear, or not everything could be checked)
// and fades away.
// The findings wait for the scene: longer for the first photo of the visit, shorter after that.
export function developScene(host, frame) {
  const m = createMascot(host, { state: "gone", shadow: false });
  m.setActive(false);
  const layer = host.closest(".develop") || host;
  let first = true, t = 0;
  const off = () => { layer.classList.remove("on"); m.setActive(false); };
  return {
    m,
    minMs: () => (first ? 1900 : 1100),
    start() {
      clearTimeout(t);
      layer.classList.add("on");
      m.setActive(true);
      frame.classList.add("developing");
      chain(m, [["thinking"]]);
    },
    // The picture is on the canvas (still blurred): scan it.
    photo() { chain(m, [["scan"]]); },
    // result: found | clean | partial
    // The findings are out: the photo develops while the mascot reacts and fades.
    done(result) {
      first = false;
      frame.classList.remove("developing");
      chain(m, [[result === "found" ? "found" : result === "partial" ? "shrug" : "wink", 850], ["vanish", 800], ["gone"]]);
      clearTimeout(t);
      t = setTimeout(off, 1900);
    },
    stop() { clearTimeout(t); frame.classList.remove("developing"); chain(m, [["gone"]]); off(); },
  };
}

// After a download: what the second check said. Once the ghost is gone it is paused, and
// stop() removes it when the report is replaced.
export function afterScene(host, result) {
  const m = createMascot(host, { state: result === "clean" ? "idle" : result === "bad" ? "alert" : "shrug", shadow: false });
  let t = 0;
  if (result === "clean") {
    chain(m, [["burst", hold("burst")], ["vanish", 1000], ["gone"]]); // unseen now
    t = setTimeout(() => { if (m.cur === "gone") m.setActive(false); }, hold("burst") + 1100); // nothing left to draw
  } else if (result === "bad") chain(m, [["alert", 900], ["sad"]]);
  else chain(m, [["shrug"]]);
  return { m, stop() { clearTimeout(t); chain(m, []); m.destroy(); } };
}

// The error screen: a "!" that sinks into sadness.
export function errorScene(host) {
  const m = createMascot(host, { state: "alert", shadow: true });
  return { m, show() { chain(m, [["alert", 1000], ["sad"]]); } };
}

// Under the "Questions" heading: appears out of thin air when the section comes into view, then
// ponders; when a question opens, a wink, then back to pondering. While `away` (the footer, where the
// other mascot lives) is on screen, it fades out, so only one mascot shows at a time.
export function questionsScene(host, list, { away = null } = {}) {
  const m = createMascot(host, { state: "gone", shadow: true });
  m.grabbable();
  let seen = false, hidden = false;
  const appear = () => chain(m, [["appear", hold("appear")], ["ponder"]]);
  const io = new IntersectionObserver(([e]) => {
    if (e.isIntersecting && e.intersectionRatio > 0.6 && !seen) { seen = true; if (!hidden) appear(); }
  }, { threshold: [0, 0.6, 1] });
  io.observe(host);
  if (away) {
    new IntersectionObserver(([e]) => {
      hidden = e.isIntersecting;
      if (!seen) return;
      if (hidden) chain(m, [["vanish", 900], ["gone"]]);
      else if (m.cur === "gone" || m.cur === "vanish") appear();
    }).observe(away);
  }
  list?.addEventListener("toggle", (e) => { if (e.target.open && m.cur === "ponder") chain(m, [["wink", 1300], ["ponder"]]); }, true);
  return { m, appear() { chain(m, [["gone", 400], ["appear", hold("appear")], ["ponder"]]); } };
}

// Footer: peeks from behind a letter of the big name. Looks at the last button while you point at it,
// waves when you reach the very end, dozes off when nothing happens for a while.
// host is behind the letter, handsHost in front of it.
export function footerScene(host, { handsHost = null, button = null, end = null, sleepAfter = 40000 } = {}) {
  const m = createMascot(host, { state: "peek", shadow: false, ledge: false, handsHost });
  m.grabbable();
  let waved = false, idleT = 0;
  const home = () => chain(m, [["peek"]]);
  const wake = () => {
    clearTimeout(idleT);
    if (m.cur === "sleep") chain(m, [["wide", 700], ["peek"]]);
    idleT = setTimeout(() => { if (m.cur === "peek") chain(m, [["sleep"]]); }, sleepAfter);
  };
  for (const ev of ["pointermove", "keydown", "scroll", "touchstart"]) addEventListener(ev, wake, { passive: true });
  wake();
  // At rest the eyes follow the mouse anywhere on the page (once a frame at most).
  let px = 0, py = 0, queued = false;
  addEventListener("pointermove", (e) => {
    if (e.pointerType !== "mouse" || e.buttons) return;
    px = e.clientX; py = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; m.lookAt(px, py); }); }
  }, { passive: true });
  document.documentElement.addEventListener("pointerleave", () => m.lookAt(null));
  if (button) {
    const look = () => { const b = button.getBoundingClientRect(); chain(m, [["idle"]]); m.lookAt(b.left + b.width / 2, b.top + b.height / 2); };
    for (const ev of ["pointerenter", "focus"]) button.addEventListener(ev, look);
    for (const ev of ["pointerleave", "blur"]) button.addEventListener(ev, () => { m.lookAt(null); home(); });
  }
  if (end) {
    new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !waved) { waved = true; chain(m, [["wave", 2200], ["peek"]]); }
      if (!e.isIntersecting) waved = false;
    }).observe(end);
  }
  return { m, wave() { chain(m, [["wave", 2200], ["peek"]]); }, look(x, y) { chain(m, [["idle"]]); m.lookAt(x, y); }, unlook() { m.lookAt(null); home(); }, sleep() { chain(m, [["sleep"]]); } };
}
