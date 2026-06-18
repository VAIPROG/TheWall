/**
 * Tests for viewport culling math.
 * Run: bun tests/extension/viewport-cull.test.ts
 */
import assert from "node:assert";
import { visibleWallRect, cullTemplateRect } from "../../src/viewport-cull";

const WALL_W = 6000, WALL_H = 4200;

// --- Whole wall fits on screen (zoom 1, no pan) ---------------------------
{
  // wall drawn at (0,0) with on-screen width = wall width → zoom 1.
  const r = visibleWallRect(0, 0, WALL_W, 1920, 1080, WALL_W, WALL_H);
  assert.ok(r);
  assert.strictEqual(r!.x0, 0);
  assert.strictEqual(r!.y0, 0);
  assert.strictEqual(r!.x1, 1920, "viewport-limited width");
  assert.strictEqual(r!.y1, 1080, "viewport-limited height");
}

// --- Zoomed in 4×, panned so wall origin is off the top-left --------------
{
  // zoom 4 → on-screen width 24000. left=-4000 means wall x=1000 is at screen 0.
  const zoom = 4;
  const r = visibleWallRect(-4000, -2000, WALL_W * zoom, 1920, 1080, WALL_W, WALL_H);
  assert.ok(r);
  assert.strictEqual(r!.x0, 1000, "(0 - (-4000))/4");
  assert.strictEqual(r!.y0, 500, "(0 - (-2000))/4");
  assert.strictEqual(r!.x1, Math.ceil((1920 + 4000) / 4)); // 1480
  assert.strictEqual(r!.y1, Math.ceil((1080 + 2000) / 4)); // 770
}

// --- Margin expands the rect but stays clamped to wall bounds --------------
{
  const r = visibleWallRect(-4000, -2000, WALL_W * 4, 1920, 1080, WALL_W, WALL_H, 10);
  assert.strictEqual(r!.x0, 990);
  assert.strictEqual(r!.y0, 490);
}

// --- Wall entirely off screen → null --------------------------------------
{
  // wall pushed far right of the viewport.
  const r = visibleWallRect(5000, 0, WALL_W, 1920, 1080, WALL_W, WALL_H);
  // left=5000 > winW=1920 → x0 clamps to wallW area but x1<=x0.
  assert.strictEqual(r, null);
}

// --- cullTemplateRect: template fully inside visible rect ------------------
{
  const vis = { x0: 1000, y0: 500, x1: 1480, y1: 770 };
  const c = cullTemplateRect(1100, 550, 200, 150, vis);
  assert.deepStrictEqual(c, { x0: 0, y0: 0, x1: 200, y1: 150 }, "whole template visible");
}

// --- cullTemplateRect: template partly clipped by viewport -----------------
{
  const vis = { x0: 1000, y0: 500, x1: 1200, y1: 700 };
  // template at (1100,450) size 300×400 → visible local x:0..100, y:50..200
  const c = cullTemplateRect(1100, 450, 300, 400, vis);
  assert.deepStrictEqual(c, { x0: 0, y0: 50, x1: 100, y1: 250 });
}

// --- cullTemplateRect: template entirely outside viewport → null ----------
{
  const vis = { x0: 0, y0: 0, x1: 100, y1: 100 };
  assert.strictEqual(cullTemplateRect(5000, 5000, 50, 50, vis), null);
}

// --- cullTemplateRect: no viewport info → whole template ------------------
{
  const c = cullTemplateRect(10, 20, 80, 60, null);
  assert.deepStrictEqual(c, { x0: 0, y0: 0, x1: 80, y1: 60 });
}

console.log("viewport-cull.test.ts: all assertions passed");
