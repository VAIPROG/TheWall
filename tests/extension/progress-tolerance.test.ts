/**
 * Progress match-tolerance: the % → threshold mapping and its effect on how
 * many template pixels count as "done".
 *
 * Run: bun tests/extension/progress-tolerance.test.ts
 */
import assert from "node:assert";
import { toleranceFromPct, diffTemplate } from "../../src/template-diff";

// --- % → sum-of-abs-RGB threshold ---
{
  assert.strictEqual(toleranceFromPct(0), 1, "0% clamps to exact (tol 1)");
  assert.strictEqual(toleranceFromPct(100), 765, "100% → full range");
  assert.strictEqual(toleranceFromPct(3), 23, "3% → round(0.03*765)");
  assert.strictEqual(toleranceFromPct(-5), 1, "negatives clamp to 1");
  assert.strictEqual(toleranceFromPct(999), 765, "over-100 clamps to 765");
}
console.log("progress-tolerance.test.ts: mapping OK");

// --- a near-match counts as done only once tolerance is wide enough ---
{
  // 1×1 opaque template pixel, colour (100,100,100).
  const tpl = new Uint8ClampedArray([100, 100, 100, 255]);
  // Live wall pixel off by 10 per channel → sum-abs = 30.
  const live = new Uint8ClampedArray([110, 110, 110, 255]);

  const strict = diffTemplate(tpl, 1, 1, live, { tol: toleranceFromPct(0) });
  assert.strictEqual(strict.total, 1, "one paintable pixel");
  assert.strictEqual(strict.match, 0, "exact tolerance: the off-by-30 pixel is NOT done");

  // 5% → tol round(0.05*765)=38 > 30 → now it counts as done.
  const loose = diffTemplate(tpl, 1, 1, live, { tol: toleranceFromPct(5) });
  assert.strictEqual(loose.match, 1, "5% tolerance: the near-match counts as done");
}
console.log("progress-tolerance.test.ts: diff effect OK");

console.log("progress-tolerance.test.ts: all assertions passed");
