/** Run: bun tests/extension/formats-charity-decode.test.ts */
import assert from "node:assert";
import { decodeCharity } from "../../src/formats/charity/decode";

// multi-template config → all layers parsed (no silent first-only)
{
  const set = decodeCharity({
    faction: "swarm", contact: "ts",
    templates: [
      { name: "a", sources: ["u1"], x: 1, y: 2 },
      { name: "b", sources: ["u2"], x: 3, y: 4, frameCount: 4, secondsPerFrame: 0.5 },
    ],
  });
  assert.strictEqual(set.layers.length, 2, "both templates decoded");
  assert.strictEqual(set.source.standard, "charity", "source standard");
  assert.strictEqual(set.layers[0].image[0], "u1", "source chain carried raw");
  assert.ok(set.layers[1].animation, "animated entry → animation spec");
  assert.strictEqual(set.layers[1].animation!.sheet.frameCount, 4, "frameCount");
}

// alias normalisation (frameRate / startTime)
{
  const set = decodeCharity({ templates: [{ x: 0, y: 0, sources: ["u"], frameCount: 2, frameRate: 0.25, startTime: 1000 }] });
  assert.strictEqual(set.layers[0].animation!.timing.defaultFrameMs, 250, "frameRate→ms");
  assert.strictEqual(set.layers[0].animation!.timing.startTime, 1000000, "startTime(s)→ms");
}

// interop tag recovered into author + stripped from name
{
  const set = decodeCharity({ templates: [{ name: "art (TheWallDev: ID:u9;BACKEND:https://api/)", sources: ["u"], x: 0, y: 0 }] });
  assert.strictEqual(set.author!.id, "u9", "author id recovered");
  assert.strictEqual(set.author!.backendUrl, "https://api/", "backend recovered");
  assert.strictEqual(set.layers[0].name, "art", "name stripped");
}

// entries without sources are skipped; empty → throws
{
  const set = decodeCharity({ templates: [{ x: 0, y: 0, sources: [] }, { x: 1, y: 1, sources: ["ok"] }] });
  assert.strictEqual(set.layers.length, 1, "sourceless entry skipped");
}
import { NoTemplatesError } from "../../src/formats/shared/parse-errors";
assert.throws(() => decodeCharity({ templates: [] }), NoTemplatesError, "no templates throws");

console.log("formats-charity-decode.test.ts: OK");
