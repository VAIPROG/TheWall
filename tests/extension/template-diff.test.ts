/**
 * Tests for the shared template-vs-live diff core.
 * Run: bun tests/extension/template-diff.test.ts
 */
import assert from "node:assert";
import { colorClose, diffTemplate, COLOR_MATCH_TOL } from "../../src/template-diff";

/** Build a w×h RGBA buffer from a (x,y)->[r,g,b,a] function. */
function buf(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) {
  const a = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b, al] = f(x, y);
      a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = al;
    }
  }
  return a;
}

// --- colorClose: boundary + symmetry --------------------------------------
{
  // Exactly TOL apart (24) is NOT close (strict <). 23 is.
  assert.strictEqual(colorClose(0, 0, 0, 24, 0, 0), false, "sum=24 not close");
  assert.strictEqual(colorClose(0, 0, 0, 23, 0, 0), true, "sum=23 close");
  assert.strictEqual(colorClose(0, 0, 0, 8, 8, 8), false, "sum=24 spread not close");
  assert.strictEqual(colorClose(0, 0, 0, 8, 8, 7), true, "sum=23 spread close");
  // Symmetric.
  assert.strictEqual(colorClose(10, 20, 30, 12, 18, 33), colorClose(12, 18, 33, 10, 20, 30));
  // Custom tolerance.
  assert.strictEqual(colorClose(0, 0, 0, 50, 0, 0, 100), true, "within custom tol");
  assert.strictEqual(COLOR_MATCH_TOL, 24);
}

// --- diffTemplate: transparent pixels ignored in total --------------------
{
  // 2×2: top row opaque, bottom row transparent.
  const tpl = buf(2, 2, (_x, y) => (y === 0 ? [10, 20, 30, 255] : [10, 20, 30, 0]));
  const live = buf(2, 2, () => [10, 20, 30, 255]);
  const r = diffTemplate(tpl, 2, 2, live);
  assert.strictEqual(r.total, 2, "only opaque pixels counted");
  assert.strictEqual(r.match, 2, "both opaque match");
}

// --- diffTemplate: match within tol, mismatch beyond ----------------------
{
  const tpl = buf(2, 1, (x) => (x === 0 ? [100, 100, 100, 255] : [100, 100, 100, 255]));
  // pixel 0: live off by 23 (match). pixel 1: off by 24 (mismatch).
  const live = buf(2, 1, (x) => (x === 0 ? [123, 100, 100, 255] : [124, 100, 100, 255]));
  const seen: Array<[number, number, number, number, number]> = [];
  const r = diffTemplate(tpl, 2, 1, live, { onMismatch: (x, y, rr, g, b) => seen.push([x, y, rr, g, b]) });
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.match, 1, "one within tol");
  assert.deepStrictEqual(seen, [[1, 0, 100, 100, 100]], "mismatch reports coord + template colour");
}

// --- diffTemplate: live=null → nothing matches, all opaque are mismatches -
{
  const tpl = buf(2, 2, () => [5, 5, 5, 255]);
  let mismatches = 0;
  const r = diffTemplate(tpl, 2, 2, null, { onMismatch: () => mismatches++ });
  assert.strictEqual(r.total, 4);
  assert.strictEqual(r.match, 0, "null live → 0 match");
  assert.strictEqual(mismatches, 4, "every opaque pixel is a mismatch");
}

// --- diffTemplate: custom tolerance respected -----------------------------
{
  const tpl = buf(1, 1, () => [0, 0, 0, 255]);
  const live = buf(1, 1, () => [40, 0, 0, 255]); // off by 40
  assert.strictEqual(diffTemplate(tpl, 1, 1, live).match, 0, "default tol: mismatch");
  assert.strictEqual(diffTemplate(tpl, 1, 1, live, { tol: 50 }).match, 1, "loose tol: match");
}

// --- localPending: matches local-but-not-server, requires opaque local ----
{
  // 3 opaque template pixels, all colour (100,100,100).
  const tpl = buf(3, 1, () => [100, 100, 100, 255]);
  // server: px0 matches, px1 & px2 don't.
  const server = buf(3, 1, (x) => (x === 0 ? [100, 100, 100, 255] : [0, 0, 0, 255]));
  // local: px1 painted correctly & opaque (pending), px2 painted but TRANSPARENT
  // (off-screen/unpainted → must NOT count).
  const local = buf(3, 1, (x) =>
    x === 1 ? [100, 100, 100, 255] : x === 2 ? [100, 100, 100, 0] : [0, 0, 0, 255],
  );
  const remaining: number[] = [];
  const r = diffTemplate(tpl, 3, 1, server, {
    local,
    onMismatch: (x) => remaining.push(x),
  });
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.match, 1, "server match");
  assert.strictEqual(r.localPending, 1, "only opaque local-only match counts");
  assert.deepStrictEqual(remaining, [2], "transparent local pixel still 'remaining'");
}

// --- localPending: server match takes priority over local ------------------
{
  const tpl = buf(1, 1, () => [50, 60, 70, 255]);
  const server = buf(1, 1, () => [50, 60, 70, 255]);
  const local = buf(1, 1, () => [50, 60, 70, 255]);
  const r = diffTemplate(tpl, 1, 1, server, { local });
  assert.strictEqual(r.match, 1);
  assert.strictEqual(r.localPending, 0, "already on server → not counted as pending");
}

// --- no local buffer → localPending stays 0 --------------------------------
{
  const tpl = buf(2, 1, () => [9, 9, 9, 255]);
  const r = diffTemplate(tpl, 2, 1, null);
  assert.strictEqual(r.localPending, 0);
}

console.log("template-diff.test.ts: all assertions passed");
