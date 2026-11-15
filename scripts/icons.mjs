// Build assets/icons.svg: one sprite with the Phosphor icons the page uses (bold weight).
// Usage: npm run icons. Pages reference them as <svg><use href="assets/icons.svg#name"/></svg>.
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const WEIGHT = "bold";
const NAMES = [
  // findings and demo
  "map-pin", "clock", "device-mobile", "camera", "drone", "hash", "user-circle", "note-pencil", "magic-wand", "image", "stack", "seal-check",
  "smiley", "car-profile", "mountains", "qr-code", "bridge", "boat", "file-image", "file-x", "barcode",
  // actions and states
  "upload-simple", "download-simple", "arrow-left", "arrow-right", "selection-plus", "cursor", "eye", "eye-slash", "corners-out", "corners-in", "trash", "x", "arrow-counter-clockwise",
  "check-circle", "x-circle", "question", "info", "shield-check", "wifi-slash", "sparkle", "scan", "lightbulb",
  // clues
  "signpost", "house-line", "app-window", "sunglasses", "package", "monitor", "key",
  // other weights: "name:weight" becomes the symbol "name-weight"
  "map-pin:fill",
];

const symbols = NAMES.map((entry) => {
  const [name, weight = WEIGHT] = entry.split(":");
  const file = join("node_modules/@phosphor-icons/core/assets", weight, `${name}-${weight}.svg`);
  const svg = readFileSync(file, "utf8");
  const inner = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  const id = weight === WEIGHT ? name : `${name}-${weight}`;
  return `<symbol id="${id}" viewBox="0 0 256 256">${inner}</symbol>`;
});
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor">\n<!-- Phosphor Icons (${WEIGHT}), MIT, https://phosphoricons.com -->\n${symbols.join("\n")}\n</svg>\n`;
writeFileSync("assets/icons.svg", sprite);
copyFileSync("node_modules/@phosphor-icons/core/LICENSE", "vendor/LICENSES/phosphor-icons-MIT.txt");

// Browsers keep <use> sprites in memory for long: a new icon set needs a new URL.
// Every reference gets ?v=<hash of the sprite>, so pages never mix new markup with old icons.
const v = createHash("sha256").update(sprite).digest("hex").slice(0, 8);
for (const file of ["index.html", "js/app.js"]) {
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/assets\/icons\.svg(\?v=[0-9a-f]+)?#/g, `assets/icons.svg?v=${v}#`));
}
console.log(`icons ok: ${NAMES.length}, version ${v}`);
