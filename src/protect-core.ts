/**
 * Pure evaluation core for template/region protection.
 *
 * A protected region is a captured reference state of a wall rect (taken from
 * the clean tile-server composite — no watermark, no background). Verification
 * re-reads the same rect and reports how much of the painted reference still
 * stands, honouring a user-set tolerance: small touch-ups shouldn't page
 * anyone, a griefed artwork should.
 *
 * Reference semantics: transparent reference pixels (unpainted at capture
 * time) are not protected — they're background that anyone may paint on. Only
 * cells that were painted when the user said "fix this state" are guarded.
 *
 * Depends only on the shared diff core → unit-testable without a DOM.
 */
import { diffTemplate } from "./template-diff";

export interface ProtectionVerdict {
  /** Painted (protected) cells in the reference. */
  total: number;
  /** Cells still matching the reference. */
  intact: number;
  /** Cells that changed. */
  broken: number;
  /** broken / total × 100 (0 when the reference protects nothing). */
  brokenPct: number;
  /** Allowed % of broken cells before the region counts as violated. */
  tolerancePct: number;
  /** true while brokenPct ≤ tolerancePct. */
  ok: boolean;
}

export function evaluateProtection(
  ref: Uint8ClampedArray,
  w: number,
  h: number,
  current: Uint8ClampedArray | null,
  tolerancePct: number,
): ProtectionVerdict {
  const tol = Math.max(0, Math.min(100, tolerancePct));
  const { total, match } = diffTemplate(ref, w, h, current);
  const broken = total - match;
  const brokenPct = total ? (100 * broken) / total : 0;
  return {
    total,
    intact: match,
    broken,
    brokenPct,
    tolerancePct: tol,
    ok: brokenPct <= tol,
  };
}
