// Tests for reading Content Credentials and naming the AI tool. Run: npm test
// c2pa-openai.jumbf is the Content Credentials block of a picture made in ChatGPT (October 2026):
// signer, tool, actions and an icon; no picture or thumbnail inside. c2pa-google.jumbf: see below.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crc32 } from "node:zlib";
import { readC2pa, cbor } from "../js/c2pa.js";
import { aiReport, aiFinding } from "../js/ai.js";
import { stripPng } from "../js/strip.js";

const fx = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const enc = (s) => new TextEncoder().encode(s);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const u32 = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const jumbf = fx("c2pa-openai.jumbf");

function pngWith(type, data) {
  const base = fx("base.png");
  const ihdrEnd = 8 + 25; // signature + IHDR chunk
  const chunk = cat(u32(data.length), enc(type), data, u32(crc32(cat(enc(type), data))));
  return cat(base.subarray(0, ihdrEnd), chunk, base.subarray(ihdrEnd));
}

// JPEG keeps JUMBF in APP11 segments: "JP", instance, sequence number, then the box;
// later segments repeat the 8-byte box header.
function jpegWith(store, parts = 2) {
  const base = fx("base.jpg");
  const head = store.subarray(0, 8);
  const body = store.subarray(8);
  const size = Math.ceil(body.length / parts);
  const segs = [];
  for (let i = 0; i < parts; i++) {
    const piece = cat(head, body.subarray(i * size, (i + 1) * size));
    const payload = cat(enc("JP"), new Uint8Array([0, 1]), u32(i + 1), piece);
    const len = payload.length + 2;
    segs.push(cat(new Uint8Array([0xff, 0xeb, len >> 8, len & 255]), payload));
  }
  return cat(base.subarray(0, 2), ...segs, base.subarray(2));
}

const EXPECT = { signer: "OpenAI Media Service API", tool: "ChatGPT", version: "gpt-image", ai: "created" };
const pick = (r) => ({ signer: r.signer, tool: r.tool, version: r.version, ai: r.ai });

test("Content Credentials in a PNG: ChatGPT, signed by OpenAI, made by a model", async () => {
  const r = readC2pa(pngWith("caBX", jumbf), "png");
  assert.deepEqual(pick(r), EXPECT);
  assert.equal(r.when, "2026-10-28T09:48:14.501320880Z");
  assert.ok(r.actions.some((a) => a.action === "c2pa.created"));
});

test("Content Credentials split over JPEG APP11 segments are joined back", async () => {
  assert.deepEqual(pick(readC2pa(jpegWith(jumbf, 3), "jpeg")), EXPECT);
});

test("Content Credentials elsewhere (HEIC, AVIF) are found by their box", async () => {
  assert.deepEqual(pick(readC2pa(cat(new Uint8Array(40), jumbf), "heic")), EXPECT);
});

test("No Content Credentials: nothing is read", async () => {
  assert.equal(readC2pa(fx("base.jpg"), "jpeg"), null);
  assert.equal(readC2pa(fx("base.png"), "png"), null);
});

test("Cleaning removes the credentials, and their AI statement with them", async () => {
  const out = await stripPng(pngWith("caBX", jumbf));
  assert.equal(out.c2pa, true);
  assert.ok(!Buffer.from(out.bytes).includes(Buffer.from("trainedAlgorithmicMedia")));
  assert.equal(readC2pa(out.bytes, "png"), null);
});

test("CBOR: maps, arrays, text, numbers", async () => {
  // {"a": [1, -2, "x"], "b": true}
  const bytes = new Uint8Array([0xa2, 0x61, 0x61, 0x83, 0x01, 0x21, 0x61, 0x78, 0x61, 0x62, 0xf5]);
  assert.deepEqual(cbor(bytes), { a: [1, -2, "x"], b: true });
});

