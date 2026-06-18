/**
 * Regression test for the dots-overlay live-diff region read.
 *
 * Bug (P1): the mask that suppresses dots on already-painted cells drifted
 * vertically as the user zoomed, because readLiveRegion() converted wall
 * coordinates to canvas-bitmap coordinates with a zoom factor + screen
 * offset (`x * zoom + rect.left`). The site's wall canvas is full wall
 * resolution and indexed by RAW wall coordinates — zoom is only a CSS
 * transform — so the read must be a straight clamped copy with no zoom math.
 *
 * Run: bun tests/extension/overlay-region.test.ts
 */
import assert from "node:assert";
import { readWallRegion, type RegionReader } from "../../src/overlay-region";

/** Fake bitmap reader that encodes each pixel's wall coordinate into its
 *  colour: R = bx & 255, G = by & 255, B = (bx >> 8) & 255. That lets us
 *  recover, for every output slot, which bitmap pixel was sourced into it. */
function makeReader(): RegionReader {
  return (rx, ry, rw, rh) => {
    const a = new Uint8ClampedArray(rw * rh * 4);
    for (let row = 0; row < rh; row++) {
      for (let col = 0; col < rw; col++) {
        const bx = rx + col, by = ry + row;
        const i = (row * rw + col) * 4;
        a[i] = bx & 255; a[i + 1] = by & 255; a[i + 2] = (bx >> 8) & 255; a[i + 3] = 255;
      }
    }
    return a;
  };
}

const CW = 6000, CH = 4200;

// --- 1. Fully-in-bounds template maps 1:1 to raw wall coordinates. --------
{
  const x = 1300, y = 200, w = 10, h = 8;
  const out = readWallRegion(makeReader(), CW, CH, x, y, w, h);
  assert.ok(out, "expected a region buffer");
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = (ty * w + tx) * 4;
      const bx: number = out![i]! | (out![i + 2]! << 8);
      const by: number = out![i + 1]!;
      assert.strictEqual(bx, x + tx, `x map @(${tx},${ty})`);
      assert.strictEqual(by, (y + ty) & 255, `y map @(${tx},${ty})`);
      assert.strictEqual(out![i + 3], 255, `alpha @(${tx},${ty})`);
    }
  }
}

// --- 2. Template partly off the top-left: in-bounds pixels still map to
//        raw coords, off-canvas pixels stay transparent (treated as "no
//        match" → dot still drawn). ---------------------------------------
{
  const x = -3, y = -2, w = 8, h = 6;
  const out = readWallRegion(makeReader(), CW, CH, x, y, w, h);
  assert.ok(out, "expected a region buffer for partial template");
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = (ty * w + tx) * 4;
      const wx = x + tx, wy = y + ty;
      if (wx < 0 || wy < 0) {
        assert.strictEqual(out![i + 3], 0, `off-canvas alpha @(${tx},${ty})`);
      } else {
        assert.strictEqual(out![i] | (out![i + 2] << 8), wx, `x map @(${tx},${ty})`);
        assert.strictEqual(out![i + 1], wy & 255, `y map @(${tx},${ty})`);
      }
    }
  }
}

// --- 3. Template entirely off the canvas → null (caller draws all dots). --
{
  assert.strictEqual(readWallRegion(makeReader(), CW, CH, -50, -50, 10, 10), null);
  assert.strictEqual(readWallRegion(makeReader(), CW, CH, CW + 5, 0, 10, 10), null);
}

