/**
 * Tests for the WallAnim v1 format core.
 * Run: bun tests/extension/wall-anim.test.ts
 */
import assert from "node:assert";
import {
  WALL_ANIM_FORMAT,
  parseWallAnim,
  buildTimeline,
  frameAt,
  wallAnimFrameRect,
  runtimeFromWallAnim,
  runtimeFromCharity,
  fromCharity,
  toCharityEntry,
  type WallAnimConfig,
} from "../../src/wall-anim";
import { parseCharityTemplate } from "../../src/animated-template";

function base(over: Partial<WallAnimConfig> = {}): WallAnimConfig {
  return parseWallAnim({
    format: WALL_ANIM_FORMAT,
    name: "T",
    sources: ["https://x/sheet.png"],
    x: 10,
    y: 20,
    sheet: { frameWidth: 100, frameHeight: 100, frameCount: 4, layout: "grid", order: "row" },
    timing: { startTime: 0, defaultFrameMs: 1000, looping: true },
    scaling: { mode: "native" },
    ...over,
  })!;
}

// --- parse: rejects junk, fills defaults ------------------------------------
{
  assert.strictEqual(parseWallAnim({}), null);
  assert.strictEqual(parseWallAnim({ format: WALL_ANIM_FORMAT, x: 1 }), null, "missing y/sheet");
  assert.strictEqual(
    parseWallAnim({ format: WALL_ANIM_FORMAT, x: 1, y: 2, sheet: { frameWidth: 0, frameHeight: 5, frameCount: 1 } }),
    null,
    "zero frame size rejected",
  );
  const c = parseWallAnim({
    format: WALL_ANIM_FORMAT,
    x: 1, y: 2,
    sheet: { frameWidth: 10, frameHeight: 10, frameCount: 3, layout: "weird", order: "weird" },
    timing: {},
    scaling: {},
  })!;
  assert.strictEqual(c.sheet.layout, "line", "bad layout → line");
  assert.strictEqual(c.sheet.order, "row", "bad order → row");
  assert.strictEqual(c.timing.defaultFrameMs, 1000);
  assert.strictEqual(c.timing.looping, true, "frameCount>1 → looping default");
  assert.strictEqual(c.scaling.mode, "native");
  // out-of-range overrides dropped
  const d = base({ timing: { startTime: 0, defaultFrameMs: 500, looping: true, frames: [{ index: 99 }, { index: 1, durationMs: 700 }] } as any });
  assert.strictEqual(d.timing.frames!.length, 1);
}

// --- timeline: per-frame durations + skip -----------------------------------
{
  const cfg = base({
    timing: {
      startTime: 0,
      defaultFrameMs: 1000,
      looping: true,
      frames: [
        { index: 1, durationMs: 3000 },
        { index: 2, skip: true },
      ],
    },
  });
  const tl = buildTimeline(cfg);
  assert.deepStrictEqual(
    tl.entries.map((e) => [e.frame, e.durationMs]),
    [[0, 1000], [1, 3000], [3, 1000]],
    "skip removes frame 2; frame 1 stretched",
  );
  assert.strictEqual(tl.totalMs, 5000);

  // walk: [0..1000)→f0, [1000..4000)→f1, [4000..5000)→f3, wraps
  assert.strictEqual(frameAt(cfg, tl, 0), 0);
  assert.strictEqual(frameAt(cfg, tl, 999), 0);
  assert.strictEqual(frameAt(cfg, tl, 1000), 1);
  assert.strictEqual(frameAt(cfg, tl, 3999), 1);
  assert.strictEqual(frameAt(cfg, tl, 4000), 3);
  assert.strictEqual(frameAt(cfg, tl, 5000), 0, "loops");
  assert.strictEqual(frameAt(cfg, tl, -500), 3, "negative time wraps (shared clock)");
}

// --- non-looping clamps both ends -------------------------------------------
{
  const cfg = base({ timing: { startTime: 10_000, defaultFrameMs: 1000, looping: false } });
  const tl = buildTimeline(cfg);
  assert.strictEqual(frameAt(cfg, tl, 0), 0, "before start → first");
  assert.strictEqual(frameAt(cfg, tl, 10_500), 0);
  assert.strictEqual(frameAt(cfg, tl, 13_500), 3);
  assert.strictEqual(frameAt(cfg, tl, 99_999), 3, "after end → last");
}

