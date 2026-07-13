/**
 * Tests for the Publish access-list parser (pure). The Publish screen itself is
 * DOM/integration; only the shared parser is unit-tested here.
 *
 * Run: bun tests/extension/templates-publish.test.ts
 */
import assert from "node:assert";
import { parseIdList } from "../../src/ui/templates/api";

// commas, spaces, newlines all split; empties dropped; duplicates deduped.
assert.deepStrictEqual(parseIdList(""), []);
assert.deepStrictEqual(parseIdList("  "), []);
assert.deepStrictEqual(parseIdList("a b c"), ["a", "b", "c"]);
assert.deepStrictEqual(parseIdList("a, b,c"), ["a", "b", "c"]);
assert.deepStrictEqual(parseIdList("a\nb\n\nc"), ["a", "b", "c"]);
assert.deepStrictEqual(parseIdList("a a b"), ["a", "b"]);
assert.deepStrictEqual(parseIdList("wplace.live  filianislost.com"), ["wplace.live", "filianislost.com"]);

console.log("templates-publish: OK");
