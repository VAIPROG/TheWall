/**
 * Pure wall-canvas region extraction for the dots-overlay live diff.
 *
 * The site's wall canvas is kept at full wall resolution — one bitmap pixel
 * per wall pixel — and is indexed by raw wall coordinates (the site reads it
 * with `getImageData(wallX, wallY, ...)`, see N6 in the site bundle). On-screen
 * zoom/pan is purely a CSS `translate()/scale()` transform on
 * `.canvas-container` and never touches the bitmap. So extracting the region
 * under a template is a straight clamped copy with NO zoom or screen-offset
 * math — getting that wrong is what made the mask drift with zoom.
 *
 * Kept dependency-free so it stays trivially unit-testable (see
 * spec/overlay-region.test.ts).
 */

/** Reads a `rw×rh` block of RGBA bytes from the bitmap at (rx, ry). Thin
 *  wrapper over `CanvasRenderingContext2D.getImageData(...).data`, injected so
 *  the copy logic can be tested without a real canvas. */
export type RegionReader = (rx: number, ry: number, rw: number, rh: number) => Uint8ClampedArray;

/** Persistent diff buffer — reused across reads to avoid GC pressure (O3).
 *  Exported so the caller can hold a reference for diffing. */
let _reuseBuf: Uint8ClampedArray | null = null;

/**
 * Extract the `w×h` template region at wall coordinates (x, y) from a wall
 * canvas bitmap of size (canvasW × canvasH).
 *
 * Returns a `w*h*4` RGBA buffer in template-local order. Template pixels that
 * fall outside the canvas are left transparent (alpha 0) so the caller's diff
 * treats them as "not matching" and still draws their dot. Returns null when
 * the template lies entirely off the canvas.
 *
 * If `reuse` is provided, writes into that buffer instead of allocating a new
 * one — caller must ensure `reuse.length >= w * h * 4`.
 */
export function readWallRegion(
  read: RegionReader,
  canvasW: number,
  canvasH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  reuse?: Uint8ClampedArray,
): Uint8ClampedArray | null {
  // Intersection of the template rect with the canvas bitmap.
  const rx = Math.max(0, x);
  const ry = Math.max(0, y);
  const rw = Math.min(canvasW, x + w) - rx;
  const rh = Math.min(canvasH, y + h) - ry;
  if (rw <= 0 || rh <= 0) return null;

  const src = read(rx, ry, rw, rh);
  const needed = w * h * 4;
  const out = reuse && reuse.length >= needed ? reuse : new Uint8ClampedArray(needed);
  if (!reuse) _reuseBuf = out;
  // A reused buffer may still hold bytes from a previous read. When this read
  // doesn't cover the whole w×h (template partly off the wall), zero it first
  // so uncovered cells read as transparent instead of leaking stale data into
  // the diff. A freshly allocated buffer is already zeroed.
  if (reuse && (rw < w || rh < h)) out.fill(0, 0, needed);
  // Where the read block lands inside the template-local buffer.
  const dx = rx - x;
  const dy = ry - y;
  for (let row = 0; row < rh; row++) {
    const si = row * rw * 4;
    const di = ((row + dy) * w + dx) * 4;
    out.set(src.subarray(si, si + rw * 4), di);
  }
  return out;
}
