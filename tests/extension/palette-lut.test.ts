/**
 * Tests for palette LUT quantization and HEX cache.
 *
 * Run: bun tests/extension/palette-lut.test.ts
 */
import assert from "node:assert";
import { PALETTE, PALETTE_RGB, quantizeBuffer, HEX } from "../../src/palette";

// --- 1. HEX cache correctness ---
{
  assert.strictEqual(HEX.length, 256, "HEX should have 256 entries");
  assert.strictEqual(HEX[0], "00", "HEX[0] = '00'");
  assert.strictEqual(HEX[15], "0f", "HEX[15] = '0f'");
  assert.strictEqual(HEX[16], "10", "HEX[16] = '10'");
  assert.strictEqual(HEX[255], "ff", "HEX[255] = 'ff'");
  assert.strictEqual(HEX[128], "80", "HEX[128] = '80'");
  for (let i = 0; i < 256; i++) {
    const expected = i.toString(16).padStart(2, "0");
    assert.strictEqual(HEX[i], expected, `HEX[${i}] should be '${expected}'`);
  }
}
console.log("palette-lut.test.ts: HEX cache OK");

// --- 2. LUT maps every palette color to itself ---
{
  for (let j = 0; j < PALETTE_RGB.length; j++) {
    const [r, g, b] = PALETTE_RGB[j];
    const buf = new Uint8ClampedArray([r, g, b, 255]);
    quantizeBuffer(buf);
    assert.strictEqual(buf[0], r, `palette[${j}] R should stay ${r}`);
    assert.strictEqual(buf[1], g, `palette[${j}] G should stay ${g}`);
    assert.strictEqual(buf[2], b, `palette[${j}] B should stay ${b}`);
    assert.strictEqual(buf[3], 255, `palette[${j}] A should stay 255`);
  }
}
console.log("palette-lut.test.ts: palette self-quantize OK");

// --- 3. Transparent pixels (alpha < 128) become fully transparent ---
{
  const buf = new Uint8ClampedArray([100, 200, 50, 100]);
  quantizeBuffer(buf);
  assert.strictEqual(buf[3], 0, "alpha < 128 → alpha 0");
}
{
  const buf = new Uint8ClampedArray([100, 200, 50, 0]);
  quantizeBuffer(buf);
  assert.strictEqual(buf[3], 0, "alpha 0 → stays 0");
}
{
  const buf = new Uint8ClampedArray([100, 200, 50, 200]);
  quantizeBuffer(buf);
  assert.strictEqual(buf[3], 255, "alpha >= 128 → 255");
}
console.log("palette-lut.test.ts: transparent pixel OK");

// --- 4. Nearest-palette correctness for known colors ---
{
  // White (255,255,255) should map to palette[0] = #ffffff = (255,255,255)
  const buf = new Uint8ClampedArray([255, 255, 255, 255]);
  quantizeBuffer(buf);
  assert.deepStrictEqual(
    [buf[0], buf[1], buf[2]],
    PALETTE_RGB[0],
    "white → palette[0]",
  );
}
{
  // Pure red (255,0,0) — find nearest palette color
  const buf = new Uint8ClampedArray([255, 0, 0, 255]);
  quantizeBuffer(buf);
  assert.strictEqual(buf[3], 255, "red quantizes to opaque");
  // Should map to some palette entry (C8362C = index 12)
  let best = 0, bestDist = Infinity;
  for (let j = 0; j < PALETTE_RGB.length; j++) {
    const [r, g, b] = PALETTE_RGB[j];
    const d = (255 - r) ** 2 + g ** 2 + b ** 2;
    if (d < bestDist) { bestDist = d; best = j; }
  }
  assert.deepStrictEqual(
    [buf[0], buf[1], buf[2]],
    PALETTE_RGB[best],
    "red → nearest palette color",
  );
}
console.log("palette-lut.test.ts: nearest-palette OK");

// --- 5. Batch quantize: multi-pixel buffer ---
{
  const pixels = 100;
  const buf = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels * 4; i += 4) {
    buf[i] = 200; buf[i + 1] = 50; buf[i + 2] = 50; buf[i + 3] = 255;
  }
  quantizeBuffer(buf);
  const [pr, pg, pb] = [buf[0], buf[1], buf[2]];
  for (let i = 4; i < buf.length; i += 4) {
    assert.strictEqual(buf[i], pr, `pixel ${i / 4} R matches`);
    assert.strictEqual(buf[i + 1], pg, `pixel ${i / 4} G matches`);
    assert.strictEqual(buf[i + 2], pb, `pixel ${i / 4} B matches`);
  }
}
console.log("palette-lut.test.ts: batch quantize OK");

// --- 6. Determinism: same input → same output every time ---
{
  const a = new Uint8ClampedArray([123, 45, 67, 255]);
  const b = new Uint8ClampedArray([123, 45, 67, 255]);
  quantizeBuffer(a);
  quantizeBuffer(b);
  assert.deepStrictEqual(Array.from(a), Array.from(b), "deterministic quantize");
}
console.log("palette-lut.test.ts: determinism OK");

console.log("palette-lut.test.ts: all assertions passed");
