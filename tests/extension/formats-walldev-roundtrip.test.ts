/** Run: bun tests/extension/formats-walldev-roundtrip.test.ts */
import assert from "node:assert";
import { decodeWallDev } from "../../src/formats/wall-dev/decode";
import { encodeWallDevV2 } from "../../src/formats/wall-dev/encode";

const original = {
  format: "the-wall-dev/2" as const,
  createdAt: "2026-01-01T00:00:00.000Z", editedAt: "2026-01-02T00:00:00.000Z",
  author: { id: "u1", name: "vai", backendUrl: "https://api/" },
  notes: ["changelog"], contacts: { discord: [{ type: "user", link: "https://d/u" }] },
  usersWhitelist: ["a"], domainsWhitelist: ["example.com"],
  templates: [
    { name: "a", imageSources: ["https://h/a.png"], x: 1, y: 2, z: 0, scale: 1, width: 8, height: 8 },
    { name: "b", description: "second", imageSources: ["https://h/b.png"], x: 3, y: 4, scale: 2, width: 8, height: 8,
      animation: { sheet: { frameWidth: 8, frameHeight: 8, frameCount: 4, layout: "grid", order: "row" },
        timing: { startTime: 1000, defaultFrameMs: 250, looping: true }, scaleMode: "native" } },
  ],
};

// decode → encode → decode must be stable (lossless v2 round-trip)
{
  const set = decodeWallDev(original);
  const out = encodeWallDevV2(set, {});
  assert.strictEqual(out.format, "the-wall-dev/2", "format tag");
  assert.strictEqual(out.templates.length, 2, "layers preserved");
  assert.deepStrictEqual(out.templates[0].imageSources, ["https://h/a.png"], "sources");
  assert.strictEqual(out.author && (out.author as any).id, "u1", "author id round-trips");
  assert.deepStrictEqual(out.usersWhitelist, ["a"], "access round-trips");
  assert.strictEqual(out.templates[1].animation!.sheet.frameCount, 4, "animation round-trips");
  // second decode equals first
  const set2 = decodeWallDev(out);
  assert.deepStrictEqual(set2.layers, set.layers, "layers stable across round-trip");
}

// anonymous export → author "anon"
{
  const set = decodeWallDev({ ...original, author: "anon" });
  const out = encodeWallDevV2(set, {});
  assert.strictEqual(out.author, "anon", "null author exports as anon");
}
console.log("formats-walldev-roundtrip.test.ts: OK");
