/**
 * Cross-standard sprite-sheet math. Ported verbatim from animated-template.ts
 * (autoSplit) and wall-anim.ts (frameRect/normalizeTiming) so both the
 * the-wall-dev and Charity decoders share one implementation. The
 * characterization test (formats-sprite-sheet.test.ts) pins parity with the
 * legacy functions; do not "improve" the math here without updating it.
 */
import type { AnimationSpec } from "./template-model";

/* ---------------------------------------------------------------------------
 * autoSplit — ported verbatim from animated-template.ts#autoSplitSheet
 * ------------------------------------------------------------------------ */

export interface SheetCandidate {
  frameWidth: number;
  frameHeight: number;
  cols: number;
  rows: number;
  frameCount: number;
  /** Empty cells in the grid's last row (cols*rows - frameCount). */
  waste: number;
}

/**
 * Derive every plausible grid layout of a sprite sheet, best first.
 *
 * Ported verbatim from `autoSplitSheet` in src/animated-template.ts.
 * With `frameCount` known: enumerate column counts whose frame width divides
 * the sheet evenly and whose row count divides the height evenly, allowing a
 * partially-empty last row (waste < cols). With nothing known: enumerate
 * square frame sizes dividing both dimensions. Ranking: least waste, then
 * squarest frames, then fewer frames.
 */
export function autoSplit(
  sheetW: number,
  sheetH: number,
  hints: { frameCount?: number; frameWidth?: number; frameHeight?: number } = {},
): SheetCandidate[] {
  const out: SheetCandidate[] = [];
  if (sheetW <= 0 || sheetH <= 0) return out;

  if (hints.frameWidth && hints.frameHeight) {
    if (sheetW % hints.frameWidth === 0 && sheetH % hints.frameHeight === 0) {
      const cols = sheetW / hints.frameWidth;
      const rows = sheetH / hints.frameHeight;
      const frameCount = hints.frameCount ?? cols * rows;
      if (frameCount <= cols * rows) {
        out.push({
          frameWidth: hints.frameWidth,
          frameHeight: hints.frameHeight,
          cols,
          rows,
          frameCount,
          waste: cols * rows - frameCount,
        });
      }
    }
    return out;
  }

  if (hints.frameCount && hints.frameCount > 1) {
    const n = hints.frameCount;
    for (let cols = 1; cols <= Math.min(n, sheetW); cols++) {
      if (sheetW % cols !== 0) continue;
      const rows = Math.ceil(n / cols);
      if (rows > sheetH || sheetH % rows !== 0) continue;
      const waste = cols * rows - n;
      if (waste >= cols && rows > 1) continue; // last row would be empty
      out.push({
        frameWidth: sheetW / cols,
        frameHeight: sheetH / rows,
        cols,
        rows,
        frameCount: n,
        waste,
      });
    }
  } else {
    // No hints: propose square frames that divide both dimensions.
    for (let s = Math.min(sheetW, sheetH); s >= 8; s--) {
      if (sheetW % s !== 0 || sheetH % s !== 0) continue;
      const cols = sheetW / s;
      const rows = sheetH / s;
      const frameCount = cols * rows;
      if (frameCount < 2) continue;
      out.push({ frameWidth: s, frameHeight: s, cols, rows, frameCount, waste: 0 });
    }
  }

  out.sort(
    (a, b) =>
      a.waste - b.waste ||
      Math.abs(a.frameWidth - a.frameHeight) - Math.abs(b.frameWidth - b.frameHeight) ||
      a.frameCount - b.frameCount,
  );
  return out;
}

/* ---------------------------------------------------------------------------
 * frameRect — ported from wall-anim.ts#wallAnimFrameRect, adapted to
 * AnimationSpec (same arithmetic, different input shape).
 * ------------------------------------------------------------------------ */

export interface FrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * Sheet sub-rect of frame `index` honouring the layout + traversal order
 * declared in the AnimationSpec. Ported from `wallAnimFrameRect` in
 * src/wall-anim.ts — arithmetic is identical, input shape adapted to
 * AnimationSpec.
 */
export function frameRect(
  index: number,
  spec: AnimationSpec,
  imageW: number,
  imageH: number,
): FrameRect {
  const { frameWidth: fw, frameHeight: fh, layout, order } = spec.sheet;
  if (layout === "line") {
    return { sx: index * fw, sy: 0, sw: fw, sh: fh };
  }
  const cols = Math.max(1, Math.round(imageW / fw));
  const rows = Math.max(1, Math.round(imageH / fh));
  let gx: number, gy: number;
  switch (order) {
    case "column":
      gx = Math.floor(index / rows);
      gy = index % rows;
      break;
    case "serpentine": {
      gy = Math.floor(index / cols);
      const inRow = index % cols;
      gx = gy % 2 === 0 ? inRow : cols - 1 - inRow;
      break;
    }
    default: // row-major ("row")
      gx = index % cols;
      gy = Math.floor(index / cols);
  }
  return { sx: gx * fw, sy: gy * fh, sw: fw, sh: fh };
}

/* ---------------------------------------------------------------------------
 * normalizeTiming — ported from wall-anim.ts#buildTimeline logic.
 * Returns a flat array of per-timeline-slot { frame, durationMs } with skips
 * removed, plus the total cycle length. Ported from `buildTimeline` in
 * src/wall-anim.ts — arithmetic is identical, input shape adapted to
 * AnimationSpec.
 * ------------------------------------------------------------------------ */

export interface NormalizedTimeline {
  /** Visible frames in play order (skipped frames excluded). */
  entries: { frame: number; durationMs: number }[];
  /** Sum of all entry durations; 0 when entries is empty. */
  totalMs: number;
}

/**
 * Flatten AnimationSpec timing into a play-order entry list with all per-frame
 * overrides and skips resolved. Ported from `buildTimeline` in
 * src/wall-anim.ts — arithmetic is identical, input shape adapted to
 * AnimationSpec's `timing.frames` (FrameOverride[]).
 */
export function normalizeTiming(spec: AnimationSpec): NormalizedTimeline {
  const n = spec.sheet.frameCount;
  const defaultMs = spec.timing.defaultFrameMs;
  const overrideMap = new Map<number, { durationMs?: number; skip?: boolean }>();
  for (const f of spec.timing.frames ?? []) {
    overrideMap.set(f.index, { durationMs: f.durationMs, skip: f.skip });
  }
  const entries: { frame: number; durationMs: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = overrideMap.get(i);
    if (o?.skip) continue;
    const d = o?.durationMs ?? defaultMs;
    if (d <= 0) continue;
    entries.push({ frame: i, durationMs: d });
  }
  return { entries, totalMs: entries.reduce((a, e) => a + e.durationMs, 0) };
}
