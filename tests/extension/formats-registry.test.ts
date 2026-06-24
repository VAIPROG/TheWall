/** Run: bun tests/extension/formats-registry.test.ts */
import assert from "node:assert";
import { decodeAny, encode } from "../../src/formats";

// charity JSON string → set
{
  const { set, id } = decodeAny('{"templates":[{"name":"a","sources":["u"],"x":1,"y":2}]}');
  assert.strictEqual(id.standard, "charity", "detected charity");
  assert.strictEqual(set.layers.length, 1, "decoded layer");
}
// wall-dev v2 string → set
{
  const { set, id } = decodeAny('{"format":"the-wall-dev/2","createdAt":"x","editedAt":"x","templates":[{"name":"a","imageSources":["u"],"x":0,"y":0,"scale":1,"width":4,"height":4}]}');
  assert.strictEqual(id.version, 2, "v2");
  assert.strictEqual(set.layers.length, 1, "layer");
}
// encode to v2 + charity
{
  const { set } = decodeAny('{"format":"the-wall-dev/2","createdAt":"x","editedAt":"x","templates":[{"name":"a","imageSources":["u"],"x":0,"y":0,"scale":1,"width":4,"height":4}]}');
  const v2 = encode(set, "wall-dev/2", {});
  assert.strictEqual((v2 as any).format, "the-wall-dev/2", "encode v2");
  const ch = encode(set, "charity", {});
  assert.ok(Array.isArray((ch as any).config.templates), "encode charity");
}
// unknown → throws
import { UnknownFormatError } from "../../src/formats/shared/parse-errors";
assert.throws(() => decodeAny("not a payload"), UnknownFormatError, "unknown throws");

console.log("formats-registry.test.ts: OK");
