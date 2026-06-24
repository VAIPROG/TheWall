/** Run: bun tests/extension/formats-parse-errors.test.ts */
import assert from "node:assert";
import { UnknownFormatError, MalformedPayloadError, NoTemplatesError } from "../../src/formats/shared/parse-errors";

{
  const e = new UnknownFormatError("nope");
  assert.ok(e instanceof Error, "extends Error");
  assert.strictEqual(e.name, "UnknownFormatError", "name set");
  assert.match(e.message, /nope/, "message carried");
}
{
  assert.strictEqual(new NoTemplatesError().name, "NoTemplatesError", "NoTemplates name");
  assert.strictEqual(new MalformedPayloadError("bad").name, "MalformedPayloadError", "Malformed name");
}
console.log("formats-parse-errors.test.ts: OK");
