/**
 * Unit tests for the PURE Admin-console view-model (src/ui/admin-model.ts):
 * stats cards, the user-search query builder, ban/mute duration parsing, the
 * audit-row formatter and the Prometheus metrics scrape. DOM-free — importing
 * admin-model.ts must stay side-effect free in bare Bun.
 *
 * Run: bun tests/extension/admin-model.test.ts
 */
import assert from "node:assert";
import {
  fmtNum,
  statsCards,
  userSearchQuery,
  pageCount,
  parseDuration,
  fmtDuration,
  fmtWhen,
  auditRowVM,
  parseMetrics,
  fmtUptime,
  roleBadgeKind,
  normalizeBroadcastKind,
  restrictionState,
  USER_ROLE_FILTERS,
  type AdminStats,
} from "../../src/ui/admin-model";

// ── fmtNum ───────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fmtNum(0), "0");
  assert.strictEqual(fmtNum(999), "999");
  assert.strictEqual(fmtNum(12345), "12,345");
  assert.strictEqual(fmtNum(1234567), "1,234,567");
  assert.strictEqual(fmtNum(12345.9), "12,345"); // truncates
  assert.strictEqual(fmtNum(NaN), "0");
  assert.strictEqual(fmtNum(Infinity), "0");
}
console.log("fmtNum OK");

// ── statsCards ───────────────────────────────────────────────────────────────
{
  const s: AdminStats = {
    users: 1200,
    clans: 34,
    templates: 567,
    messages: 89000,
    openReports: 3,
    activeSessions: 42,
  };
  const cards = statsCards(s);
  assert.strictEqual(cards.length, 6);
  // Fixed order, formatted values.
  assert.deepStrictEqual(
    cards.map((c) => c.key),
    ["users", "clans", "templates", "messages", "openReports", "activeSessions"],
  );
  assert.strictEqual(cards[0].value, "1,200");
  assert.strictEqual(cards[3].value, "89,000");
  // Open reports card alerts when > 0 and deep-links to the mod section.
  const rep = cards.find((c) => c.key === "openReports")!;
  assert.strictEqual(rep.alert, true);
  assert.strictEqual(rep.goto, "mod");
  // Users card deep-links to the users section.
  assert.strictEqual(cards[0].goto, "users");
  // No alert when zero reports.
  const calm = statsCards({ ...s, openReports: 0 });
  assert.strictEqual(calm.find((c) => c.key === "openReports")!.alert, false);
}
console.log("statsCards OK");

// ── userSearchQuery ─────────────────────────────────────────────────────────
{
  // Trims q, keeps valid role, clamps page/limit.
  assert.deepStrictEqual(userSearchQuery("  vai  ", "admin", 2), {
    page: 2,
    limit: 50,
    q: "vai",
    role: "admin",
  });
  // Empty q omitted; unknown role omitted; page floor 1.
  assert.deepStrictEqual(userSearchQuery("   ", "superuser", 0), { page: 1, limit: 50 });
  // NaN page → 1; limit clamped to the backend's 1..=200 window.
  assert.deepStrictEqual(userSearchQuery("", "", NaN, 9999), { page: 1, limit: 200 });
  assert.deepStrictEqual(userSearchQuery("", "", 1, 0), { page: 1, limit: 50 });
  // All four backend roles pass through.
  for (const r of USER_ROLE_FILTERS) {
    assert.strictEqual(userSearchQuery("", r, 1).role, r);
  }
  // Legacy "user" label is NOT a valid V3 filter.
  assert.strictEqual(userSearchQuery("", "user", 1).role, undefined);
}
console.log("userSearchQuery OK");

// ── pageCount ────────────────────────────────────────────────────────────────
{
  assert.strictEqual(pageCount(0, 50), 0);
  assert.strictEqual(pageCount(1, 50), 1);
  assert.strictEqual(pageCount(50, 50), 1);
  assert.strictEqual(pageCount(51, 50), 2);
  assert.strictEqual(pageCount(100, 0), 0);
}
console.log("pageCount OK");

// ── parseDuration ────────────────────────────────────────────────────────────
{
  assert.strictEqual(parseDuration(""), undefined); // permanent
  assert.strictEqual(parseDuration("   "), undefined);
  assert.strictEqual(parseDuration("30"), 30); // bare number = minutes
  assert.strictEqual(parseDuration("45m"), 45);
  assert.strictEqual(parseDuration("2h"), 120);
  assert.strictEqual(parseDuration("2 h"), 120); // tolerant of a space
  assert.strictEqual(parseDuration("7d"), 10080);
  assert.strictEqual(parseDuration("1w"), 10080);
  assert.strictEqual(parseDuration("1.5h"), 90);
  assert.strictEqual(parseDuration("0.5m"), 1); // floors at 1 minute
  assert.strictEqual(parseDuration("banana"), null);
  assert.strictEqual(parseDuration("-5h"), null);
  assert.strictEqual(parseDuration("0"), null);
  assert.strictEqual(parseDuration("2x"), null); // unknown unit
}
console.log("parseDuration OK");

// ── fmtDuration ─────────────────────────────────────────────────────────────
{
  assert.strictEqual(fmtDuration(45), "45m");
  assert.strictEqual(fmtDuration(120), "2h");
  assert.strictEqual(fmtDuration(1440), "1d");
  assert.strictEqual(fmtDuration(10080), "1w");
  assert.strictEqual(fmtDuration(90), "90m"); // not divisible → minutes
  assert.strictEqual(fmtDuration(0), "permanent");
}
console.log("fmtDuration OK");

