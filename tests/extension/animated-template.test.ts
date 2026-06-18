/**
 * Tests for the Charity-compatible animated template core.
 * Run: bun tests/extension/animated-template.test.ts
 */
import assert from "node:assert";
import {
  negativeSafeModulo,
  getCurrentFrameIndex,
  frameRect,
  parseCharityTemplate,
  buildCharityTemplateEntry,
  buildCharityManifest,
  autoSplitSheet,
} from "../../src/animated-template";

// --- negativeSafeModulo ----------------------------------------------------
{
  assert.strictEqual(negativeSafeModulo(5, 3), 2);
  assert.strictEqual(negativeSafeModulo(-1, 3), 2);
  assert.strictEqual(negativeSafeModulo(-7, 3), 2);
  assert.strictEqual(negativeSafeModulo(0, 41), 0);
}

// --- CFRB sample config parses with all aliases ----------------------------
const CFRB = {
  name: "CFRB Animation",
  sources: ["https://s3.nwero.net/images/cfrb_sheet.png"],
  x: 2785,
  y: 405,
  frameWidth: 150,
  frameHeight: 150,
  frameRate: 900,
  frameCount: 41,
  startTime: 1780866000000,
  looping: true,
};
{
  const t = parseCharityTemplate(CFRB)!;
  assert.ok(t);
  assert.strictEqual(t.secondsPerFrame, 900, "frameRate alias → secondsPerFrame");
  assert.strictEqual(t.startTimestamp, 1780866000000, "startTime alias passes through verbatim");
  assert.strictEqual(t.frameCount, 41);
  assert.strictEqual(t.looping, true);
  assert.strictEqual(t.frameWidth, 150);
}

// --- alias precedence + defaults -------------------------------------------
{
  const t = parseCharityTemplate({ x: 0, y: 0, secondsPerFrame: 5, frameRate: 99, frameCount: 4 })!;
  assert.strictEqual(t.secondsPerFrame, 5, "secondsPerFrame wins over frameRate");
  assert.strictEqual(t.looping, true, "frameCount>1 → looping defaults on");

  const s = parseCharityTemplate({ x: 1, y: 2 })!;
  assert.strictEqual(s.frameCount, 1);
  assert.strictEqual(s.secondsPerFrame, Infinity, "static default");
  assert.strictEqual(s.looping, false, "frameCount=1 → not looping");

  assert.strictEqual(parseCharityTemplate({ y: 5 }), null, "missing x → reject like Charity");
}

// --- getCurrentFrameIndex: looping advances 1 frame per spf ----------------
{
  const t = { looping: true, startTimestamp: 1000, frameCount: 4, secondsPerFrame: 10 };
  assert.strictEqual(getCurrentFrameIndex(t, 1000), 0);
  assert.strictEqual(getCurrentFrameIndex(t, 1009.99), 0);
  assert.strictEqual(getCurrentFrameIndex(t, 1010), 1);
  assert.strictEqual(getCurrentFrameIndex(t, 1039), 3);
  assert.strictEqual(getCurrentFrameIndex(t, 1040), 0, "wraps");
  assert.strictEqual(getCurrentFrameIndex(t, 990), 3, "before start: modulo keeps cycle (Charity semantics)");
}

// --- non-looping freezes on the last frame after the run -------------------
{
  const t = { looping: false, startTimestamp: 0, frameCount: 3, secondsPerFrame: 10 };
  assert.strictEqual(getCurrentFrameIndex(t, 5), 0);
  assert.strictEqual(getCurrentFrameIndex(t, 25), 2);
  assert.strictEqual(getCurrentFrameIndex(t, 31), 2, "frozen after end");
  assert.strictEqual(getCurrentFrameIndex(t, 1e9), 2);
}

// --- static template is always frame 0 -------------------------------------
{
  assert.strictEqual(
    getCurrentFrameIndex({ looping: false, startTimestamp: 0, frameCount: 1, secondsPerFrame: Infinity }, 12345),
    0,
  );
}

