import { $ } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { t } from "./i18n";
import { quantizeImageData } from "./palette";
import { overlayData, guideCtx, getCachedTemplate } from "./overlay";
import { WALL_W, WALL_H } from "./constants";
import { readWallRegionFromTiles } from "./snapshot";
import { diffTemplate } from "./template-diff";

/**
 * Quantize an uploaded image to the site palette and return it as a PNG data
 * URL. Uses the shared LUT quantizer in palette.ts — no bespoke colour-match
 * loop here.
 */
export function quantize(img: HTMLImageElement, cb: (dataUrl: string) => void): void {
  const cv = document.createElement("canvas");
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const cx = cv.getContext("2d")!;
  cx.drawImage(img, 0, 0);
  const d = cx.getImageData(0, 0, cv.width, cv.height);
  quantizeImageData(d);
  cx.putImageData(d, 0, 0);
  cb(cv.toDataURL("image/png"));
}

/**
 * Calculate template progress — how many template pixels already match the
 * live wall. With `paintRemaining`, draws the unfinished pixels on the guide
 * layer.
 *
 * Works identically in dots and classic mode: it reads the render-independent
 * quantized template from overlay.ts's cache (getCachedTemplate) and the live
 * wall from the tile server (readWallRegionFromTiles), then counts through the
 * shared diff core.
 *
 * Why tiles and not the on-screen canvas: the site's wall canvas is only
 * viewport-sized (screen-space), so it can't report pixels that are off screen
 * or, in overview mode, any live pixels at all — reading it scored ~0%. The
 * native layer-0 tiles are the full-resolution source of truth, fetched only
 * for the template's footprint. The overlay lock state is irrelevant; a loaded
 * template always scores correctly.
 */
export async function templateProgress(paintRemaining: boolean): Promise<void> {
  const tpl = getCachedTemplate();
  if (!tpl) {
    toast(t("progress"), "load a template first");
    return;
  }

  const { data, w, h } = tpl;

  let live: Uint8ClampedArray | null;
  try {
    live = await readWallRegionFromTiles(overlayData.x, overlayData.y, w, h);
  } catch (e: any) {
    toast(t("progress"), "wall read failed (" + (e.name || e) + ")");
    return;
  }

  const gctx = paintRemaining ? guideCtx : null;
  if (gctx) gctx.clearRect(0, 0, WALL_W, WALL_H);

  const { total, match } = diffTemplate(data, w, h, live, {
    onMismatch: gctx
      ? (x, y, r, g, b) => {
          gctx.fillStyle = `rgb(${r},${g},${b})`;
          gctx.fillRect(overlayData.x + x, overlayData.y + y, 1, 1);
        }
      : undefined,
  });

  const pct = total ? (100 * match) / total : 0;
  const el = $("wp-progress");
  if (el) el.textContent = `${pct.toFixed(1)}%  (${match}/${total})`;
  toast(
    t("progress"),
    `${pct.toFixed(1)}% — ${(total - match).toLocaleString()} px left` +
      (paintRemaining ? " · on guide" : ""),
  );
  log("PROGRESS", "OK", `${pct.toFixed(1)}% (${match}/${total} of ${w}×${h})`);
}
