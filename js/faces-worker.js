// Looks for faces off the page's main thread (js/detect.js does the work), so the page keeps
// drawing while hundreds of looks of the model run. A classic worker, not a module: MediaPipe
// loads its wasm loader with importScripts. Modules still come in through import().
importScripts("./worker-guard.js"); // first: nothing leaves this site

// A message is a search ({ id, bitmap, pass }) or a stop for one ({ stop: id }). Searches pause
// every few looks (detect.js), so a stop for a search nobody needs any more is heard midway.
let detect = null;
const running = new Map(); // id → { aborted }
self.onmessage = async ({ data }) => {
  if (data.stop) {
    const signal = running.get(data.stop);
    if (signal) signal.aborted = true;
    return;
  }
  const { id, bitmap, pass } = data;
  const signal = { aborted: false };
  running.set(id, signal);
  try {
    detect ||= await import("./detect.js");
    const faces = await detect.findFaces(bitmap, (status) => self.postMessage({ id, status }), { pass, signal });
    self.postMessage({ id, faces });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e), aborted: e?.name === "AbortError" });
  } finally {
    running.delete(id);
    bitmap.close?.();
  }
};