test("Report: credentials name the tool and maker; the text says what and when", async () => {
  const c2pa = readC2pa(pngWith("caBX", jumbf), "png");
  const r = aiReport({ c2pa });
  assert.equal(r.kind, "created");
  assert.equal(r.tool, "ChatGPT");
  assert.equal(r.maker, "OpenAI");
  const f = aiFinding(r);
  assert.equal(f.title, "Made with ChatGPT");
  assert.equal(f.text, "OpenAI · gpt-image");
  assert.match(f.tip, /28 October 2026, 09:48 UTC/);
  assert.match(f.tip, /doesn't check the signature/);
});

// c2pa-google.jumbf: the Content Credentials of a Gemini picture (November 2026), a chain of three
// manifests: made by Google's model with a SynthID watermark, then a visible mark, then converted to PNG.
test("Gemini: the model's step is found in an earlier manifest of the chain", async () => {
  const c2pa = readC2pa(pngWith("caBX", fx("c2pa-google.jumbf")), "png");
  assert.equal(c2pa.ai, "created");
  assert.equal(c2pa.description, "Created by Google Generative AI.");
  assert.equal(c2pa.watermark, "SynthID");
  const f = aiFinding(aiReport({ c2pa }));
  assert.equal(f.title, "Made with Google AI");
  assert.equal(f.text, "Invisible SynthID watermark");
  assert.match(f.tip, /Unpin doesn't remove it/);
});

test("The signer's logo comes from the credentials, as an image", async () => {
  const c2pa = readC2pa(pngWith("caBX", jumbf), "png");
  assert.equal(c2pa.icon.type, "image/svg+xml");
  assert.match(new TextDecoder().decode(c2pa.icon.bytes), /^<svg/);
  assert.equal(aiFinding(aiReport({ c2pa })).logo.type, "image/svg+xml");
});

test("Report: the IPTC label alone means made with AI", async () => {
  const meta = { DigitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia", Software: "Midjourney" };
  assert.deepEqual(pick(aiReport({ meta })), { signer: undefined, tool: "Midjourney", version: undefined, ai: undefined });
  assert.equal(aiReport({ meta }).kind, "created");
  const edited = { DigitalSourceType: "http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia" };
  assert.equal(aiReport({ meta: edited }).kind, "edited");
});

test("Report: Stable Diffusion and ComfyUI settings in a PNG", async () => {
  const sd = aiReport({ png: { parameters: "a cat\nSteps: 30, Sampler: Euler a, CFG scale: 7, Model: sdxl_base, Size: 1024x1024" } });
  assert.equal(sd.tool, "Stable Diffusion");
  assert.equal(sd.detail, "model sdxl_base");
  const comfy = aiReport({ png: { prompt: '{"3":{"class_type":"KSampler"}}', workflow: "{}" } });
  assert.equal(comfy.tool, "ComfyUI");
});

// Midjourney writes plain tEXt chunks: Author (your Discord name), Description (prompt, flags, Job ID)
// and XMP with the IPTC AI label, in tEXt rather than iTXt.
const MJ_XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
  'xmlns:iptcExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" iptcExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/></rdf:RDF></x:xmpmeta>';
const mjPng = {
  Author: "someone_on_discord",
  Description: "a lighthouse at dusk --v 6 Job ID: 0b2f6c1e-1111-4222-8333-944455556666",
  "XML:com.adobe.xmp": MJ_XMP,
};

test("Midjourney: prompt flags and Job ID name the tool and version", async () => {
  const r = aiReport({ png: mjPng });
  assert.equal(r.kind, "created");
  const f = aiFinding(r);
  assert.equal(f.title, "Made with Midjourney");
  assert.equal(f.text, "version 6");
});

test("The IPTC label in a plain tEXt XMP chunk is read, and removed when cleaning", async () => {
  assert.equal(aiReport({ png: { "XML:com.adobe.xmp": MJ_XMP } }).kind, "created");
  const src = pngWith("tEXt", cat(enc("XML:com.adobe.xmp\0"), enc(MJ_XMP)));
  const out = await stripPng(src);
  assert.ok(!Buffer.from(out.bytes).includes(Buffer.from("trainedAlgorithmicMedia")));
});

test("Report: AI editing tools in the software field; plain editors are not AI", async () => {
  assert.equal(aiReport({ meta: { Software: "Adobe Photoshop 26.0 (Generative Fill)" } }).kind, "edited");
  assert.equal(aiReport({ meta: { Software: "Adobe Photoshop 26.0 (Macintosh)" } }).kind, "none");
  assert.equal(aiReport({ meta: { Make: "Apple", Model: "iPhone 11", Software: "26.5.2" } }).kind, "none");
});

test("No label: said plainly, and that it doesn't prove the picture is real", async () => {
  const f = aiFinding(aiReport({}));
  assert.equal(f.title, "No AI label in the file");
  assert.match(f.text, /may still be AI-made/);
});

test("Midjourney: a Job ID alone is any program's job number, not Midjourney", async () => {
  const r = aiReport({ png: { Description: "Print queue Job ID: 12345678-abcd-1234-abcd-123456789012" } });
  assert.equal(r.kind, "none");
});

test("Midjourney: a Job ID that matches the picture's ID in its XMP is enough, without flags", async () => {
  const id = "0b2f6c1e-1111-4222-8333-944455556666";
  const xmp = MJ_XMP.replace("iptcExt:DigitalSourceType", `iptcExt:DigImageGUID="${id}" iptcExt:DigitalSourceType`);
  const r = aiReport({ png: { Description: `a lighthouse at dusk Job ID: ${id}`, "XML:com.adobe.xmp": xmp } });
  assert.equal(r.tool, "Midjourney");
});

test("Content Credentials: the page names the program that wrote them, not a signer", async () => {
  const f = aiFinding({ kind: "created", source: "Content Credentials", tool: "ChatGPT", signer: "OpenAI Media Service API" });
  assert.match(f.tip, /written by OpenAI Media Service API/);
  assert.doesNotMatch(f.tip, /Signed by/);
});
