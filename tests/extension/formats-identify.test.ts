/** Run: bun tests/extension/formats-identify.test.ts */
import assert from "node:assert";
import { identify } from "../../src/formats/shared/format-identify";

// share-link
{
  const id = identify("the-wall-dev://eyJ4IjoxfQ==");
  assert.strictEqual(id.standard, "wall-dev", "share-link → wall-dev");
}
// data-url image
{
  assert.strictEqual(identify("data:image/png;base64,iVBORw0KGgo").standard, "image", "data url → image");
}
// v1 / v2 tags
{
  assert.deepStrictEqual(
    [identify('{"format":"the-wall-dev/1","template":{}}').standard,
     identify('{"format":"the-wall-dev/1","template":{}}').version],
    ["wall-dev", 1], "v1 tag");
  assert.strictEqual(identify('{"format":"the-wall-dev/2","templates":[]}').version, 2, "v2 tag");
}
// charity: templates[] and bare entry
{
  assert.strictEqual(identify('{"templates":[{"x":1,"y":2,"sources":["u"]}]}').standard, "charity", "templates[] → charity");
  assert.strictEqual(identify('{"x":1,"y":2,"sources":["u"]}').standard, "charity", "bare charity entry");
}
// base64-wrapped JSON recurses
{
  const inner = JSON.stringify({ format: "the-wall-dev/2", templates: [], pad: "x".repeat(60) });
  assert.strictEqual(identify(btoa(inner)).version, 2, "base64(JSON) recurses");
}
// unknown
{
  assert.strictEqual(identify("just text").standard, "unknown", "text → unknown");
  assert.strictEqual(identify("").standard, "unknown", "empty → unknown");
}
// confidence + reason present
{
  const id = identify('{"format":"the-wall-dev/2","templates":[]}');
  assert.ok(id.confidence > 0 && typeof id.reason === "string" && id.reason.length > 0, "confidence + reason");
}
console.log("formats-identify.test.ts: OK");
