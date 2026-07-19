/**
 * Tests for the Mail view-model layer — notification filter groups, badge
 * label/colour mapping, unread counting, timeAgo and actionUrl parsing.
 *
 * Run: bun tests/extension/mail-model.test.ts
 */
import assert from "node:assert";
import {
  MAIL_FILTERS,
  filterMatches,
  applyFilter,
  unreadCount,
  typeColor,
  typeLabel,
  timeAgo,
  openTarget,
  type MailFilter,
} from "../../src/mail-model";

// The full set of types the V3 backend emits today (routes/v3/notifications.rs
// + utils/notifications.rs `appeal_resolved`).
const TYPES = [
  "system_announcement",
  "news_announcement",
  "clan_invite",
  "restriction_update",
  "mod_action",
  "appeal_resolved",
  "mention",
  "template_status_change",
];

// --- filterMatches: "all" passes everything, incl. unknown future types ---
{
  for (const ty of [...TYPES, "totally_new_kind"]) {
    assert.ok(filterMatches("all", ty), `all matches ${ty}`);
  }
}

// --- filterMatches: each group matches exactly its types ---
{
  const groups: Record<Exclude<MailFilter, "all">, string[]> = {
    news: ["system_announcement", "news_announcement"],
    mentions: ["mention"],
    clan: ["clan_invite"],
    mod: ["mod_action", "restriction_update", "appeal_resolved"],
    tpl: ["template_status_change"],
  };
  for (const [filter, expected] of Object.entries(groups) as Array<[MailFilter, string[]]>) {
    for (const ty of TYPES) {
      assert.strictEqual(
        filterMatches(filter, ty),
        expected.includes(ty),
        `${filter} vs ${ty}`,
      );
    }
    // Unknown types never leak into a narrowed tab.
    assert.strictEqual(filterMatches(filter, "totally_new_kind"), false, `${filter} vs unknown`);
  }
}

// --- every known type is reachable through at least one non-"all" tab ---
{
  for (const ty of TYPES) {
    const hit = MAIL_FILTERS.some((f) => f.value !== "all" && filterMatches(f.value, ty));
    assert.ok(hit, `${ty} reachable through a filter tab`);
  }
}

// --- applyFilter: "all" returns the same array; others narrow ---
{
  const items = TYPES.map((type, i) => ({ type, id: String(i) }));
  assert.strictEqual(applyFilter(items, "all"), items, "all → same reference (no copy)");
  assert.deepStrictEqual(
    applyFilter(items, "news").map((n) => n.type),
    ["system_announcement", "news_announcement"],
  );
  assert.deepStrictEqual(applyFilter(items, "tpl").map((n) => n.type), ["template_status_change"]);
}

// --- unreadCount ---
{
  assert.strictEqual(unreadCount([]), 0);
  assert.strictEqual(
    unreadCount([{ isRead: true }, { isRead: false }, { isRead: false }]),
    2,
  );
}

// --- typeLabel: known types + initials fallback for unknown ones ---
{
  assert.strictEqual(typeLabel("system_announcement"), "SYS");
  assert.strictEqual(typeLabel("news_announcement"), "NEWS");
  assert.strictEqual(typeLabel("clan_invite"), "CLAN");
  assert.strictEqual(typeLabel("restriction_update"), "BAN");
  assert.strictEqual(typeLabel("mod_action"), "MOD");
  assert.strictEqual(typeLabel("appeal_resolved"), "APPEAL");
  assert.strictEqual(typeLabel("mention"), "@");
  assert.strictEqual(typeLabel("template_status_change"), "TPL");
  assert.strictEqual(typeLabel("weird_new_thing"), "WNT", "initials fallback");
}

// --- typeColor: every known type gets a concrete colour, unknown → sub ---
{
  for (const ty of TYPES) {
    assert.notStrictEqual(typeColor(ty), "var(--sub)", `${ty} has a colour`);
  }
  assert.strictEqual(typeColor("weird_new_thing"), "var(--sub)");
}

// --- timeAgo: boundaries with injected `now` ---
{
  const now = Date.parse("2026-07-18T12:00:00Z");
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  assert.strictEqual(timeAgo(undefined, now), "");
  assert.strictEqual(timeAgo(at(30_000), now), "now");
  assert.strictEqual(timeAgo(at(5 * 60_000), now), "5m");
  assert.strictEqual(timeAgo(at(3 * 3600_000), now), "3h");
  assert.strictEqual(timeAgo(at(2 * 86400_000), now), "2d");
}

// --- openTarget: template deep-links only, strict uuid path ---
{
  const uuid = "0b8f4a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  assert.deepStrictEqual(openTarget(`/templates/${uuid}`), { kind: "template", id: uuid });
  // Case-insensitive uuid.
  assert.deepStrictEqual(openTarget(`/templates/${uuid.toUpperCase()}`), {
    kind: "template",
    id: uuid.toUpperCase(),
  });
  assert.strictEqual(openTarget(undefined), null);
  assert.strictEqual(openTarget(""), null);
  assert.strictEqual(openTarget("/appeals"), null, "appeal link → no in-extension target");
  assert.strictEqual(openTarget("/templates/not-a-uuid"), null);
  assert.strictEqual(openTarget(`/templates/${uuid}/edit`), null, "no trailing segments");
  assert.strictEqual(openTarget(`https://evil.example//templates/${uuid}`), null, "path-style only");
}

console.log("mail-model: all assertions passed");
