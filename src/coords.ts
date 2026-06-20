import { SEL, WALL_W, WALL_H } from "./constants";

/**
 * Site-canvas access + screen↔wall coordinate conversion.
 *
 * History — why this isn't just a one-liner around `getBoundingClientRect`:
 *
 *   The site used to apply its zoom/pan transform to `.canvas-container`
 *   only, with `<canvas>` sitting un-transformed inside it. In that world
 *   `canvas.getBoundingClientRect()` returned the visual wall rect on
 *   screen, and ratio math against `canvas.width × canvas.height` (which
 *   matched the wall) just worked.
 *
 *   In early June 2026 the site refactored the camera and now applies an
 *   INVERSE transform to the canvas itself:
 *
 *       n0.style.transform = matrix(zoom, 0, 0, zoom, x, y);          // container
 *       v0.style.transform = matrix(1/zoom, 0, 0, 1/zoom,
 *                                   -x/zoom, -y/zoom);                 // canvas
 *
 *   The two cancel out at render time so canvas pixels stay 1:1 with
 *   physical pixels (sharper at fractional zooms, no GPU blur). But
 *   `canvas.getBoundingClientRect()` now returns the IDENTITY rect — it's
 *   at (0, 0) with intrinsic width/height — so any code that derived wall
 *   coords from it ended up reading screen-space pixels instead. Picker
 *   clicks landed where the *device* pixel was, not where the user saw
 *   the wall pixel. Several extensions broke at once.
 *
 *   The reliable target now is `.canvas-container`: its bounding rect is
 *   the visible wall, and its CSS width/height is hard-coded to the wall
 *   dimensions (`6000×4200`). Ratio math against (WALL_W, WALL_H) just
 *   works at any zoom level.
 *
 * We still expose `mainCanvas()` for legacy callers that need the canvas
 * element itself (e.g. for tile-level pixel reads via getImageData).
 */
import { log } from "./log";

/** Cache the resolved container reference. The site recreates it on a few
 *  transitions; we check `isConnected` before reuse. */
let cachedContainer: HTMLElement | null = null;

export function canvasContainer(): HTMLElement | null {
  if (cachedContainer && cachedContainer.isConnected) return cachedContainer;
  cachedContainer =
    document.querySelector<HTMLElement>(SEL.canvasContainer) ||
    document.querySelector<HTMLElement>(".canvas-container") ||
    null;
  return cachedContainer;
}

export function mainCanvas(): HTMLCanvasElement | null {
  return (
    document.querySelector<HTMLCanvasElement>(SEL.mainCanvas) ||
    document.querySelector<HTMLCanvasElement>(".paint-layers canvas")
  );
}

/**
 * Convert a screen-pixel coordinate (e.g. from a `MouseEvent.clientX/Y`)
 * to the wall coordinate the user is pointing at. Returns (0, 0) when the
 * container hasn't mounted yet.
 *
 * Implementation note: we deliberately use `WALL_W × WALL_H` as the
 * denominator rather than `container.offsetWidth/Height` — the container
 * IS exactly the wall size (its inline `style="width:6000px;height:4200px"`
 * is set by the site), but reading it from the DOM every event adds a
 * forced layout we don't need.
 */
export function screenToCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const cont = canvasContainer();
  if (!cont) {
    log.warn("COORDS", "no .canvas-container — pick will return (0,0)");
    return { x: 0, y: 0 };
  }
  const r = cont.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return { x: 0, y: 0 };
  const x = Math.floor(((clientX - r.left) / r.width) * WALL_W);
  const y = Math.floor(((clientY - r.top) / r.height) * WALL_H);
  return {
    x: Math.max(0, Math.min(x, WALL_W - 1)),
    y: Math.max(0, Math.min(y, WALL_H - 1)),
  };
}

/**
 * Teleport the site camera to centre on wall (x, y).
 *
 * The site deep-links the camera through the URL hash — `#x,y` holds the
 * centre wall coordinate. It reads the hash once at init and frames that
 * point, then rewrites the hash from the live camera every second. There is
 * no `hashchange` listener and the camera state isn't exposed, so the only
 * robust entry point is to set the hash and reload — exactly what following a
 * shared `#x,y` link does. Caller is responsible for warning about the reload.
 */
export function teleport(x: number, y: number): void {
  const cx = Math.max(0, Math.min(Math.round(x), WALL_W - 1));
  const cy = Math.max(0, Math.min(Math.round(y), WALL_H - 1));
  location.hash = `${cx},${cy}`;
  location.reload();
}

/** Inverse of screenToCanvas — wall pixel → screen point. */
export function canvasToScreen(px: number, py: number): { x: number; y: number } | null {
  const cont = canvasContainer();
  if (!cont) return null;
  const r = cont.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return null;
  return {
    x: r.left + ((px + 0.5) / WALL_W) * r.width,
    y: r.top + ((py + 0.5) / WALL_H) * r.height,
  };
}
