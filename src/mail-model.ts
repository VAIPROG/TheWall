/**
 * Pure view-model layer for the Mail sub-section (V3 notifications inbox).
 *
 * DOM-free on purpose so every mapping here is unit-testable bare-Bun
 * (tests/extension/mail-model.test.ts). Shapes mirror the real V3 surface:
 * backend/src/routes/v3/notifications.rs emits `NotificationView` rows with
 * camelCase serde and one of the types listed in {@link filterMatches}.
 */

// ---------------------------------------------------------------------------
// Filter tabbar
// ---------------------------------------------------------------------------

/** Client-side filter groups over the V3 notification `type` field. The V3
 *  list endpoint only filters by read-state server-side, so kind filtering
 *  happens on the fetched page. */
export type MailFilter = "all" | "news" | "mentions" | "clan" | "mod" | "tpl";

/** Tabbar entries, in render order. Labels are short on purpose — six buttons
 *  must fit one Win95 tabbar row. */
export const MAIL_FILTERS: ReadonlyArray<{ value: MailFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "news", label: "News" },
  { value: "mentions", label: "@" },
  { value: "clan", label: "Clan" },
  { value: "mod", label: "Mod" },
  { value: "tpl", label: "Tpl" },
];

/** Does a notification of `type` belong under `filter`?
 *  Unknown/future types only surface under "all" so they are never lost. */
export function filterMatches(filter: MailFilter, type: string): boolean {
  switch (filter) {
    case "all":
      return true;
    case "news":
      return type === "system_announcement" || type === "news_announcement";
    case "mentions":
      return type === "mention";
    case "clan":
      return type === "clan_invite";
    case "mod":
      return type === "mod_action" || type === "restriction_update" || type === "appeal_resolved";
    case "tpl":
      return type === "template_status_change";
  }
}

/** Filter a page of notifications down to one tab's view. */
export function applyFilter<T extends { type: string }>(items: T[], filter: MailFilter): T[] {
  return filter === "all" ? items : items.filter((n) => filterMatches(filter, n.type));
}

/** Unread count across the WHOLE page (badge + mark-all confirm), independent
 *  of the active filter so the badge never under-reports. */
export function unreadCount(items: Array<{ isRead: boolean }>): number {
  return items.filter((n) => !n.isRead).length;
}

// ---------------------------------------------------------------------------
// Per-item presentation
// ---------------------------------------------------------------------------

/** Badge colour per notification type (Win95 kit palette). */
export function typeColor(type: string): string {
  switch (type) {
    case "system_announcement": return "#08a";
    case "news_announcement": return "#48a";
    case "clan_invite": return "#c93";
    case "restriction_update": return "#c33";
    case "mod_action": return "#a3a";
    case "appeal_resolved": return "#a3a";
    case "mention": return "#393";
    case "template_status_change": return "#393";
    default: return "var(--sub)";
  }
}

/** Short badge label per type; unknown types fall back to their initials. */
export function typeLabel(type: string): string {
  switch (type) {
    case "system_announcement": return "SYS";
    case "news_announcement": return "NEWS";
    case "clan_invite": return "CLAN";
    case "restriction_update": return "BAN";
    case "mod_action": return "MOD";
    case "appeal_resolved": return "APPEAL";
    case "mention": return "@";
    case "template_status_change": return "TPL";
    default: return type.split("_").map((s) => s[0] || "").join("").toUpperCase();
  }
}

/** Compact relative timestamp ("now" / "5m" / "3h" / "2d"). `now` injectable
 *  for tests. */
export function timeAgo(iso?: string, now = Date.now()): string {
  if (!iso) return "";
  const diff = now - new Date(iso).getTime();
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86400_000) return Math.floor(diff / 3600_000) + "h";
  return Math.floor(diff / 86400_000) + "d";
}

// ---------------------------------------------------------------------------
// "Open" deep-link
// ---------------------------------------------------------------------------

export interface OpenTarget {
  kind: "template";
  id: string;
}

/**
 * Parse a notification `actionUrl` into an in-extension navigation target.
 * The only actionUrl the V3 backend emits today is `/templates/{uuid}` (from
 * template verify/reject — see backend/src/routes/v3/templates/verify.rs);
 * anything else returns null and the row simply has no Open button.
 */
export function openTarget(actionUrl?: string): OpenTarget | null {
  const m = /^\/templates\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    actionUrl || "",
  );
  return m ? { kind: "template", id: m[1] } : null;
}
