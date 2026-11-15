import "./worker-guard.js"; // first: nothing leaves this site

// Reads QR codes and barcodes off the page's main thread: one read of a big photo takes about half a
// second, and the page (the mascot's animation over the photo) keeps drawing meanwhile.
let reader = null;
function load() {
  reader ||= import("../vendor/zxing/reader/index.js").then((z) => {
    const wasm = new URL("../vendor/zxing/zxing_reader.wasm", import.meta.url).href;
    z.prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasm : prefix + path) } });
    return z;
  });
  return reader;
}

self.onmessage = async ({ data: { id, image, options } }) => {
  try {
    const z = await load();
    const results = await z.readBarcodes(image, options);
    // Plain data only: what findCodes() uses.
    self.postMessage({ id, results: results.map((r) => ({ isValid: r.isValid, format: r.format, text: r.text, position: r.position })) });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
