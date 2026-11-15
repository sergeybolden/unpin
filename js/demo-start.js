// Hold the hero demo animation until the photo is on screen (on a phone it is below the fold).
// Loaded in <head> without defer, so the hold is in place before the first paint and the scan
// line never starts and stops halfway. Without this script the animation just plays on load.
(() => {
  if (!("IntersectionObserver" in window)) return;
  const root = document.documentElement;
  root.classList.add("demo-wait");
  document.addEventListener("DOMContentLoaded", () => {
    const photo = document.querySelector(".demo-photo");
    if (!photo) return root.classList.remove("demo-wait");
    // Most of the photo, card included, must be in view; a photo taller than the screen
    // counts as seen once it fills most of the screen.
    const share = Math.min(0.9, (0.9 * window.innerHeight) / Math.max(1, photo.offsetHeight));
    new IntersectionObserver((entries, io) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      root.classList.remove("demo-wait");
      io.disconnect();
    }, { threshold: share }).observe(photo);
  });
})();