// ── fmtWhen ─────────────────────────────────────────────────────────────────
{
  assert.strictEqual(fmtWhen(null), "");
  assert.strictEqual(fmtWhen(undefined), "");
  assert.strictEqual(fmtWhen("not-a-date"), "");
  // Local-time output — assert the shape, not the zone-dependent value.
  assert.match(fmtWhen("2026-07-18T12:34:56Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
}
console.log("fmtWhen OK");

// ── auditRowVM ──────────────────────────────────────────────────────────────
{
  const vm = auditRowVM({
    id: "a1",
    moderatorId: "m1",
    moderatorUsername: "vai",
    action: "admin_ban_applied",
    targetType: "user",
    targetId: "123e4567-e89b-42d3-a456-426614174000",
    details: { reason: "spam", expiresAt: null, count: 3 },
    createdAt: "2026-07-18T10:00:00Z",
  });
  assert.strictEqual(vm.who, "vai");
  assert.strictEqual(vm.action, "admin_ban_applied");
  // UUID targets shorten to 8 chars.
  assert.strictEqual(vm.target, "user:123e4567");
  // Null-valued detail keys dropped; strings unquoted, others JSON.
  assert.strictEqual(vm.details, "reason=spam count=3");
  assert.match(vm.when, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  // Non-UUID targets stay whole; empty details → "".
  const vm2 = auditRowVM({
    id: "a2",
    moderatorUsername: "",
    action: "admin_config_updated",
    targetType: "server",
    targetId: "config",
    details: {},
    createdAt: "2026-07-18T10:00:00Z",
  });
  assert.strictEqual(vm2.target, "server:config");
  assert.strictEqual(vm2.details, "");
  assert.strictEqual(vm2.who, "system"); // empty username falls back
}
console.log("auditRowVM OK");

// ── parseMetrics / fmtUptime ─────────────────────────────────────────────────
{
  const text = [
    "# HELP wall_uptime_seconds Server uptime in seconds",
    "# TYPE wall_uptime_seconds gauge",
    "wall_uptime_seconds 273906",
    "# HELP wall_db_pool_active Active DB connections",
    "# TYPE wall_db_pool_active gauge",
    "wall_db_pool_active 5",
    "# HELP wall_db_ok Database connectivity (1 = ok, 0 = fail)",
    "# TYPE wall_db_ok gauge",
    "wall_db_ok 1",
  ].join("\n");
  const m = parseMetrics(text);
  assert.strictEqual(m.uptimeSeconds, 273906);
  assert.strictEqual(m.poolActive, 5);
  assert.strictEqual(m.dbOk, true);

  const down = parseMetrics("wall_db_ok 0\n");
  assert.strictEqual(down.dbOk, false);
  assert.strictEqual(down.uptimeSeconds, null);

  const garbage = parseMetrics("<html>nope</html>");
  assert.deepStrictEqual(garbage, { uptimeSeconds: null, poolActive: null, dbOk: null });

  assert.strictEqual(fmtUptime(273906), "3d 4h"); // 3d 4h 5m → top two units
  assert.strictEqual(fmtUptime(3900), "1h 5m");
  assert.strictEqual(fmtUptime(59), "0m");
  assert.strictEqual(fmtUptime(null), "?");
}
console.log("parseMetrics/fmtUptime OK");

// ── roleBadgeKind ────────────────────────────────────────────────────────────
{
  assert.strictEqual(roleBadgeKind("owner"), "owner");
  assert.strictEqual(roleBadgeKind("Admin"), "admin");
  assert.strictEqual(roleBadgeKind("moderator"), "mod");
  assert.strictEqual(roleBadgeKind("member"), "member");
  assert.strictEqual(roleBadgeKind("whatever"), "member");
}
console.log("roleBadgeKind OK");

// ── normalizeBroadcastKind ───────────────────────────────────────────────────
{
  // aliases pass through
  assert.strictEqual(normalizeBroadcastKind("news"), "news");
  assert.strictEqual(normalizeBroadcastKind("announcement"), "announcement");
  assert.strictEqual(normalizeBroadcastKind("alert"), "alert");
  // case-insensitive + trims
  assert.strictEqual(normalizeBroadcastKind("  Alert "), "alert");
  // canonical types pass through
  assert.strictEqual(normalizeBroadcastKind("system_announcement"), "system_announcement");
  assert.strictEqual(normalizeBroadcastKind("mod_action"), "mod_action");
  // unknown / empty → safe default
  assert.strictEqual(normalizeBroadcastKind("nonsense"), "announcement");
  assert.strictEqual(normalizeBroadcastKind(""), "announcement");
  assert.strictEqual(normalizeBroadcastKind(null), "announcement");
  assert.strictEqual(normalizeBroadcastKind(undefined), "announcement");
}
console.log("normalizeBroadcastKind OK");

// ── restrictionState ─────────────────────────────────────────────────────────
{
  const now = Date.parse("2026-07-19T00:00:00Z");
  // active: no removedAt, no expiry (permanent)
  assert.strictEqual(restrictionState({}, now).status, "active");
  // active: future expiry
  assert.strictEqual(
    restrictionState({ expiresAt: "2026-08-01T00:00:00Z" }, now).status,
    "active",
  );
  // lifted: removedAt set (wins over any expiry)
  const lifted = restrictionState(
    { removedAt: "2026-07-10T12:00:00Z", expiresAt: "2026-08-01T00:00:00Z" },
    now,
  );
  assert.strictEqual(lifted.status, "lifted");
  assert.ok(lifted.detail.startsWith("lifted "));
  // expired: past expiry, no removedAt
  const expired = restrictionState({ expiresAt: "2026-07-01T00:00:00Z" }, now);
  assert.strictEqual(expired.status, "expired");
  assert.ok(expired.detail.startsWith("expired "));
}
console.log("restrictionState OK");

console.log("admin-model.test.ts: all assertions passed");
