/** Run: bun tests/extension/formats-charity-encode.test.ts */
import assert from "node:assert";
import { encodeCharity } from "../../src/formats/charity/encode";
import { createSet } from "../../src/formats/shared/template-set";

// single static layer → minimal entry
{
  const set = createSet({ layers: [{ name: "art", image: ["https://h/x.png"], x: 5, y: 6, scale: 1, width: 10, height: 10 }] });
  const { config, report } = encodeCharity(set, {});
  assert.strictEqual(config.templates.length, 1, "one entry");
  assert.strictEqual(config.templates[0].x, 5, "x");
  assert.strictEqual(config.templates[0].sources![0], "https://h/x.png", "source");
  assert.ok(!report.lostFields.includes("contacts"), "no contacts to lose");
}

// identity smuggled into name when author present and not opted out
{
  const set = createSet({ author: { id: "u1", backendUrl: "https://api/" },
    layers: [{ name: "art", image: ["u"], x: 0, y: 0, scale: 1, width: 4, height: 4 }] });
  const { config } = encodeCharity(set, { embedIdentity: true });
  assert.match(config.templates[0].name!, /TheWallDev: ID:u1;BACKEND:https:\/\/api\//, "identity embedded");
}

// opt-out leaves name clean
{
  const set = createSet({ author: { id: "u1" }, layers: [{ name: "art", image: ["u"], x: 0, y: 0, scale: 1, width: 4, height: 4 }] });
  const { config } = encodeCharity(set, { embedIdentity: false });
  assert.strictEqual(config.templates[0].name, "art", "no tag when opted out");
}

// multi-layer + contacts/access → reported as lost
{
  const set = createSet({
    contacts: { discord: [{ link: "https://discord/x" }] },
    access: { usersWhitelist: ["a"] },
    layers: [
      { name: "a", image: ["u"], x: 0, y: 0, scale: 1, width: 4, height: 4 },
      { name: "b", image: ["v"], x: 1, y: 1, scale: 1, width: 4, height: 4 },
    ],
  });
  const { config, report } = encodeCharity(set, {});
  assert.strictEqual(config.templates.length, 2, "both layers emitted");
  assert.ok(report.lostFields.includes("contacts"), "contacts lossy");
  assert.ok(report.lostFields.includes("access"), "access lossy");
}
console.log("formats-charity-encode.test.ts: OK");
