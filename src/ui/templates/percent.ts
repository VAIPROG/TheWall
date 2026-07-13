/**
 * "% painted" for the Templates Detail drill-in. Reuses the shared progress
 * engine: quantise the template image, read the live wall region from the tile
 * server (per the site-wall-canvas-model — tiles, never the viewport canvas),
 * and diff the two. The pure formatters (`formatPct`/`abbrev`) live at the top
 * so unit tests can import them without pulling in DOM/tile/canvas modules; the
 * heavy work is behind dynamic imports inside {@link computePercentPainted}.
 */

/** Compact count: 999 → "999", 1200 → "1.2k", 1_500_000 → "1.5M". */
export function abbrev(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** "71% · 290 left", or "—" for an empty template. */
export function formatPct(total: number, match: number): string {
  if (!total) return "—";
  const pct = Math.round((100 * match) / total);
  return `${pct}% · ${abbrev(total - match)} left`;
}

export interface PaintedResult {
  total: number;
  match: number;
  pct: number;
}

/**
 * Compute how much of a template's primary layer is already painted on the
 * live wall. Returns null on any failure (dead image, tile read error, no
 * layer) — the caller shows a dash. Integration-only; not unit-tested.
 */
export async function computePercentPainted(
  doc: unknown,
  layerIdx = 0,
): Promise<PaintedResult | null> {
  try {
    const [{ decodeAny, primaryLayer }, { resolveImage }, { quantizeImageData }, { readWallRegionFromTiles }, { diffTemplate, toleranceFromPct }, { cfg }] =
      await Promise.all([
        import("../../formats"),
        import("../../formats/shared/image-source"),
        import("../../palette"),
        import("../../snapshot"),
        import("../../template-diff"),
        import("../../config"),
      ]);

    const { set } = decodeAny(doc as object);
    const layer = set.layers?.[layerIdx] ?? primaryLayer(set);
    if (!layer) return null;

    const resolved = await resolveImage(layer.image);
    const scale = layer.scale || 1;
    const fw = Math.max(1, Math.round(resolved.width * scale));
    const fh = Math.max(1, Math.round(resolved.height * scale));

    // Render the source image at its on-wall footprint (nearest-neighbour so
    // one source pixel maps cleanly to `scale`² wall pixels), then quantise to
    // the wall palette for a fair colour comparison.
    const cv = document.createElement("canvas");
    cv.width = fw;
    cv.height = fh;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = false;
    const img = new Image();
    img.src = resolved.dataUrl;
    await img.decode();
    ctx.drawImage(img, 0, 0, fw, fh);
    const id = ctx.getImageData(0, 0, fw, fh);
    quantizeImageData(id);

    const live = await readWallRegionFromTiles(layer.x, layer.y, fw, fh);
    const { total, match } = diffTemplate(id.data, fw, fh, live, {
      tol: toleranceFromPct(cfg.progressTolerancePct),
    });
    return { total, match, pct: total ? (100 * match) / total : 0 };
  } catch {
    return null;
  }
}
