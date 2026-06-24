/** Run: bun tests/extension/formats-binary-codec.test.ts */
import assert from "node:assert";
import {
  bytesToBase64,
  base64ToBytes,
  parseDataUrl,
  buildDataUrl,
  sniffImageMime,
  looksLikeBase64,
} from "../../src/formats/shared/binary-codec";

// round-trip base64
{
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
  const b64 = bytesToBase64(bytes);
  const back = base64ToBytes(b64);
  assert.deepStrictEqual([...back!], [...bytes], "base64 round-trips");
}

// url-safe + missing padding tolerated
{
  const bytes = base64ToBytes("iVBORw0KGgo");
  assert.ok(bytes && bytes.length > 0, "tolerates missing padding");
}

// magic sniff
{
  assert.strictEqual(sniffImageMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "image/png", "PNG magic");
  assert.strictEqual(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff])), "image/jpeg", "JPEG magic");
  const webp = new Uint8Array(12);
  webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.strictEqual(sniffImageMime(webp), "image/webp", "WEBP magic");
  assert.strictEqual(sniffImageMime(new Uint8Array([1, 2, 3])), null, "junk → null");
}

// data url build/parse
{
  const url = buildDataUrl("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  assert.ok(url.startsWith("data:image/png;base64,"), "buildDataUrl prefix");
  const parsed = parseDataUrl(url);
  assert.strictEqual(parsed!.mime, "image/png", "parseDataUrl mime");
  assert.deepStrictEqual([...parsed!.bytes], [0x89, 0x50, 0x4e, 0x47], "parseDataUrl bytes");
  assert.strictEqual(parseDataUrl("not-a-data-url"), null, "non-data-url → null");
}

// looksLikeBase64
{
  assert.ok(looksLikeBase64("a".repeat(64)), "long alphabet string");
  assert.ok(!looksLikeBase64("short"), "too short → false");
  assert.ok(!looksLikeBase64("has spaces ".repeat(8)), "spaces → false");
}

console.log("formats-binary-codec.test.ts: OK");