// --- grid traversal orders ----------------------------------------------------
{
  // 3×2 grid of 100px frames in a 300×200 sheet.
  const mk = (order: "row" | "column" | "serpentine") =>
    base({ sheet: { frameWidth: 100, frameHeight: 100, frameCount: 6, layout: "grid", order } });
  const at = (cfg: WallAnimConfig, i: number) => {
    const r = wallAnimFrameRect(cfg, 300, 200, i);
    return [r.sx / 100, r.sy / 100];
  };
  const row = mk("row");
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => at(row, i)), [
    [0, 0], [1, 0], [2, 0],
    [0, 1], [1, 1], [2, 1],
  ]);
  const col = mk("column");
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => at(col, i)), [
    [0, 0], [0, 1],
    [1, 0], [1, 1],
    [2, 0], [2, 1],
  ]);
  const serp = mk("serpentine");
  assert.deepStrictEqual([0, 1, 2, 3, 4, 5].map((i) => at(serp, i)), [
    [0, 0], [1, 0], [2, 0],
    [2, 1], [1, 1], [0, 1],
  ], "odd rows run right-to-left");

  // line layout ignores image height entirely.
  const line = base({ sheet: { frameWidth: 100, frameHeight: 100, frameCount: 4, layout: "line", order: "row" } });
  assert.deepStrictEqual(wallAnimFrameRect(line, 400, 100, 3), { sx: 300, sy: 0, sw: 100, sh: 100 });
}

// --- runtime: scaling policy ---------------------------------------------------
{
  const native = runtimeFromWallAnim(base());
  assert.strictEqual(native.scaleOverride, 1, "native → forced 100%");
  const scaled = runtimeFromWallAnim(base({ scaling: { mode: "scaled", scale: 2 } }));
  assert.strictEqual(scaled.scaleOverride, 2);
  const userScaled = runtimeFromWallAnim(base({ scaling: { mode: "scaled" } }));
  assert.strictEqual(userScaled.scaleOverride, null, "scaled w/o factor → user's overlay scale");

  // Charity runtime is always 100%.
  const ch = parseCharityTemplate({ x: 0, y: 0, frameWidth: 10, frameHeight: 10, frameCount: 4, frameRate: 10 })!;
  const chRt = runtimeFromCharity(ch)!;
  assert.strictEqual(chRt.scaleOverride, 1);
  assert.strictEqual(chRt.frameAt(0), 0);
  assert.strictEqual(chRt.frameAt(10_000), 1, "10s per frame in ms clock");
}

// --- Charity import: seconds vs ms heuristic -----------------------------------
{
  const secs = fromCharity(parseCharityTemplate({ x: 0, y: 0, frameWidth: 1, frameHeight: 1, frameCount: 2, frameRate: 5, startTime: 1700000000 })!);
  assert.strictEqual(secs.timing.startTime, 1700000000 * 1000, "seconds → ms");
  const ms = fromCharity(parseCharityTemplate({ x: 0, y: 0, frameWidth: 1, frameHeight: 1, frameCount: 2, frameRate: 5, startTime: 1780866000000 })!);
  assert.strictEqual(ms.timing.startTime, 1780866000000, "already ms (CFRB-style) kept");
  assert.strictEqual(secs.timing.defaultFrameMs, 5000);
}

// --- Charity export: flattening reported, shape exact ----------------------------
{
  const cfg = base({
    timing: { startTime: 1700000000000, defaultFrameMs: 900_000, looping: true, frames: [{ index: 0, durationMs: 1 }] },
    sheet: { frameWidth: 150, frameHeight: 150, frameCount: 41, layout: "grid", order: "serpentine" },
    scaling: { mode: "scaled", scale: 2 },
  });
  const { entry, lossy } = toCharityEntry(cfg);
  assert.strictEqual(entry.frameRate, 900, "ms → seconds");
  assert.strictEqual(entry.startTime, 1700000000, "ms → seconds");
  assert.strictEqual(entry.frameCount, 41);
  assert.strictEqual(lossy.length, 3, "per-frame + order + scaling all reported");

  const clean = toCharityEntry(base());
  assert.deepStrictEqual(clean.lossy, [], "plain config exports losslessly");
}

console.log("wall-anim.test.ts: all assertions passed");
