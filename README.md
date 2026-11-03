# Unpin

Remove personal metadata from photos without touching the picture.

This repository holds the cleaning engine, [`js/strip.js`](js/strip.js). The web page that uses it is not published yet.

## What it does

JPEG, PNG and WebP files are rebuilt block by block. The image data is copied byte for byte, so nothing is re-compressed.

- **Removed:** EXIF (location, time, device, serial numbers, names), XMP, IPTC, the hidden JFIF preview, PNG text chunks (where image generators store prompts), extra images after the picture, and Content Credentials (C2PA).
- **Kept:** the color profile and, for JPEG, the rotation.
- **AI label:** if the file said it was made with AI (IPTC digital source type, in XMP or C2PA), that one fact is written back as a small XMP label.
- **Broken files** (cut off, no image data, no end marker) throw `BrokenFileError` instead of returning a "clean" file.

Why C2PA is removed: it is signed over the whole file, so it can't stay valid once other blocks are taken out, and it can carry a location or a preview.

## Use

```js
import { detectFormat, stripLossless } from "./js/strip.js";

const format = detectFormat(fileBytes); // "jpeg" | "png" | "webp" | "heic" | "avif" | "other"
const { bytes, removed, keptAiLabel } = stripLossless(fileBytes, format, { orientation: 6 });
```

`fileBytes` is a `Uint8Array`. For JPEG, pass the rotation you read from the original (1–8) and it is written back. `removed` lists what was taken out, in plain words. HEIC and AVIF return `null`: they can't be cleaned in place.

It has no dependencies and runs in the browser or in Node.

## Tests

```bash
npm install
npm test
```

## License

MIT.
