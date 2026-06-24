/** Run: bun tests/extension/formats-charity-interop.test.ts */
import assert from "node:assert";
import { encodeInteropTag, parseInteropTag, stripInteropTag } from "../../src/formats/charity/interop-tag";

{
  const tag = encodeInteropTag({ id: "abc-123", backendUrl: "https://api.example/" });
  assert.match(tag, /TheWallDev: ID:abc-123;BACKEND:https:\/\/api\.example\//, "tag shape");
  const parsed = parseInteropTag(`activities :3 ${tag}`);
  assert.strictEqual(parsed!.id, "abc-123", "id recovered");
  assert.strictEqual(parsed!.backendUrl, "https://api.example/", "backend recovered");
  assert.strictEqual(stripInteropTag(`activities :3 ${tag}`).trim(), "activities :3", "tag stripped from name");
}
{
  assert.strictEqual(parseInteropTag("plain name"), null, "no tag → null");
  // id-only
  const tag = encodeInteropTag({ id: "only-id" });
  assert.strictEqual(parseInteropTag(tag)!.id, "only-id", "id-only");
  assert.strictEqual(parseInteropTag(tag)!.backendUrl, undefined, "no backend");
}
console.log("formats-charity-interop.test.ts: OK");
