/** Run: bun tests/extension/formats-sprite-sheet.test.ts */
import assert from "node:assert";
import { autoSplit } from "../../src/formats/shared/sprite-sheet";
import { autoSplitSheet } from "../../src/animated-template";

// New autoSplit must match the legacy autoSplitSheet for representative inputs.
for (const [w, h, frameCount] of [
  [64, 64, 4], [128, 32, 4], [100, 100, 9], [256, 16, 16], [48, 48, 6],
] as Array<[number, number, number]>) {
  const legacy = autoSplitSheet(w, h, { frameCount });
  const next = autoSplit(w, h, { frameCount });
  assert.deepStrictEqual(
    next, legacy,
    `autoSplit(${w},${h},${frameCount}) matches legacy autoSplitSheet`,
  );
}

console.log("formats-sprite-sheet.test.ts: OK");
