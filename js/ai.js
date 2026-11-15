// Was the picture made or edited with AI, and with what? Read from labels in the file only:
// Content Credentials (C2PA), the IPTC "digital source type", the software fields, and the
// settings that image generators write into PNG files. Pixels are not judged: no file label
// means "no label", never "not AI". No DOM here, so it runs in Node tests too.

// Known tools. `edit` marks tools that change a real photo rather than make one.
const TOOLS = [
  { re: /chatgpt|gpt-image|dall[\s·.-]?e|openai/i, name: "ChatGPT", maker: "OpenAI" },
  { re: /midjourney/i, name: "Midjourney", maker: "Midjourney" },
  { re: /generative (fill|expand)/i, name: "Photoshop Generative Fill", maker: "Adobe", edit: true },
  { re: /firefly/i, name: "Adobe Firefly", maker: "Adobe" },
  { re: /imagen|gemini|nano[\s-]?banana/i, name: "Google Gemini", maker: "Google" },
  { re: /google (generative )?ai/i, name: "Google AI", maker: "Google" }, // Gemini's own words: "Created by Google Generative AI"
  { re: /magic editor|pixel studio|best take|reimagine/i, name: "Google Pixel AI editing", maker: "Google", edit: true },
  { re: /meta ai|imagine with meta/i, name: "Meta AI", maker: "Meta" },
  { re: /image playground/i, name: "Image Playground", maker: "Apple" },
  { re: /bing image creator|microsoft designer|copilot/i, name: "Microsoft Designer", maker: "Microsoft" },
  { re: /galaxy ai|generative edit/i, name: "Galaxy AI", maker: "Samsung", edit: true },
  { re: /comfyui/i, name: "ComfyUI", maker: "Stable Diffusion" },
  { re: /invokeai/i, name: "InvokeAI", maker: "Stable Diffusion" },
  { re: /fooocus/i, name: "Fooocus", maker: "Stable Diffusion" },
  { re: /novelai/i, name: "NovelAI", maker: "NovelAI" },
  { re: /stable[\s-]?diffusion|sdxl|stability ai|automatic1111/i, name: "Stable Diffusion", maker: "Stability AI" },
  { re: /\bflux\b|black forest labs/i, name: "FLUX", maker: "Black Forest Labs" },
  { re: /leonardo\.ai|leonardo ai/i, name: "Leonardo", maker: "Leonardo.Ai" },
  { re: /ideogram/i, name: "Ideogram", maker: "Ideogram" },
  { re: /\bgrok\b/i, name: "Grok", maker: "xAI" },
];
const toolIn = (...texts) => {
  for (const t of texts) if (t) for (const k of TOOLS) if (k.re.test(t)) return k;
  return null;
};

const MADE = /digitalsourcetype\/(trainedAlgorithmicMedia|algorithmicMedia)$/i;
const EDITED = /digitalsourcetype\/(compositeWithTrainedAlgorithmicMedia|compositeSynthetic)$/i;
const text = (v) => (v == null ? "" : Array.isArray(v) ? v.map(text).join(" ") : typeof v === "object" ? text(v.value) : String(v));

// c2pa: readC2pa() result or null; meta: exifr output; png: { keyword: text } from PNG text chunks.
// Returns { kind: "created" | "edited" | "label" | "none", tool, maker, version, when, signer, source, detail }.
export function aiReport({ c2pa = null, meta = {}, png = {} } = {}) {
  // 1. Content Credentials: signed, and the most precise.
  if (c2pa?.ai) {
    // The tool's name: its own field, else its description ("Created by Google Generative AI"), else the signer.
    const k = toolIn(c2pa.tool, c2pa.description, c2pa.signer);
    return {
      kind: c2pa.ai, source: "Content Credentials",
      tool: c2pa.tool || k?.name || null, maker: k?.maker || null, version: c2pa.version, when: c2pa.when, signer: c2pa.signer,
      logo: c2pa.icon || null, watermark: c2pa.watermark || null, description: c2pa.description || null,
    };
  }
  // 2. Generator settings in a PNG (Stable Diffusion front ends, ComfyUI, NovelAI…).
  const pngTool = pngGenerator(png);
  if (pngTool) return { kind: "created", source: "generator settings", ...pngTool };

  // 3. The IPTC label and the software fields. PNG XMP can sit in a plain text chunk that the
  //    metadata reader skips (Midjourney does this), so the label is also looked for there.
  const software = [meta.Software, meta.CreatorTool, meta.HistorySoftwareAgent, text(meta.Credit), meta.Make, text(meta.Source), png.Software].map(text).join(" | ");
  const k = toolIn(software, c2pa?.tool, c2pa?.signer);
  const xmpDst = /DigitalSourceType\s*(?:=\s*"|>)\s*([^"<\s]+)/.exec(png["XML:com.adobe.xmp"] || "")?.[1] || "";
  const dst = text(meta.DigitalSourceType) || xmpDst;
  if (MADE.test(dst) || EDITED.test(dst)) {
    return { kind: EDITED.test(dst) || k?.edit ? "edited" : "created", source: "IPTC label", tool: k?.name || null, maker: k?.maker || null };
  }
  if (k) return { kind: k.edit ? "edited" : "label", source: "software field", tool: k.name, maker: k.maker };
  return { kind: "none" };
}

