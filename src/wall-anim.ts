/**
 * WallAnim v1 — our extended animated-template config format.
 *
 * Charity's format is the lowest common denominator: uniform frame timing,
 * row-major sheets, implicit 100% scale. WallAnim is a superset the backend
 * can store/share and the extension can render natively:
 *
 *   - timing in MILLISECONDS, unambiguous `startTime` epoch-ms;
 *   - per-frame overrides: custom duration or skip;
 *   - sheet layouts: a single "line" or a "grid", with grid traversal order
 *     row / column / serpentine;
 *   - scaling policy: "native" (1:1 wall pixels, what Charity assumes) or
 *     "scaled" (a stored scale factor, re-bakeable server-side for Charity).
 *
 * Both directions of Charity interop live here: `fromCharity` (import,
 * seconds→ms with a magnitude heuristic) and `toCharityEntry` (export —
 * always 100%/native per policy, flattening anything Charity can't express
 * and reporting what got lost).
 *
 * A small `AnimRuntime` is the single shape the overlay engine consumes, so
 * the renderer doesn't care which format a template arrived in.
 *
 * Dependency-light (only the Charity core) → unit-testable.
 */
import {
  type AnimatedTemplate,
  type FrameRect,
  getCurrentFrameIndex as charityFrameIndex,
  frameRect as charityFrameRect,
  buildCharityTemplateEntry,
} from "./animated-template";

export const WALL_ANIM_FORMAT = "wall-anim/1";

export type SheetLayoutKind = "line" | "grid";
export type GridOrder = "row" | "column" | "serpentine";
export type ScalingMode = "native" | "scaled";

export interface WallAnimFrameOverride {
  /** Timeline index (0-based, in traversal order). */
  index: number;
  /** Custom on-screen time for this frame, ms. */
  durationMs?: number;
  /** Exclude the frame from the timeline entirely. */
  skip?: boolean;
}

export interface WallAnimConfig {
  format: typeof WALL_ANIM_FORMAT;
  name: string;
  /** Sheet image URLs (https) or a data URL for local-only configs. */
  sources: string[];
  x: number;
  y: number;
  sheet: {
    frameWidth: number;
    frameHeight: number;
    frameCount: number;
    layout: SheetLayoutKind;
    /** Traversal for grid layouts; lines are always left-to-right. */
    order: GridOrder;
  };
  timing: {
    /** Epoch milliseconds the timeline starts at. */
    startTime: number;
    /** Default per-frame duration, ms. */
    defaultFrameMs: number;
    looping: boolean;
    frames?: WallAnimFrameOverride[];
  };
  scaling: {
    mode: ScalingMode;
    /** Multiplier when mode === "scaled" (1 = 100%). */
    scale?: number;
  };
}

/* ---------------------------------------------------------------------------
 * Validation / parse
 * ------------------------------------------------------------------------ */

