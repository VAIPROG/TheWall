/** Run: bun tests/extension/formats-image-source.test.ts */
import assert from "node:assert";
import { resolveImageWith } from "../../src/formats/shared/image-source";

// First source fails, second wins → usedSourceIndex = 1.
{
  const loader = async (src: string) => {
    if (src === "good") return { dataUrl: "data:image/png;base64,AA", width: 5, height: 6 };
    throw new Error("fail");
  };
  const r = await resolveImageWith(["bad", "good"], loader);
  assert.strictEqual(r.usedSourceIndex, 1, "second source used");
  assert.strictEqual(r.width, 5, "width carried");
}

// All fail → throws ImageLoadFailedError.
{
  const loader = async () => { throw new Error("nope"); };
  await assert.rejects(() => resolveImageWith(["a", "b"], loader), /ImageLoadFailed/, "all fail rejects");
}
console.log("formats-image-source.test.ts: OK");
