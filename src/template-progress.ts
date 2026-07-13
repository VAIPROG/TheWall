import { $ } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { t } from "./i18n";
import { cfg } from "./config";
import { overlayData, guideCtx, getCachedTemplate } from "./overlay";
import { WALL_W, WALL_H } from "./constants";
import { readWallRegionFromTiles } from "./snapshot";
import { diffTemplate, toleranceFromPct } from "./template-diff";

/**
 * Template completion: how many of the template's pixels already match the
 * live wall. With `paintRemaining`, the unfinished pixels are drawn onto the
 * guide layer in their target colours.
 *
 * Works identically in dots and classic mode: it reads the render-independent
 * quantised template from overlay.ts's cache (getCachedTemplate) and the live
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
    tol: toleranceFromPct(cfg.progressTolerancePct),
    onMismatch: gctx
      ? (x, y, r, g, b) => {
          gctx.fillStyle = `rgb(${r},${g},${b})`;
          gctx.fillRect(overlayData.x + x, overlayData.y + y, 1, 1);
        }
      : undefined,
  });

  const pct = total ? (100 * match) / total : 0;
  const left = total - match;
  const el = $("wp-progress");
  if (el) {
    // total / done / left, with the tolerance in effect.
    el.textContent =
      `${pct.toFixed(1)}%  ·  ${match.toLocaleString()}/${total.toLocaleString()} done  ·  ` +
      `${left.toLocaleString()} left  (±${cfg.progressTolerancePct}%)`;
  }

  // Feed the Progress drill-in hero (big %, bar, TOTAL/DONE/LEFT) and the
  // compact headline on the Overlay's Progress drill row, when present.
  const setText = (id: string, v: string) => {
    const n = $(id);
    if (n) n.textContent = v;
  };
  setText("ov-prog-pct", `${pct.toFixed(1)}%`);
  setText("ov-prog-total", total.toLocaleString());
  setText("ov-prog-done", match.toLocaleString());
  setText("ov-prog-left", left.toLocaleString());
  const fill = $("ov-prog-fill");
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct)).toFixed(1)}%`;
  setText(
    "ov-row-progress-hl",
    total ? `${Math.round(pct)}% · ${left.toLocaleString()} left` : "—",
  );
  toast(
    t("progress"),
    `${pct.toFixed(1)}% — ${left.toLocaleString()} px left` +
      (paintRemaining ? " · on guide" : ""),
  );
  log("PROGRESS", "OK", `${pct.toFixed(1)}% (${match}/${total} of ${w}×${h}, ±${cfg.progressTolerancePct}%)`);
}
