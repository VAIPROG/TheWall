/**
 * Animated (sprite-sheet) template core — Charity-compatible.
 *
 * Charity (PlaceCharity/CharityOverlay.js) animates templates as row-major
 * sprite sheets and picks the frame from wall-clock time so every client
 * shows the same frame simultaneously. We mirror its math exactly:
 *
 *   frameIndex = negativeSafeModulo(
 *     floor((nowSeconds - startTimestamp) / secondsPerFrame), frameCount)
 *   — non-looping templates freeze on the last frame after the run ends.
 *
 *   gridWidth = round(imageWidth / frameWidth); frame (i) sits at
 *   (i % gridWidth, floor(i / gridWidth)) × (frameWidth, frameHeight).
 *
 * Config-field aliases (kept for parse AND emitted canonically by the
 * builder): secondsPerFrame ?? frameRate ?? frameSpeed; startTimestamp ??
 * startTime; looping defaults to frameCount > 1. Note the misleading name:
 * `frameRate` is SECONDS PER FRAME, not fps.
 *
 * Extras beyond Charity: sprite-sheet auto-split (derive frameWidth/Height/
 * grid from sheet dimensions + frame count, or enumerate plausible layouts)
 * and a Charity-config builder for sharing our templates back out.
 *
 * Dependency-free → unit-testable (spec/animated-template.test.ts).
 */

export interface AnimatedTemplate {
  name: string;
  sources: string[];
  x: number;
  y: number;
  /** Frame size in wall px; null = whole image (static template). */
  frameWidth: number | null;
  frameHeight: number | null;
  frameCount: number;
  /** Seconds each frame stays up (Charity's `frameRate`). Infinity = static. */
  secondsPerFrame: number;
  /** Epoch timestamp the animation starts at. Charity compares it against
   *  Date.now()/1000, so canonical unit is SECONDS — but wild configs (like
   *  the CFRB sample) carry milliseconds; the modulo makes any offset cycle
   *  correctly, so we pass the value through verbatim for compatibility. */
  startTimestamp: number;
  looping: boolean;
}

export function negativeSafeModulo(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** Charity's frame picker, verbatim semantics. `nowSeconds = Date.now()/1000`. */
export function getCurrentFrameIndex(
  t: Pick<AnimatedTemplate, "looping" | "startTimestamp" | "frameCount" | "secondsPerFrame">,
  nowSeconds: number,
): number {
  if (t.frameCount <= 1 || !Number.isFinite(t.secondsPerFrame)) return 0;
  if (
    !t.looping &&
    t.startTimestamp + t.frameCount * t.secondsPerFrame < nowSeconds
  ) {
    return t.frameCount - 1;
  }
  return negativeSafeModulo(
    Math.floor((nowSeconds - t.startTimestamp) / t.secondsPerFrame),
    t.frameCount,
  );
}

export interface FrameRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Source rect of frame `index` inside the sheet (Charity grid layout). */
export function frameRect(
  imageW: number,
  imageH: number,
  frameW: number | null,
  frameH: number | null,
  index: number,
): FrameRect {
  if (!frameW || !frameH) return { sx: 0, sy: 0, sw: imageW, sh: imageH };
  const gridWidth = Math.max(1, Math.round(imageW / frameW));
  return {
    sx: (index % gridWidth) * frameW,
    sy: Math.floor(index / gridWidth) * frameH,
    sw: frameW,
    sh: frameH,
  };
}

/* ---------------------------------------------------------------------------
 * Charity config parse / build
 * ------------------------------------------------------------------------ */

/** Normalize a raw Charity template entry (all field aliases honoured).
 *  Returns null when x/y are missing — same bail as Charity's loader. */
export function parseCharityTemplate(raw: any): AnimatedTemplate | null {
  if (typeof raw?.x !== "number" || typeof raw?.y !== "number") return null;
  const frameCount = typeof raw.frameCount === "number" ? raw.frameCount : 1;
  const spf =
    raw.secondsPerFrame ?? raw.frameRate ?? raw.frameSpeed ?? Infinity;
  return {
    name: typeof raw.name === "string" ? raw.name : "Untitled",
    sources: Array.isArray(raw.sources) ? raw.sources.filter((s: any) => typeof s === "string") : [],
    x: raw.x,
    y: raw.y,
    frameWidth: typeof raw.frameWidth === "number" ? raw.frameWidth : null,
    frameHeight: typeof raw.frameHeight === "number" ? raw.frameHeight : null,
    frameCount,
    secondsPerFrame: typeof spf === "number" ? spf : Infinity,
    startTimestamp:
      (typeof raw.startTimestamp === "number" ? raw.startTimestamp : undefined) ??
      (typeof raw.startTime === "number" ? raw.startTime : undefined) ??
      0,
    looping: typeof raw.looping === "boolean" ? raw.looping : frameCount > 1,
  };
}

/** Emit one template entry in the field names the Charity ecosystem shares
 *  (`frameRate` + `startTime`, like the CFRB sample). */
export function buildCharityTemplateEntry(t: AnimatedTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: t.name,
    sources: t.sources,
    x: t.x,
    y: t.y,
  };
  if (t.frameWidth && t.frameHeight && t.frameCount > 1) {
    out.frameWidth = t.frameWidth;
    out.frameHeight = t.frameHeight;
    out.frameRate = t.secondsPerFrame;
    out.frameCount = t.frameCount;
    out.startTime = t.startTimestamp;
    out.looping = t.looping;
  }
  return out;
}

/** Full shareable manifest (what Charity's loader actually walks). */
export function buildCharityManifest(
  templates: AnimatedTemplate[],
  meta: { faction?: string; contact?: string } = {},
): Record<string, unknown> {
  return {
    ...(meta.faction ? { faction: meta.faction } : {}),
    ...(meta.contact ? { contact: meta.contact } : {}),
    templates: templates.map(buildCharityTemplateEntry),
  };
}

/* ---------------------------------------------------------------------------
 * Sprite-sheet auto-split
 * ------------------------------------------------------------------------ */

export interface SheetLayout {
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
 * With `frameCount` known: enumerate column counts whose frame width divides
 * the sheet evenly and whose row count divides the height evenly, allowing a
 * partially-empty last row (waste < cols). With nothing known: enumerate
 * square frame sizes dividing both dimensions. Ranking: least waste, then
 * squarest frames, then fewer frames — a 300×200 sheet is far more likely
 * 3×2 of 100px frames than 30×20 of 10px ones.
 */
export function autoSplitSheet(
  sheetW: number,
  sheetH: number,
  hints: { frameCount?: number; frameWidth?: number; frameHeight?: number } = {},
): SheetLayout[] {
  const out: SheetLayout[] = [];
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
