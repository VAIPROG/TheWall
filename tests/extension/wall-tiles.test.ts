/**
 * Tests for tile-grid coverage math used by template progress.
 * Run: bun tests/extension/wall-tiles.test.ts
 */
import assert from "node:assert";
import { tilesForRegion, TILE_SIZE } from "../../src/wall-tiles";

assert.strictEqual(TILE_SIZE, 256);

// --- Region fully inside one tile -----------------------------------------
{
  const r = tilesForRegion(10, 20, 30, 40);
  assert.strictEqual(r.tx0, 0); assert.strictEqual(r.ty0, 0);
  assert.strictEqual(r.tx1, 0); assert.strictEqual(r.ty1, 0);
  assert.strictEqual(r.gridX, 0); assert.strictEqual(r.gridY, 0);
  assert.strictEqual(r.cw, 256); assert.strictEqual(r.ch, 256);
  assert.strictEqual(r.sx, 10); assert.strictEqual(r.sy, 20);
}

// --- Region straddling a tile boundary → spans two tiles ------------------
{
  // x from 250..260 crosses the 256 boundary (cols 0 and 1).
  const r = tilesForRegion(250, 0, 11, 1);
  assert.strictEqual(r.tx0, 0); assert.strictEqual(r.tx1, 1);
  assert.strictEqual(r.cw, 512, "two columns wide");
  assert.strictEqual(r.gridX, 0);
  assert.strictEqual(r.sx, 250, "offset within composite");
}

// --- Region aligned to a tile origin --------------------------------------
{
  const r = tilesForRegion(512, 768, 256, 256);
  assert.strictEqual(r.tx0, 2); assert.strictEqual(r.tx1, 2);
  assert.strictEqual(r.ty0, 3); assert.strictEqual(r.ty1, 3);
  assert.strictEqual(r.gridX, 512); assert.strictEqual(r.gridY, 768);
  assert.strictEqual(r.sx, 0); assert.strictEqual(r.sy, 0);
  assert.strictEqual(r.cw, 256); assert.strictEqual(r.ch, 256);
}

// --- Region exactly filling two tiles in each axis ------------------------
{
  // 257 wide starting at 0 → cols 0 and 1 (last pixel index 256 → col 1).
  const r = tilesForRegion(0, 0, 257, 257);
  assert.strictEqual(r.tx1, 1); assert.strictEqual(r.ty1, 1);
  assert.strictEqual(r.cw, 512); assert.strictEqual(r.ch, 512);
}

// --- Large template spanning many tiles -----------------------------------
{
  const r = tilesForRegion(300, 300, 600, 600); // 300..899 → cols/rows 1..3
  assert.strictEqual(r.tx0, 1); assert.strictEqual(r.tx1, 3);
  assert.strictEqual(r.ty0, 1); assert.strictEqual(r.ty1, 3);
  assert.strictEqual(r.cw, 768); assert.strictEqual(r.ch, 768);
  assert.strictEqual(r.gridX, 256);
  assert.strictEqual(r.sx, 44); // 300 - 256
}

console.log("wall-tiles.test.ts: all assertions passed");
