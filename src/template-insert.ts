/**
 * The one place an image becomes the active overlay — as a static template
 * or an animated sprite sheet.
 *
 * Before this module the "put this image on the wall" sequence (decode →
 * maybe quantise → set source → position → animation) was reimplemented
 * slightly differently in the file picker, share-link import, Charity import
 * and wall-dev export apply. Every one of those now calls insertTemplate(),
 * so there is a single, documented implementation and the static-vs-animation
 * decision lives in exactly one spot (the optional `animation` field).
 *
 * insertTemplate does NOT decide *where* the image comes from or *what* format
 * it was in — callers resolve their format to a plain image data URL (+ an
 * optional AnimSource) first. Rendering (scaling, palette quantisation per
 * scale, frame slicing) is overlay.ts's job; this module only wires the
 * decoded image into the overlay state in the correct order.
 */
import { cfg, saveCfg } from "./config";
import {
  setOverlayImage,
  setOverlayPos,
  setOverlayAnimation,
  renderOverlay,
  type AnimSource,
} from "./overlay";
import { quantizeImageData } from "./palette";
import { log } from "./log";

export interface TemplateInsert {
  /** The template image as a data/object URL (already format-resolved). */
  imageDataUrl: string;
  /** Wall coordinates for the template's top-left corner. */
  x: number;
  y: number;
  /** Overlay scale (1 = 100%). Omit to leave the current scale untouched. */
  scale?: number;
  /** Sprite-sheet animation to drive; omit/null for a static template. */
  animation?: AnimSource | null;
  /**
   * Snap the source to the wall palette before inserting. True for raw user
   * uploads; false for sources that are already palette-correct (share links,
   * Charity/wall-dev payloads), to avoid a needless re-encode.
   */
  quantize?: boolean;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image decode failed"));
    img.src = src;
  });
}

/** Redraw a decoded image through the palette LUT and return a PNG data URL. */
function quantizeToDataUrl(img: HTMLImageElement): string {
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const cx = cv.getContext("2d", { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, cv.width, cv.height);
  quantizeImageData(d);
  cx.putImageData(d, 0, 0);
  return cv.toDataURL("image/png");
}

/**
 * Insert (or replace) the overlay from a resolved image. Returns the source's
 * natural pixel size. Order matters and is fixed here so every caller behaves
 * identically: scale → image → position → animation (animation last so the
 * frame rebuild sees the final source + scale).
 */
export async function insertTemplate(spec: TemplateInsert): Promise<{ w: number; h: number }> {
  const img = await loadImage(spec.imageDataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const src = spec.quantize ? quantizeToDataUrl(img) : spec.imageDataUrl;

  if (spec.scale != null) {
    cfg.overlayScale = Math.max(0.05, Math.min(10, spec.scale));
    saveCfg();
  }
  // Set image + position + animation state WITHOUT rendering each step, then
  // render exactly ONCE. Previously each setter ran its own full
  // rasterise→quantise→PNG-encode (2–3 per insert), and for animated sheets the
  // first render fired before the frame runtime existed — rasterising the ENTIRE
  // sprite sheet only to discard it. That redundant, area-scaled main-thread work
  // was the load-time freeze on large/animated (esp. Charity) templates.
  setOverlayImage(src, w, h, false);
  setOverlayPos(spec.x, spec.y);
  setOverlayAnimation(spec.animation ?? null, false);
  renderOverlay(true);

  log.ok(
    "INSERT",
    `${w}×${h} @ (${spec.x},${spec.y})` + (spec.animation ? " [animation]" : " [static]"),
  );
  return { w, h };
}
