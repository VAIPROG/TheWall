/**
 * Tests for the payload sniffer that the importer dispatches on.
 *
 * Run: bun tests/extension/format-detect.test.ts
 */
import assert from "node:assert";
import { detectPayload } from "../../src/format-detect";

// --- 1. Share links ---
{
  const d = detectPayload("the-wall-dev://eyJ4IjoxfQ==");
  assert.strictEqual(d.kind, "share-link", "the-wall-dev:// → share-link");
  assert.strictEqual(d.raw, "the-wall-dev://eyJ4IjoxfQ==", "raw preserved");
}

// --- 2. data: image URLs ---
{
  const d = detectPayload("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==");
  assert.strictEqual(d.kind, "data-url-image", "data:image → data-url-image");
}

// --- 3. JSON formats: wall-dev export vs charity config ---
{
  const wallDev = detectPayload('{"format":"the-wall-dev/1","template":{"name":"x"}}');
  assert.strictEqual(wallDev.kind, "wall-dev-export", "format tag → wall-dev-export");
  assert.strictEqual(wallDev.json.format, "the-wall-dev/1", "parsed json carried through");

  const charity = detectPayload('{"templates":[{"name":"a"}]}');
  assert.strictEqual(charity.kind, "charity-config", "templates[] → charity-config");
  assert.ok(Array.isArray(charity.json.templates), "charity json parsed");
}

// --- 4. Base64 wrapping a wall-dev export decodes and recurses ---
{
  const inner = JSON.stringify({
    format: "the-wall-dev/1",
    template: { name: "padded so the base64 clears the length floor" },
  });
  const b64 = btoa(inner);
  assert.ok(b64.length >= 64, "fixture must exceed the base64 length floor");
  const d = detectPayload(b64);
  assert.strictEqual(d.kind, "wall-dev-export", "base64(JSON) recurses to its kind");
}

// --- 5. Unknown / junk input ---
{
  assert.strictEqual(detectPayload("just some text").kind, "unknown", "plain text → unknown");
  assert.strictEqual(detectPayload("").kind, "unknown", "empty → unknown");
}

console.log("format-detect.test.ts: detectPayload OK");
console.log("format-detect.test.ts: all assertions passed");
