/**
 * Tests for the pure protection-evaluation core.
 * Run: bun tests/extension/protect-core.test.ts
 */
import assert from "node:assert";
import { evaluateProtection } from "../../src/protect-core";

function buf(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const [r, g, b, al] = f(x, y);
    a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
  }
  return a;
}

// --- Fully intact region → ok at zero tolerance ----------------------------
{
  const ref = buf(4, 4, () => [10, 20, 30, 255]);
  const cur = buf(4, 4, () => [10, 20, 30, 255]);
  const v = evaluateProtection(ref, 4, 4, cur, 0);
  assert.strictEqual(v.total, 16);
  assert.strictEqual(v.intact, 16);
  assert.strictEqual(v.broken, 0);
  assert.strictEqual(v.brokenPct, 0);
  assert.strictEqual(v.ok, true);
}

// --- One broken cell of 16 = 6.25%: violated at 5%, fine at 10% ------------
{
  const ref = buf(4, 4, () => [10, 20, 30, 255]);
  const cur = buf(4, 4, (x, y) => (x === 0 && y === 0 ? [200, 0, 0, 255] : [10, 20, 30, 255]));
  const strict = evaluateProtection(ref, 4, 4, cur, 5);
  assert.strictEqual(strict.broken, 1);
  assert.ok(Math.abs(strict.brokenPct - 6.25) < 1e-9);
  assert.strictEqual(strict.ok, false, "6.25% > 5% → violated");

  const loose = evaluateProtection(ref, 4, 4, cur, 10);
  assert.strictEqual(loose.ok, true, "6.25% ≤ 10% → tolerated");

  // Boundary: tolerance exactly equal to brokenPct passes (≤).
  const exact = evaluateProtection(ref, 4, 4, cur, 6.25);
  assert.strictEqual(exact.ok, true);
}

// --- Unpainted (transparent) reference cells are not protected -------------
{
  // Only the top row was painted at capture; bottom row was empty.
  const ref = buf(2, 2, (_x, y) => (y === 0 ? [5, 5, 5, 255] : [0, 0, 0, 0]));
  // Someone paints the bottom row — that's allowed; top row intact.
  const cur = buf(2, 2, (_x, y) => (y === 0 ? [5, 5, 5, 255] : [99, 99, 99, 255]));
  const v = evaluateProtection(ref, 2, 2, cur, 0);
  assert.strictEqual(v.total, 2, "only painted cells protected");
  assert.strictEqual(v.broken, 0);
  assert.strictEqual(v.ok, true);
}

// --- current=null (wall unreadable) → everything counts broken -------------
{
  const ref = buf(2, 1, () => [1, 2, 3, 255]);
  const v = evaluateProtection(ref, 2, 1, null, 50);
  assert.strictEqual(v.broken, 2);
  assert.strictEqual(v.brokenPct, 100);
  assert.strictEqual(v.ok, false);
}

// --- Empty reference (nothing painted) is trivially ok ---------------------
{
  const ref = buf(3, 3, () => [0, 0, 0, 0]);
  const v = evaluateProtection(ref, 3, 3, null, 0);
  assert.strictEqual(v.total, 0);
  assert.strictEqual(v.brokenPct, 0);
  assert.strictEqual(v.ok, true);
}

// --- Tolerance clamped into 0..100 ------------------------------------------
{
  const ref = buf(1, 1, () => [1, 1, 1, 255]);
  assert.strictEqual(evaluateProtection(ref, 1, 1, null, -5).tolerancePct, 0);
  assert.strictEqual(evaluateProtection(ref, 1, 1, null, 250).tolerancePct, 100);
  assert.strictEqual(evaluateProtection(ref, 1, 1, null, 250).ok, true, "100% tolerance never alarms");
}

console.log("protect-core.test.ts: all assertions passed");
