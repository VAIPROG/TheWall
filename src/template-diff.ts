/**
 * Shared template-vs-live-wall diff core.
 *
 * Single source of truth for "does this painted pixel match the template?":
 * the tolerance and the colour-closeness predicate live here and are reused by
 * both the progress counter (templates.ts) and the dots renderer (overlay.ts),
 * so the two can never drift apart. Dependency-free → unit-testable in Bun
 * without a DOM (see spec/template-diff.test.ts).
 */

/** Match tolerance: sum of per-channel |Δ| over RGB. A repaint counts as
 *  "correct" when its colour is within this of the template colour. Both the
 *  template and the live canvas are quantised to the same palette, so in
 *  practice matches are exact; the tolerance only absorbs sub-quant noise. */
export const COLOR_MATCH_TOL = 24;

/** Sum-of-abs-RGB closeness test. Inlinable; the ONLY match predicate in the
 *  codebase. Alpha is intentionally ignored — callers gate on template alpha. */
export function colorClose(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
  tol: number = COLOR_MATCH_TOL,
): boolean {
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < tol;
}

export interface DiffResult {
  /** Opaque template pixels (alpha ≥ 128) — the paintable total. */
  total: number;
  /** Of those, how many already match the committed (server) wall. */
  match: number;
  /** Of the rest, how many match the LOCAL on-screen state but not yet the
   *  server — i.e. painted locally and awaiting server reconciliation. 0 when
   *  no local buffer is supplied. */
  localPending: number;
}

export interface DiffOptions {
  tol?: number;
  /**
   * Optional local/on-screen wall region (same w×h layout as `live`). A cell
   * counts as `localPending` when it doesn't match the server but DOES match
   * the template here, with a fully-opaque (alpha === 255) local pixel — the
   * opacity gate skips cells that are off-screen or unpainted so they don't
   * masquerade as local edits.
   */
  local?: Uint8ClampedArray | null;
  /** Called for every opaque template pixel that matches neither the server
   *  nor the local state — the pixels genuinely still to paint. Template-local
   *  coordinate + template colour. Used to paint the "remaining" guide layer. */
  onMismatch?: (x: number, y: number, r: number, g: number, b: number) => void;
}

/**
 * Diff a quantised template against the live wall. `live` is the committed
 * (server) region; `opts.local` is the optional on-screen region. Both are
 * RGBA, template-local, w×h, and may be null. Transparent template pixels
 * (alpha < 128) are holes and ignored.
 */
export function diffTemplate(
  tpl: Uint8ClampedArray,
  w: number,
  h: number,
  live: Uint8ClampedArray | null,
  opts: DiffOptions = {},
): DiffResult {
  const tol = opts.tol ?? COLOR_MATCH_TOL;
  const local = opts.local ?? null;
  const onMismatch = opts.onMismatch;
  let total = 0;
  let match = 0;
  let localPending = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (tpl[i + 3] < 128) continue; // template hole — not paintable
      total++;
      const r = tpl[i], g = tpl[i + 1], b = tpl[i + 2];
      if (live !== null && colorClose(r, g, b, live[i], live[i + 1], live[i + 2], tol)) {
        match++;
      } else if (
        local !== null &&
        local[i + 3] === 255 &&
        colorClose(r, g, b, local[i], local[i + 1], local[i + 2], tol)
      ) {
        localPending++;
      } else if (onMismatch) {
        onMismatch(x, y, r, g, b);
      }
    }
  }
  return { total, match, localPending };
}