export function parseWallAnim(raw: unknown): WallAnimConfig | null {
  const r = raw as any;
  if (r?.format !== WALL_ANIM_FORMAT) return null;
  if (typeof r.x !== "number" || typeof r.y !== "number") return null;
  const s = r.sheet;
  if (
    !s ||
    typeof s.frameWidth !== "number" || s.frameWidth <= 0 ||
    typeof s.frameHeight !== "number" || s.frameHeight <= 0 ||
    typeof s.frameCount !== "number" || s.frameCount < 1
  ) {
    return null;
  }
  const tm = r.timing ?? {};
  const defaultFrameMs =
    typeof tm.defaultFrameMs === "number" && tm.defaultFrameMs > 0
      ? tm.defaultFrameMs
      : 1000;
  const overrides: WallAnimFrameOverride[] = Array.isArray(tm.frames)
    ? tm.frames.filter(
        (f: any) =>
          typeof f?.index === "number" &&
          f.index >= 0 &&
          f.index < s.frameCount &&
          (typeof f.durationMs === "number" ? f.durationMs >= 0 : true),
      )
    : [];
  return {
    format: WALL_ANIM_FORMAT,
    name: typeof r.name === "string" ? r.name : "Untitled",
    sources: Array.isArray(r.sources)
      ? r.sources.filter((u: any) => typeof u === "string")
      : [],
    x: r.x,
    y: r.y,
    sheet: {
      frameWidth: s.frameWidth,
      frameHeight: s.frameHeight,
      frameCount: s.frameCount,
      layout: s.layout === "grid" ? "grid" : "line",
      order: s.order === "column" || s.order === "serpentine" ? s.order : "row",
    },
    timing: {
      startTime: typeof tm.startTime === "number" ? tm.startTime : 0,
      defaultFrameMs,
      looping: typeof tm.looping === "boolean" ? tm.looping : s.frameCount > 1,
      frames: overrides.length ? overrides : undefined,
    },
    scaling: {
      mode: r.scaling?.mode === "scaled" ? "scaled" : "native",
      scale:
        typeof r.scaling?.scale === "number" && r.scaling.scale > 0
          ? r.scaling.scale
          : undefined,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Timeline (variable frame durations)
 * ------------------------------------------------------------------------ */

export interface Timeline {
  /** Timeline entries as (frameIndex, durationMs), skips removed. */
  entries: { frame: number; durationMs: number }[];
  totalMs: number;
}

export function buildTimeline(cfg: WallAnimConfig): Timeline {
  const n = cfg.sheet.frameCount;
  const overrides = new Map<number, WallAnimFrameOverride>();
  for (const o of cfg.timing.frames ?? []) overrides.set(o.index, o);
  const entries: { frame: number; durationMs: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = overrides.get(i);
    if (o?.skip) continue;
    const d = o?.durationMs ?? cfg.timing.defaultFrameMs;
    if (d <= 0) continue;
    entries.push({ frame: i, durationMs: d });
  }
  return { entries, totalMs: entries.reduce((a, e) => a + e.durationMs, 0) };
}

/** Frame (timeline order index into the sheet) at wall-clock `nowMs`. */
export function frameAt(cfg: WallAnimConfig, tl: Timeline, nowMs: number): number {
  if (!tl.entries.length) return 0;
  if (tl.entries.length === 1 || tl.totalMs <= 0) return tl.entries[0].frame;
  let t = nowMs - cfg.timing.startTime;
  if (cfg.timing.looping) {
    t = ((t % tl.totalMs) + tl.totalMs) % tl.totalMs;
  } else {
    if (t < 0) return tl.entries[0].frame;
    if (t >= tl.totalMs) return tl.entries[tl.entries.length - 1].frame;
  }
  for (const e of tl.entries) {
    if (t < e.durationMs) return e.frame;
    t -= e.durationMs;
  }
  return tl.entries[tl.entries.length - 1].frame;
}

/* ---------------------------------------------------------------------------
 * Grid traversal → sheet rect
 * ------------------------------------------------------------------------ */

/**
 * Sheet sub-rect of timeline frame `index` honouring layout + traversal.
 * Grid dimensions derive from the sheet image size (like Charity), so the
 * same config keeps working when the art is re-exported at another size —
 * the backend re-bakes scale, the grid math stays.
 */
export function wallAnimFrameRect(
  cfg: WallAnimConfig,
  imageW: number,
  imageH: number,
  index: number,
): FrameRect {
  const fw = cfg.sheet.frameWidth;
  const fh = cfg.sheet.frameHeight;
  if (cfg.sheet.layout === "line") {
    return { sx: index * fw, sy: 0, sw: fw, sh: fh };
  }
  const cols = Math.max(1, Math.round(imageW / fw));
  const rows = Math.max(1, Math.round(imageH / fh));
  let gx: number, gy: number;
  switch (cfg.sheet.order) {
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
    default: // row-major
      gx = index % cols;
      gy = Math.floor(index / cols);
  }
  return { sx: gx * fw, sy: gy * fh, sw: fw, sh: fh };
}

/* ---------------------------------------------------------------------------
 * Unified overlay runtime
 * ------------------------------------------------------------------------ */

export interface AnimRuntime {
  kind: "charity" | "wall-anim";
  name: string;
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
  /** null → honour the user's overlay scale; number → force this scale. */
  scaleOverride: number | null;
  /** Suggested ticker cadence, ms. */
  tickMs: number;
  frameAt(nowMs: number): number;
  rectOf(imageW: number, imageH: number, frame: number): FrameRect;
}

/** Charity templates render 1:1 (100% scale) by policy. */
export function runtimeFromCharity(t: AnimatedTemplate): AnimRuntime | null {
  if (!t.frameWidth || !t.frameHeight || t.frameCount <= 1) return null;
  const spfMs = Number.isFinite(t.secondsPerFrame) ? t.secondsPerFrame * 1000 : Infinity;
  return {
    kind: "charity",
    name: t.name,
    frameCount: t.frameCount,
    frameWidth: t.frameWidth,
    frameHeight: t.frameHeight,
    scaleOverride: 1,
    tickMs: clampTick(spfMs / 4),
    frameAt: (nowMs) => charityFrameIndex(t, nowMs / 1000),
    rectOf: (iw, ih, frame) => charityFrameRect(iw, ih, t.frameWidth, t.frameHeight, frame),
  };
}

export function runtimeFromWallAnim(cfg: WallAnimConfig): AnimRuntime {
  const tl = buildTimeline(cfg);
  const minDur = tl.entries.length
    ? Math.min(...tl.entries.map((e) => e.durationMs))
    : cfg.timing.defaultFrameMs;
  return {
    kind: "wall-anim",
    name: cfg.name,
    frameCount: cfg.sheet.frameCount,
    frameWidth: cfg.sheet.frameWidth,
    frameHeight: cfg.sheet.frameHeight,
    scaleOverride:
      cfg.scaling.mode === "native" ? 1 : cfg.scaling.scale ?? null,
    tickMs: clampTick(minDur / 4),
    frameAt: (nowMs) => frameAt(cfg, tl, nowMs),
    rectOf: (iw, ih, frame) => wallAnimFrameRect(cfg, iw, ih, frame),
  };
}

function clampTick(ms: number): number {
  if (!Number.isFinite(ms)) return 60_000;
  return Math.max(100, Math.min(5000, Math.round(ms)));
}

/* ---------------------------------------------------------------------------
 * Charity interop
 * ------------------------------------------------------------------------ */

/** Import a Charity entry. Charity timestamps are nominally SECONDS but wild
 *  configs carry ms — values past year ~5138 in seconds (1e11) are treated as
 *  ms already. */
export function fromCharity(t: AnimatedTemplate): WallAnimConfig {
  const startMs =
    Math.abs(t.startTimestamp) >= 1e11 ? t.startTimestamp : t.startTimestamp * 1000;
  return {
    format: WALL_ANIM_FORMAT,
    name: t.name,
    sources: t.sources,
    x: t.x,
    y: t.y,
    sheet: {
      frameWidth: t.frameWidth ?? 0,
      frameHeight: t.frameHeight ?? 0,
      frameCount: t.frameCount,
      layout: "grid",
      order: "row",
    },
    timing: {
      startTime: startMs,
      defaultFrameMs: Number.isFinite(t.secondsPerFrame)
        ? t.secondsPerFrame * 1000
        : 1000,
      looping: t.looping,
    },
    scaling: { mode: "native" },
  };
}

export interface CharityExport {
  entry: Record<string, unknown>;
  /** Human-readable list of WallAnim features Charity cannot express. */
  lossy: string[];
}

/** Export to a Charity entry — uniform timing, row-major, 100% scale. */
export function toCharityEntry(cfg: WallAnimConfig): CharityExport {
  const lossy: string[] = [];
  if (cfg.timing.frames?.length) lossy.push("per-frame durations/skips flattened to defaultFrameMs");
  if (cfg.sheet.layout === "grid" && cfg.sheet.order !== "row") {
    lossy.push(`grid order "${cfg.sheet.order}" exported as row-major (re-bake the sheet for Charity)`);
  }
  if (cfg.scaling.mode === "scaled" && cfg.scaling.scale !== 1) {
    lossy.push("scaling forced to 100% (Charity renders 1:1)");
  }
  const t: AnimatedTemplate = {
    name: cfg.name,
    sources: cfg.sources,
    x: cfg.x,
    y: cfg.y,
    frameWidth: cfg.sheet.frameWidth,
    frameHeight: cfg.sheet.frameHeight,
    frameCount: cfg.sheet.frameCount,
    secondsPerFrame: cfg.timing.defaultFrameMs / 1000,
    startTimestamp: Math.round(cfg.timing.startTime / 1000),
    looping: cfg.timing.looping,
  };
  return { entry: buildCharityTemplateEntry(t), lossy };
}

/* ---------------------------------------------------------------------------
 * the-wall-dev/1 envelope interop
 *
 * Shared configs ride in the extension's standard export envelope
 * (charity-import.ts#WallDevExport): `template.animation` carries the sheet/
 * timing block, while name/x/y/scale/image live in the envelope itself. The
 * scaling policy maps onto the envelope's `scale` field: "native" pins it to
 * 1, "scaled" uses whatever the template carries.
 * ------------------------------------------------------------------------ */

/** The `template.animation` block inside a the-wall-dev/1 export. */
export interface AnimationBlock {
  sheet: WallAnimConfig["sheet"];
  timing: WallAnimConfig["timing"];
  scaling: { mode: ScalingMode };
}

export function animationBlockOf(cfg: WallAnimConfig): AnimationBlock {
  return {
    sheet: cfg.sheet,
    timing: cfg.timing,
    scaling: { mode: cfg.scaling.mode },
  };
}

/** Rebuild a runnable WallAnimConfig from envelope fields + animation block.
 *  Returns null when the block is malformed (delegates to parseWallAnim's
 *  validation by reassembling the full document). */
export function configFromEnvelope(env: {
  name?: string;
  image_data_url: string;
  x: number;
  y: number;
  scale?: number;
  animation: unknown;
}): WallAnimConfig | null {
  const a = env.animation as any;
  if (!a?.sheet) return null;
  return parseWallAnim({
    format: WALL_ANIM_FORMAT,
    name: env.name ?? "Untitled",
    sources: [env.image_data_url],
    x: env.x,
    y: env.y,
    sheet: a.sheet,
    timing: a.timing ?? {},
    scaling: {
      mode: a.scaling?.mode === "scaled" ? "scaled" : "native",
      scale: a.scaling?.mode === "scaled" ? env.scale : undefined,
    },
  });
}