// --- frameRect: row-major grid, Charity rounding ---------------------------
{
  // CFRB-like sheet: 41 frames of 150×150 in a 7-wide grid (1050×900).
  assert.deepStrictEqual(frameRect(1050, 900, 150, 150, 0), { sx: 0, sy: 0, sw: 150, sh: 150 });
  assert.deepStrictEqual(frameRect(1050, 900, 150, 150, 6), { sx: 900, sy: 0, sw: 150, sh: 150 });
  assert.deepStrictEqual(frameRect(1050, 900, 150, 150, 7), { sx: 0, sy: 150, sw: 150, sh: 150 }, "wraps to next row");
  assert.deepStrictEqual(frameRect(1050, 900, 150, 150, 40), { sx: 750, sy: 750, sw: 150, sh: 150 }, "last frame");
  // null frame size → whole image (static).
  assert.deepStrictEqual(frameRect(320, 200, null, null, 5), { sx: 0, sy: 0, sw: 320, sh: 200 });
}

// --- builder: entry mirrors the shared-config shape -------------------------
{
  const t = parseCharityTemplate(CFRB)!;
  const entry = buildCharityTemplateEntry(t);
  assert.deepStrictEqual(entry, {
    name: "CFRB Animation",
    sources: ["https://s3.nwero.net/images/cfrb_sheet.png"],
    x: 2785,
    y: 405,
    frameWidth: 150,
    frameHeight: 150,
    frameRate: 900,
    frameCount: 41,
    startTime: 1780866000000,
    looping: true,
  }, "round-trips the CFRB sample exactly");

  // Round-trip: build → parse → identical normalized template.
  assert.deepStrictEqual(parseCharityTemplate(entry), t);

  // Static template emits no animation fields.
  const st = parseCharityTemplate({ x: 1, y: 2, name: "S", sources: [] })!;
  assert.deepStrictEqual(buildCharityTemplateEntry(st), { name: "S", sources: [], x: 1, y: 2 });
}

// --- manifest wraps entries with faction/contact ----------------------------
{
  const t = parseCharityTemplate(CFRB)!;
  const m = buildCharityManifest([t], { faction: "VAI", contact: "discord" }) as any;
  assert.strictEqual(m.faction, "VAI");
  assert.strictEqual(m.contact, "discord");
  assert.strictEqual(m.templates.length, 1);
  assert.strictEqual(m.templates[0].frameCount, 41);
}

// --- autoSplitSheet: frameCount hint finds the CFRB grid ---------------------
{
  const layouts = autoSplitSheet(1050, 900, { frameCount: 41 });
  assert.ok(layouts.length > 0, "found layouts");
  const best = layouts[0];
  assert.deepStrictEqual(
    { fw: best.frameWidth, fh: best.frameHeight, cols: best.cols, rows: best.rows, waste: best.waste },
    { fw: 150, fh: 150, cols: 7, rows: 6, waste: 1 },
    "7×6 grid of 150×150 with one empty cell",
  );
}

// --- autoSplitSheet: exact grid (no waste) wins ------------------------------
{
  const layouts = autoSplitSheet(400, 100, { frameCount: 4 });
  assert.ok(layouts.length > 0);
  assert.strictEqual(layouts[0].waste, 0);
  assert.deepStrictEqual(
    { fw: layouts[0].frameWidth, fh: layouts[0].frameHeight },
    { fw: 100, fh: 100 },
    "4×1 strip of 100×100",
  );
}

// --- autoSplitSheet: explicit frame size validates divisibility -------------
{
  const ok = autoSplitSheet(1050, 900, { frameWidth: 150, frameHeight: 150, frameCount: 41 });
  assert.strictEqual(ok.length, 1);
  assert.strictEqual(ok[0].cols, 7);
  const bad = autoSplitSheet(1050, 900, { frameWidth: 151, frameHeight: 150 });
  assert.strictEqual(bad.length, 0, "non-dividing frame size rejected");
}

// --- autoSplitSheet: no hints → square-frame candidates ----------------------
{
  const layouts = autoSplitSheet(300, 200);
  assert.ok(layouts.length > 0);
  for (const l of layouts) {
    assert.strictEqual(l.frameWidth, l.frameHeight, "square candidates only");
    assert.strictEqual(300 % l.frameWidth, 0);
    assert.strictEqual(200 % l.frameHeight, 0);
    assert.ok(l.frameCount >= 2);
  }
  assert.strictEqual(layouts[0].frameWidth, 100, "largest square split first (least frames tie-broken by waste=0 & squareness)");
}

console.log("animated-template.test.ts: all assertions passed");
