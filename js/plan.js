// Decisions about the saved file, kept apart from the page so they can be tested.

// How the clean file is made.
// "lossless": the original bytes with the metadata blocks taken out.
// "redraw": the picture drawn on a canvas and saved again (covered areas, HEIC, rotation, animation).
// An animation is always redrawn: Unpin checks only the first frame, so only that frame may be saved.
export function exportPlan({ format, lossless, animated, alpha, covering }) {
  const redraw = !lossless || covering || animated;
  if (!redraw) return { mode: "lossless", outFormat: format };
  return { mode: "redraw", outFormat: alpha || format === "png" ? "png" : "jpeg" };
}

// Compare the codes still readable in the saved file with the ones the user chose to keep.
// Codes match by type and content. Anything readable that wasn't kept on purpose is "bad".
export function codeCheck(keptOnPurpose, found) {
  const pool = keptOnPurpose.map((c) => `${c.format}\u0000${c.text}`);
  let unexpected = 0;
  for (const c of found) {
    const at = pool.indexOf(`${c.format}\u0000${c.text}`);
    if (at >= 0) pool.splice(at, 1);
    else unexpected++;
  }
  if (unexpected) return { result: "bad", left: found.length, kept: found.length - unexpected };
  if (found.length) return { result: "kept", left: found.length, kept: found.length };
  return { result: "ok", left: 0, kept: 0 };
}
