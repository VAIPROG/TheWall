/** Run: bun tests/extension/formats-walldev-decode.test.ts */
import assert from "node:assert";
import { decodeWallDev } from "../../src/formats/wall-dev/decode";

// v1 single template → one layer, image_data_url → image[0]
{
  const set = decodeWallDev({
    format: "the-wall-dev/1", version: "1.0.0", exported_at: "2026-01-01T00:00:00Z",
    template: { name: "x", image_data_url: "data:image/png;base64,AA", x: 1, y: 2, scale: 1, width: 8, height: 8 },
  });
  assert.strictEqual(set.layers.length, 1, "one layer");
  assert.strictEqual(set.layers[0].image[0], "data:image/png;base64,AA", "image_data_url mapped");
  assert.strictEqual(set.source.version, 1, "version 1");
}

// v1 author maps to AuthorIdentity (username→name, clan_name→clanName);
// v1 clan_role is intentionally NOT carried (obsolete — role comes from backend).
{
  const set = decodeWallDev({
    format: "the-wall-dev/1", version: "1", exported_at: "2026-01-01T00:00:00Z",
    author: { username: "vai", clan_name: "C", clan_role: "lead" },
    template: { image_data_url: "data:image/png;base64,AA", x: 0, y: 0, scale: 1, width: 4, height: 4 },
  });
  assert.strictEqual(set.author!.name, "vai", "username→name");
  assert.strictEqual(set.author!.clanName, "C", "clan_name→clanName");
  assert.strictEqual((set.author as any).clanRole, undefined, "clan_role dropped (obsolete)");
}

// v2 multi-template → all layers; author object + contacts + access preserved
{
  const set = decodeWallDev({
    format: "the-wall-dev/2", createdAt: "2026-01-01T00:00:00Z", editedAt: "2026-01-02T00:00:00Z",
    author: { id: "u1", name: "vai", backendUrl: "https://api/" },
    notes: ["hi"], contacts: { discord: [{ type: "user", link: "https://d/u" }] },
    usersWhitelist: ["a"],
    templates: [
      { name: "a", imageSources: ["https://h/a.png", "data:image/png;base64,AA"], x: 1, y: 2, scale: 1, width: 8, height: 8 },
      { name: "b", imageSources: ["https://h/b.png"], x: 3, y: 4, scale: 2, width: 8, height: 8 },
    ],
  });
  assert.strictEqual(set.layers.length, 2, "two layers");
  assert.deepStrictEqual(set.layers[0].image, ["https://h/a.png", "data:image/png;base64,AA"], "imageSources chain preserved");
  assert.strictEqual(set.author!.id, "u1", "author id");
  assert.strictEqual(set.notes[0], "hi", "notes");
  assert.deepStrictEqual(set.access.usersWhitelist, ["a"], "access preserved");
  assert.strictEqual(set.source.version, 2, "version 2");
}

// v2 author "anon" / null → null
{
  const anon = decodeWallDev({ format: "the-wall-dev/2", createdAt: "x", editedAt: "x", author: "anon",
    templates: [{ name: "a", imageSources: ["u"], x: 0, y: 0, scale: 1, width: 4, height: 4 }] });
  assert.strictEqual(anon.author, null, "anon → null");
}
console.log("formats-walldev-decode.test.ts: OK");
