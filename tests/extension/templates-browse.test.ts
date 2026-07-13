/**
 * Tests for the Templates Browse layer — chip→query mapping + card badges.
 *
 * Run: bun tests/extension/templates-browse.test.ts
 */
import assert from "node:assert";
import { listParams } from "../../src/ui/templates/api";
import { cardBadges } from "../../src/ui/templates/card";

// --- listParams: chip → V3 list query ---
{
  assert.deepStrictEqual(listParams("public"), { scope: "public", status: "approved", limit: 200 });
  assert.deepStrictEqual(listParams("clan"), { scope: "clan", limit: 200 });
  assert.deepStrictEqual(listParams("mine"), { mine: true, limit: 200 });
  assert.deepStrictEqual(listParams("all"), { limit: 200 });
}

// --- cardBadges: bundle + verification state ---
{
  const base = { id: "1", name: "a", userId: "u", scope: "public" };
  assert.ok(cardBadges({ ...base, status: "approved", templateCount: 3 }).includes("🧩"), "bundle badge when count>1");
  assert.ok(!cardBadges({ ...base, status: "approved", templateCount: 1 }).includes("🧩"), "no bundle badge when count=1");
  assert.ok(cardBadges({ ...base, status: "approved" }).includes("✓"), "approved → check");
  assert.ok(cardBadges({ ...base, status: "pending" }).includes("⏳"), "pending → hourglass");
  assert.strictEqual(cardBadges({ ...base, status: "rejected" }), "", "rejected → no badge");
}

console.log("templates-browse: OK");