// --- 4. The mapping carries no zoom term, so the sourced bitmap row for a
//        given template row is identical regardless of on-screen zoom. The
//        OLD formula (kept here only to document the regression) drifts. ---
{
  const x = 1300, y = 200, w = 4, h = 4;
  const a = readWallRegion(makeReader(), CW, CH, x, y, w, h)!;
  const b = readWallRegion(makeReader(), CW, CH, x, y, w, h)!;
  assert.deepStrictEqual(a, b, "read must be deterministic / zoom-free");

  // Old buggy mapping for template row 0, demonstrated at two zooms.
  const oldRow = (zoom: number, rectTop: number) =>
    Math.floor(y * zoom + rectTop + Math.floor(zoom / 2));
  assert.notStrictEqual(
    oldRow(1, -50), oldRow(4, -800),
    "old zoom-dependent formula should have differed across zoom (regression marker)",
  );
}

console.log("overlay-region.test.ts: all assertions passed");

// ==========================================================================
// O3: Persistent diff buffer reuse
// ==========================================================================
{
  const reader = makeReader();
  const w = 20, h = 15;
  const buf = new Uint8ClampedArray(w * h * 4);

  // First read — fills the buffer.
  const r1 = readWallRegion(reader, CW, CH, 100, 50, w, h, buf);
  assert.ok(r1, "expected a region buffer");
  assert.strictEqual(r1, buf, "should return the same buffer instance");

  // Second read — should reuse the same buffer.
  const r2 = readWallRegion(reader, CW, CH, 100, 50, w, h, buf);
  assert.strictEqual(r2, buf, "should reuse buffer on second read");

  // Content should match (same coords = same data).
  assert.deepStrictEqual(r1, r2, "reused buffer should contain identical data");

  // Save a snapshot of r1 before overwriting.
  const snapshot = new Uint8ClampedArray(r1!);

  // Third read with different coords — buffer reused, content differs.
  const r3 = readWallRegion(reader, CW, CH, 200, 100, w, h, buf);
  assert.strictEqual(r3, buf, "should reuse buffer even with different coords");

  // Compare snapshot (old data) with r3 (new data).
  let contentDiffers = false;
  for (let i = 0; i < r3!.length; i += 4) {
    if (r3![i] !== snapshot[i] || r3![i + 1] !== snapshot[i + 1]) {
      contentDiffers = true;
      break;
    }
  }
  assert.ok(contentDiffers, "different coords should produce different content in reused buffer");
}

// ==========================================================================
// O3: readWallRegion without reuse still allocates
// ==========================================================================
{
  const reader = makeReader();
  const r1 = readWallRegion(reader, CW, CH, 0, 0, 5, 5);
  const r2 = readWallRegion(reader, CW, CH, 0, 0, 5, 5);
  assert.ok(r1, "expected buffer");
  assert.ok(r2, "expected buffer");
  assert.notStrictEqual(r1, r2, "without reuse, should allocate new buffer each time");
}

console.log("overlay-region.test.ts: O3 persistent buffer tests passed");

// ==========================================================================
// Partial read into a REUSED buffer must not leak stale bytes
// (template partly off the wall → uncovered cells read as transparent).
// ==========================================================================
{
  const reader = makeReader();
  const w = 6, h = 6;
  const reuse = new Uint8ClampedArray(w * h * 4).fill(200); // garbage

  // Template starts 3px off the top-left, so rows/cols 0..2 are off-canvas.
  const out = readWallRegion(reader, CW, CH, -3, -3, w, h, reuse)!;
  assert.ok(out, "expected buffer for partial read");
  for (let ty = 0; ty < h; ty++) {
    for (let tx = 0; tx < w; tx++) {
      const i = (ty * w + tx) * 4;
      const wx = -3 + tx, wy = -3 + ty;
      if (wx < 0 || wy < 0) {
        // Off-canvas cell: must be zeroed, not the leftover 200s.
        assert.strictEqual(out[i], 0, `stale R leaked @(${tx},${ty})`);
        assert.strictEqual(out[i + 3], 0, `stale A leaked @(${tx},${ty})`);
      } else {
        assert.strictEqual(out[i] | (out[i + 2] << 8), wx, `covered x @(${tx},${ty})`);
      }
    }
  }
}

console.log("overlay-region.test.ts: partial-reuse zeroing test passed");
