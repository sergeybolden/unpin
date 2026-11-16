// PNG text chunks: tEXt, zTXt and iTXt, read to the spec, with unpacking capped. Run: npm test
// The PNGs are built here: base.png with text chunks added after IHDR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { pngTexts, xray, PNG_TEXT_MAX, PNG_TEXT_TOTAL } from "../js/xray.js";
import { aiReport } from "../js/ai.js";

const base = new Uint8Array(readFileSync(new URL("./fixtures/base.png", import.meta.url)));
const enc = (s) => new TextEncoder().encode(s);
const latin1 = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type, data) => cat(u32(data.length), enc(type), data, u32(crc32(cat(enc(type), data))));
const IHDR_END = 8 + 25;
const png = (...chunks) => cat(base.subarray(0, IHDR_END), ...chunks, base.subarray(IHDR_END));
const zip = (b) => new Uint8Array(deflateSync(b));

const tEXt = (key, text) => chunk("tEXt", cat(latin1(key), [0], latin1(text)));
const zTXt = (key, data) => chunk("zTXt", cat(latin1(key), [0, 0], data));
const iTXt = (key, text, { compressed = false, lang = "", tkey = "" } = {}) =>
  chunk("iTXt", cat(latin1(key), [0, compressed ? 1 : 0, 0], enc(lang), [0], enc(tkey), [0], compressed ? zip(enc(text)) : enc(text)));

const SD = "a lighthouse at dusk, oil painting\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 1234, Size: 512x512, Model: sd_xl_base_1.0";

test("tEXt: keyword and Latin-1 text", async () => {
  const t = await pngTexts(png(tEXt("Author", "Zoë Example"), tEXt("Comment", "hello")));
  assert.deepEqual(t, { Author: "Zoë Example", Comment: "hello" });
});

test("tEXt holding UTF-8 is read as UTF-8", async () => {
  const t = await pngTexts(png(chunk("tEXt", cat(latin1("Title"), [0], enc("Café ☕")))));
  assert.equal(t.Title, "Café ☕");
});

test("zTXt with Stable Diffusion parameters: prompt finding and generator", async () => {
  const bytes = png(zTXt("parameters", zip(latin1(SD))));
  const t = await pngTexts(bytes);
  assert.equal(t.parameters, SD);
  const r = aiReport({ png: t });
  assert.equal(r.kind, "created");
  assert.equal(r.tool, "Stable Diffusion");
  assert.equal(r.detail, "model sd_xl_base_1.0");

  const { findings, aiReport: report } = await xray(new Blob([bytes]), bytes, "png", null, null);
  const prompt = findings.find((f) => f.id === "prompt");
  assert.ok(prompt, "prompt finding");
  assert.ok(prompt.text.startsWith("a lighthouse at dusk"));
  assert.equal(report.tool, "Stable Diffusion");
});

test("iTXt, uncompressed, with a language tag and translated keyword", async () => {
  const t = await pngTexts(png(iTXt("Description", "Ein Leuchtturm 🌅", { lang: "de-DE", tkey: "Beschreibung" })));
  assert.deepEqual(t, { Description: "Ein Leuchtturm 🌅" });
});

test("iTXt, compressed, with a language tag", async () => {
  const t = await pngTexts(png(iTXt("parameters", SD, { compressed: true, lang: "en", tkey: "Parameters" })));
  assert.equal(t.parameters, SD);
  assert.equal(aiReport({ png: t }).tool, "Stable Diffusion");
});

test("a repeated keyword: the last one wins", async () => {
  const t = await pngTexts(png(tEXt("Author", "first"), zTXt("Author", zip(latin1("second")))));
  assert.equal(t.Author, "second");
});

test("a truncated chunk is skipped, earlier ones are kept", async () => {
  const good = tEXt("Author", "kept");
  const cut = tEXt("Comment", "x".repeat(100)).subarray(0, 40);
  const t = await pngTexts(cat(base.subarray(0, IHDR_END), good, cut));
  assert.deepEqual(t, { Author: "kept" });
  // A length that claims more than the file holds.
  const liar = cat(u32(0x7fffffff), enc("tEXt"), latin1("Author\0x"));
  assert.deepEqual(await pngTexts(cat(base.subarray(0, IHDR_END), liar)), {});
});

test("a zlib bomb hits the cap and is skipped", async () => {
  const bomb = zip(new Uint8Array(64 << 20)); // 64 MB of zeros in about 64 KB
  assert.ok(bomb.length < 100_000);
  const bytes = png(tEXt("Author", "kept"), zTXt("Comment", bomb), chunk("iTXt", cat(latin1("parameters"), [0, 1, 0, 0, 0], bomb)));
  const t = await pngTexts(bytes);
  assert.equal(t.Author, "kept");
  assert.equal(t.Comment, undefined);
  assert.equal(t.parameters, undefined);
  // Just over the cap is skipped too; just under it is read.
  assert.equal((await pngTexts(png(zTXt("a", zip(new Uint8Array(PNG_TEXT_MAX + 1)))))).a, undefined);
  assert.equal((await pngTexts(png(zTXt("a", zip(new Uint8Array(PNG_TEXT_MAX)))))).a.length, PNG_TEXT_MAX);
});

test("the total cap stops unpacking once the texts add up", async () => {
  const full = zip(new Uint8Array(PNG_TEXT_MAX));
  const keys = Array.from({ length: PNG_TEXT_TOTAL / PNG_TEXT_MAX + 1 }, (_, i) => `k${i}`);
  const t = await pngTexts(png(...keys.map((k) => zTXt(k, full)), tEXt("Author", "kept")));
  assert.equal(Object.keys(t).length, keys.length); // all but the last compressed one, plus Author
  assert.equal(t[keys.at(-1)], undefined);
  assert.equal(t.Author, "kept");
});

test("garbage in the compressed data is skipped, xray() doesn't throw", async () => {
  const junk = Uint8Array.from({ length: 200 }, (_, i) => (i * 73 + 11) & 255);
  const half = zip(latin1(SD)).subarray(0, 20);
  const bytes = png(
    zTXt("Comment", junk),
    zTXt("parameters", half), // the stream ends early
    chunk("zTXt", cat(latin1("Title"), [0, 7], zip(latin1("unknown method")))),
    chunk("iTXt", cat(latin1("Source"), [0, 1, 0], latin1("no terminators"))),
    chunk("iTXt", cat(latin1("Software"), [0, 1, 0, 0, 0], junk)),
    chunk("tEXt", latin1("no keyword terminator")),
    chunk("tEXt", cat([0], latin1("empty keyword"))),
    tEXt("Author", "kept"),
  );
  const t = await pngTexts(bytes);
  assert.deepEqual(t, { Author: "kept" });
  const { findings } = await xray(new Blob([bytes]), bytes, "png", null, null);
  assert.equal(findings.find((f) => f.id === "owner")?.text, "kept");
});
