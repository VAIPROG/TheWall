/**
 * Pure view-model helpers for the Admin console (DOM-free, unit-tested).
 *
 * Everything here is deterministic string/number shaping so the console logic
 * in admin-ui.ts stays thin: stats → dashboard cards, the user-search query
 * builder, ban/mute duration parsing, audit-row formatting and the Prometheus
 * metrics scrape. No imports from the DOM/backend layers — the tests run in
 * bare Bun (tests/extension/admin-model.test.ts).
 */

// ---------------------------------------------------------------------------
// Dashboard stats (GET /api/v3/admin/stats)
// ---------------------------------------------------------------------------

/** Wire shape of `admin_stats` (backend/src/routes/v3/admin.rs:1318). */
export interface AdminStats {
  users: number;
  clans: number;
  templates: number;
  messages: number;
  openReports: number;
  activeSessions: number;
}

export interface StatCard {
  key: keyof AdminStats;
  label: string;
  value: string;
  /** Painted red when true (open reports demand attention). */
  alert?: boolean;
  /** Admin sub-section to jump to when the card is clicked. */
  goto?: string;
}

/** Thousands separator ("12345" → "12,345"). Negative/float safe. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Map the stats JSON to renderable dashboard cards (fixed order). */
export function statsCards(s: AdminStats): StatCard[] {
  return [
    { key: "users", label: "Users", value: fmtNum(s.users), goto: "users" },
    { key: "clans", label: "Clans", value: fmtNum(s.clans) },
    { key: "templates", label: "Templates", value: fmtNum(s.templates) },
    { key: "messages", label: "Messages", value: fmtNum(s.messages) },
    {
      key: "openReports",
      label: "Open reports",
      value: fmtNum(s.openReports),
      alert: s.openReports > 0,
      goto: "mod",
    },
    { key: "activeSessions", label: "Sessions", value: fmtNum(s.activeSessions) },
  ];
}

// ---------------------------------------------------------------------------
// User search (GET /api/v3/admin/users?q&role&page&limit)
// ---------------------------------------------------------------------------

/** Roles accepted by the backend's exact-match filter (admin.rs:1196). */
export const USER_ROLE_FILTERS = ["member", "moderator", "admin", "owner"] as const;

export interface UserSearchQuery {
  q?: string;
  role?: string;
  page: number;
  limit: number;
}

/**
 * Build the /admin/users query params. Trims the free-text term (empty →
 * omitted), drops unknown roles (backend would silently ignore them anyway —
 * omitting keeps the request honest), clamps page ≥ 1 and limit to the
 * backend's 1..=200 window.
 */
export function userSearchQuery(
  q: string,
  role: string,
  page: number,
  limit = 50,
): UserSearchQuery {
  const out: UserSearchQuery = {
    page: Math.max(1, Math.trunc(page) || 1),
    limit: Math.min(200, Math.max(1, Math.trunc(limit) || 50)),
  };
  const term = q.trim();
  if (term) out.q = term;
  if ((USER_ROLE_FILTERS as readonly string[]).includes(role)) out.role = role;
  return out;
}

/** Total pages for an offset-paginated list (0 when empty). */
export function pageCount(total: number, limit: number): number {
  if (!(total > 0) || !(limit > 0)) return 0;
  return Math.ceil(total / limit);
}

// ---------------------------------------------------------------------------
// Ban / mute durations
// ---------------------------------------------------------------------------

/**
 * Parse a human duration into MINUTES for BanRequest/MuteRequest
 * `durationMinutes`. Accepts a bare number (minutes) or number+unit
 * m/h/d/w. Returns:
 *   - `undefined` for empty input → permanent (field omitted),
 *   - `null` for garbage → caller shows a validation error,
 *   - minutes (integer ≥ 1) otherwise.
 */
export function parseDuration(text: string): number | null | undefined {
  const s = text.trim().toLowerCase();
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr|d|w)?$/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!(n > 0)) return null;
  const mult =
    { m: 1, min: 1, h: 60, hr: 60, d: 1440, w: 10080 }[m[2] ?? "m"] ?? 1;
  return Math.max(1, Math.round(n * mult));
}

/** Render minutes back to a compact "2h", "7d", "45m" label. */
export function fmtDuration(minutes: number): string {
  if (!(minutes > 0)) return "permanent";
  if (minutes % 10080 === 0) return `${minutes / 10080}w`;
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/** "YYYY-MM-DD HH:MM" in local time; "" for absent/invalid input. */
export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Audit log rows (GET /api/v3/admin/audit — AuditLogEntry, camelCase)
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  moderatorId?: string | null;
  moderatorUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}

export interface AuditRowVM {
  who: string;
  action: string;
  /** "type:shortId" — uuids shortened to 8 chars, other ids kept whole. */
  target: string;
  when: string;
  /** Compact one-line details JSON ("" when absent/empty). */
  details: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape an audit entry for a list row. */
export function auditRowVM(e: AuditEntry): AuditRowVM {
  const shortId = UUID_RE.test(e.targetId) ? e.targetId.slice(0, 8) : e.targetId;
  let details = "";
  if (e.details && typeof e.details === "object") {
    const entries = Object.entries(e.details).filter(([, v]) => v !== null && v !== undefined);
    if (entries.length) {
      details = entries
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
    }
  }
  return {
    who: e.moderatorUsername || "system",
    action: e.action,
    target: `${e.targetType}:${shortId}`,
    when: fmtWhen(e.createdAt),
    details,
  };
}

// ---------------------------------------------------------------------------
// Prometheus metrics (GET /api/v3/admin/metrics — text/plain)
// ---------------------------------------------------------------------------

export interface MetricsVM {
  uptimeSeconds: number | null;
  poolActive: number | null;
  dbOk: boolean | null;
}

/** Scrape the three wall_* gauges from the Prometheus text exposition. */
export function parseMetrics(text: string): MetricsVM {
  const num = (name: string): number | null => {
    const m = new RegExp(`^${name}\\s+(-?\\d+(?:\\.\\d+)?)\\s*$`, "m").exec(text);
    return m ? parseFloat(m[1]) : null;
  };
  const db = num("wall_db_ok");
  return {
    uptimeSeconds: num("wall_uptime_seconds"),
    poolActive: num("wall_db_pool_active"),
    dbOk: db === null ? null : db === 1,
  };
}

/** "3d 4h 12m" (largest two units), "0m" for zero/invalid. */
export function fmtUptime(secs: number | null): string {
  if (secs === null || !(secs >= 0)) return "?";
  const mins = Math.floor(secs / 60);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

/** Map a global role to the kit badge kind (unknown → member grey). */
export function roleBadgeKind(role: string): "owner" | "admin" | "mod" | "member" {
  const r = role.toLowerCase();
  if (r === "owner") return "owner";
  if (r === "admin") return "admin";
  if (r === "moderator") return "mod";
  return "member";
}