function pngGenerator(png) {
  // Midjourney: the prompt with its flags ("--v 4", "--ar 3:2") and a Job ID, in the PNG description.
  // A Job ID alone is any program's job number, so it takes a second sign: a Midjourney flag, the
  // same ID as the picture's ID in its XMP (Midjourney writes both), or the name itself.
  const d = png.Description || "";
  const job = /Job ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(d)?.[1];
  const flags = /\s--(v|ar|stylize|niji|style|chaos|q|s|seed|no|tile|weird)\s/.test(` ${d} `);
  const named = /midjourney/i.test(JSON.stringify(png));
  const sameId = !!job && new RegExp(`DigImageGUID\\s*(?:=\\s*"|>)\\s*${job}`, "i").test(png["XML:com.adobe.xmp"] || "");
  if ((job && (flags || sameId || named)) || (flags && named)) {
    const v = /--(v|niji)\s+([\d.]+)/.exec(d);
    return { tool: "Midjourney", maker: "Midjourney", detail: v ? `${v[1] === "niji" ? "Niji" : "version"} ${v[2]}` : null };
  }
  const p = png.parameters;
  if (p && /Steps:\s*\d+/.test(p) && /Sampler:/.test(p)) {
    const model = /Model:\s*([^,\n]+)/.exec(p)?.[1]?.trim();
    return { tool: "Stable Diffusion", maker: "Stability AI", detail: model ? `model ${model}` : null };
  }
  if (png.workflow && png.prompt && /class_type/.test(png.prompt)) return { tool: "ComfyUI", maker: "Stable Diffusion", detail: null };
  if (png.invokeai_metadata || png["sd-metadata"]) return { tool: "InvokeAI", maker: "Stable Diffusion", detail: null };
  if (/novelai/i.test(png.Software || "") || /novelai/i.test(png.Source || "")) return { tool: "NovelAI", maker: "NovelAI", detail: null };
  if (png.fooocus_scheme || /fooocus/i.test(png.parameters || "")) return { tool: "Fooocus", maker: "Stable Diffusion", detail: null };
  return null;
}

// The findings item: short on purpose, the tool's name (and logo, when the file carries one)
// and one line of who and how. The full story goes to `tip`, shown on hover.
export function aiFinding(r) {
  const maker = r.maker && r.tool && !r.tool.includes(r.maker) ? r.maker : null;
  if (r.kind === "created" || r.kind === "edited") {
    const verb = r.kind === "created" ? "Made" : "Edited";
    const title = `${verb} with ${r.tool || "AI"}`;
    let text, tip;
    if (r.source === "Content Credentials") {
      const mark = r.watermark ? `${r.watermark === "SynthID" ? "Invisible SynthID" : "Invisible"} watermark` : null;
      text = [maker || (r.tool ? null : r.signer), r.version, mark].filter(Boolean).join(" · ") || "Content Credentials";
      tip = `Content Credentials in the file say ${r.tool || "an AI model"}${r.version ? ` (${r.version})` : ""} ${r.kind === "created" ? "created" : "edited"} this picture` +
        `${r.when ? ` on ${fmtWhen(r.when)}` : ""}.${r.description ? ` “${r.description.replace(/\.$/, "")}.”` : ""}` +
        `${r.watermark ? ` They also say ${r.watermark === "SynthID" ? "a SynthID" : "an invisible"} watermark is in the pixels: it can't be seen, and Unpin doesn't remove it.` : ""}` +
        `${r.signer ? ` The credentials were written by ${r.signer}.` : ""} Unpin reads the credentials; it doesn't check the signature.`;
    } else if (r.source === "generator settings") {
      text = [maker, r.detail].filter(Boolean).join(" · ") || "Generator settings in the file";
      tip = r.tool === "Midjourney"
        ? "The file holds the prompt and the Job ID that Midjourney writes into its pictures."
        : `The file still holds the settings ${r.tool} writes into it.`;
    } else {
      text = [maker, "AI label in the file"].filter(Boolean).join(" · ");
      tip = `The file's IPTC label says the picture was ${r.kind === "created" ? "made" : "edited"} by an AI model. Unpin removes it with the rest.`;
    }
    return { id: "ai", level: "medium", title, text, tip, logo: r.logo || null };
  }
  if (r.kind === "label") {
    return { id: "ai", level: "medium", title: `Made with ${r.tool}?`, text: [maker, "named in the software field"].filter(Boolean).join(" · "), tip: "The file has no explicit AI label." };
  }
  return {
    id: "ai", level: "low", title: "No AI label in the file",
    text: "Screenshots and re-saving remove these labels, so the picture may still be AI-made.",
    tip: "Unpin reads labels in the file; it doesn't judge the pixels.",
  };
}

export function fmtWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${day}, ${time} UTC`;
}
