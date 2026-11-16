// The site's pages: each one keeps the same Content Security Policy, and the colours the
// phone shows around the page agree with the page itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const csp = (html) => html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
const PAGES = ["licenses.html", "404.html"];

test("every page has the same Content Security Policy as the main page", () => {
  const main = csp(read("index.html"));
  assert.match(main, /connect-src 'self' blob: data:;/);
  for (const page of PAGES) assert.equal(csp(read(page)), main, page);
});

test("theme colours agree with the page background", () => {
  const page = read("css/app.css").match(/--page:\s*(#[0-9a-f]{6})/i)[1].toLowerCase();
  const manifest = JSON.parse(read("manifest.webmanifest"));
  assert.equal(manifest.theme_color.toLowerCase(), page);
  assert.equal(manifest.background_color.toLowerCase(), page);
  for (const f of ["index.html", ...PAGES]) assert.equal(read(f).match(/name="theme-color" content="([^"]+)"/)[1].toLowerCase(), page, f);
});

test("the dark theme's colour agrees with the dark page background", () => {
  const dark = read("css/app.css").match(/@media \(prefers-color-scheme: dark\) \{\s*:root \{[^}]*--page:\s*(#[0-9a-f]{6})/i)[1].toLowerCase();
  for (const f of ["index.html", ...PAGES]) {
    const meta = read(f).match(/name="theme-color" content="([^"]+)" media="\(prefers-color-scheme: dark\)"/);
    assert.equal(meta?.[1].toLowerCase(), dark, f);
  }
});
