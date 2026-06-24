/**
 * Bridge between the canonical model and the (still single-layer) overlay
 * engine. Resolves a layer's image source chain, derives a sprite grid for
 * animated layers whose sheet dimensions are unknown (Charity case), and
 * applies it through the existing insertTemplate path. Spec B replaces this
 * with true multi-layer rendering.
 */
import type { TemplateLayer, AnimationSpec } from "./shared/template-model";
import { resolveImage } from "./shared/image-source";
import { autoSplit } from "./shared/sprite-sheet";
import { insertTemplate } from "../template-insert";
import type { AnimSource } from "../overlay";
import { parseWallAnim, WALL_ANIM_FORMAT } from "../wall-anim";

export async function applyLayer(layer: TemplateLayer): Promise<{ w: number; h: number; note?: string }> {
  const resolved = await resolveImage(layer.image);
  let animation: AnimSource | null = null;
  let note: string | undefined;

  if (layer.animation && layer.animation.sheet.frameCount > 1) {
    const sheet = { ...layer.animation.sheet };
    if (!sheet.frameWidth || !sheet.frameHeight) {
      const best = autoSplit(resolved.width, resolved.height, { frameCount: sheet.frameCount })[0];
      if (best) { sheet.frameWidth = best.frameWidth; sheet.frameHeight = best.frameHeight; }
    }
    if (sheet.frameWidth && sheet.frameHeight) {
      // Build the AnimSource the engine expects. Reuse the existing wall-anim
      // config shape (see wall-anim.ts) — map AnimationSpec → wall-anim config.
      animation = toWallAnimSource({ ...layer.animation, sheet });
      note = `Animated: ${sheet.frameCount} frames.`;
    } else {
      note = `Animated (${sheet.frameCount}f) — could not derive grid; loaded static.`;
    }
  }

  await insertTemplate({
    imageDataUrl: resolved.dataUrl,
    x: layer.x, y: layer.y,
    scale: layer.scale || 1,
    animation,
  });
  return { w: resolved.width, h: resolved.height, note };
}

/**
 * Map a canonical AnimationSpec to the {kind:"wall-anim", config} AnimSource
 * the overlay engine consumes. Reuses parseWallAnim from wall-anim.ts (the
 * same path configFromEnvelope takes in walldev-config.ts) so the animation
 * runtime is never duplicated here.
 *
 * AnimationSpec.scaleMode → WallAnimConfig.scaling.mode (both "native"|"scaled").
 * AnimationSpec.timing.frames (FrameOverride[]) → WallAnimConfig.timing.frames
 * (WallAnimFrameOverride[]); only index/durationMs/skip are carried (the
 * per-frame imageSources/width/height fields are v2-only and the engine ignores
 * them — they are preserved in the model but not rendered this phase).
 */
function toWallAnimSource(spec: AnimationSpec): AnimSource | null {
  const config = parseWallAnim({
    format: WALL_ANIM_FORMAT,
    // name/sources/x/y are envelope-level in WallAnimConfig but not part of
    // AnimationSpec; supply safe defaults (the engine uses them only for
    // export/Charity interop, not for frame rendering).
    name: "layer",
    sources: [],
    x: 0,
    y: 0,
    sheet: {
      frameWidth: spec.sheet.frameWidth,
      frameHeight: spec.sheet.frameHeight,
      frameCount: spec.sheet.frameCount,
      layout: spec.sheet.layout,
      order: spec.sheet.order,
    },
    timing: {
      startTime: spec.timing.startTime,
      defaultFrameMs: spec.timing.defaultFrameMs,
      looping: spec.timing.looping,
      frames: spec.timing.frames
        ? spec.timing.frames
            .filter((f) => !f.imageSources && f.width == null && f.height == null
              ? true  // pure timing override — pass through
              : true) // v2 image/dim overrides: pass index/durationMs/skip, ignore the rest
            .map((f) => ({
              index: f.index,
              ...(f.durationMs != null ? { durationMs: f.durationMs } : {}),
              ...(f.skip != null ? { skip: f.skip } : {}),
            }))
        : undefined,
    },
    scaling: {
      mode: spec.scaleMode === "scaled" ? "scaled" : "native",
    },
  });
  if (!config) return null;
  return { kind: "wall-anim", config };
}
