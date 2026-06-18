/**
 * Viewport culling math for the dots overlay.
 *
 * When the camera is zoomed in, only a slice of the template is on screen, but
 * the renderer still walks every template pixel and emits an SVG rect for each
 * unpainted one. Culling restricts that work to the wall rectangle currently
 * visible, which is where the CPU cost matters most (deep zoom).
 *
 * Derives everything from the wall's on-screen rect (DOM `getBoundingClientRect`)
 * + the window size — a stable contract that survives the site's minified-name
 * churn. Dependency-free → unit-testable (spec/viewport-cull.test.ts).
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number; // exclusive
  y1: number; // exclusive
}

/**
 * The wall rectangle (in wall pixels) currently inside the viewport.
 *
 * @param left,top,width  the wall's on-screen rect (container getBoundingClientRect)
 * @param winW,winH       viewport size
 * @param wallW,wallH     wall dimensions
 * @param margin          extra wall px kept around the viewport so a small pan
 *                        doesn't immediately reveal unrendered edges
 * Returns null when no part of the wall is visible.
 */
export function visibleWallRect(
  left: number,
  top: number,
  width: number,
  winW: number,
  winH: number,
  wallW: number,
  wallH: number,
  margin: number = 0,
): Rect | null {
  const zoom = width / wallW;
  if (!(zoom > 0)) return null;
  const clampX = (v: number) => Math.max(0, Math.min(wallW, v));
  const clampY = (v: number) => Math.max(0, Math.min(wallH, v));
  const x0 = clampX(Math.floor((0 - left) / zoom) - margin);
  const y0 = clampY(Math.floor((0 - top) / zoom) - margin);
  const x1 = clampX(Math.ceil((winW - left) / zoom) + margin);
  const y1 = clampY(Math.ceil((winH - top) / zoom) + margin);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/**
 * Intersect the visible wall rect with a template placed at (ox,oy) of size
 * w×h, returned in TEMPLATE-LOCAL coordinates [x0,x1) × [y0,y1) for the render
 * loop. When `vis` is null (no viewport info) the whole template is returned so
 * culling silently degrades to "render everything". Returns null when the
 * template is entirely off screen.
 */
export function cullTemplateRect(
  ox: number,
  oy: number,
  w: number,
  h: number,
  vis: Rect | null,
): Rect | null {
  if (!vis) return { x0: 0, y0: 0, x1: w, y1: h };
  const x0 = Math.max(0, vis.x0 - ox);
  const y0 = Math.max(0, vis.y0 - oy);
  const x1 = Math.min(w, vis.x1 - ox);
  const y1 = Math.min(h, vis.y1 - oy);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}
