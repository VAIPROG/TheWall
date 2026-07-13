/**
 * Tests for the Templates Browse layer — chip→query mapping + card badges.
 *
 * Run: bun tests/extension/templates-browse.test.ts
 */
import assert from "node:assert";
import { listParams } from "../../src/ui/templates/api";
import { cardBadges } from "../../src/ui/templates/card";

// --- listParams: chip → V3 list query (verified-only by default) ---
{
  assert.deepStrictEqual(listParams("public"), { scope: "public", status: "approved", limit: 200 });
  assert.deepStrictEqual(listParams("clan"), { scope: "clan", status: "approved", limit: 200 });
  assert.deepStrictEqual(listParams("mine"), { mine: true, limit: 200 });
  assert.deepStrictEqual(listParams("all"), { status: "approved", limit: 200 });
}

// --- listParams: showUnverified drops the status filter (mine always all) ---
{
  assert.deepStrictEqual(listParams("public", true), { scope: "public", limit: 200 });
  assert.deepStrictEqual(listParams("clan", true), { scope: "clan", limit: 200 });
  assert.deepStrictEqual(listParams("all", true), { limit: 200 });
  assert.deepStrictEqual(listParams("mine", true), { mine: true, limit: 200 });
}

// --- cardBadges: type-first (STATIC/ANIMATED) + bundle + origin-in-all ---
{
  const base = { id: "1", name: "a", userId: "u", scope: "public", status: "approved" };
  assert.ok(cardBadges({ ...base }).includes("STATIC"), "static default");
  assert.ok(cardBadges({ ...base, animated: true }).includes("ANIM"), "animated → ANIM badge");
  assert.ok(!cardBadges({ ...base, animated: true }).includes("STATIC"), "animated hides STATIC");
  assert.ok(cardBadges({ ...base, templateCount: 3 }).includes("🧩"), "bundle badge when count>1");
  assert.ok(!cardBadges({ ...base, templateCount: 1 }).includes("🧩"), "no bundle badge when count=1");
  // Approval state is no longer a card badge.
  assert.ok(!cardBadges({ ...base, status: "pending" }).includes("⏳"), "no pending hourglass on cards");
  // Origin badge only in the `all` chip.
  assert.ok(!cardBadges({ ...base }, "public").includes("PUBLIC"), "no origin badge outside all");
  assert.ok(cardBadges({ ...base }, "all").includes("PUBLIC"), "origin badge in all chip");
  assert.ok(cardBadges({ ...base, scope: "clan" }, "all").includes("CLAN"), "clan origin in all chip");
}

console.log("templates-browse: OK");
