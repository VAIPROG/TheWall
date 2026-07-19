import { BackendClient } from "./client";

// ---------------------------------------------------------------------------
// Wire shapes — verified against backend/src/routes/v3/admin.rs (+ models).
// serde is `rename_all = "camelCase"` everywhere EXCEPT where noted.
// ---------------------------------------------------------------------------

/** `admin_stats` JSON (admin.rs:1318). */
export interface AdminStatsWire {
  users: number;
  clans: number;
  templates: number;
  messages: number;
  openReports: number;
  activeSessions: number;
}

/** One row of `models::users::User`. NOTE: `external_id` serialises as the
 *  LEGACY key `wall_id` (models/users.rs:13) — not camelCase. */
export interface AdminUserRow {
  id: string;
  wall_id: string;
  username: string;
  displayName?: string | null;
  bio?: string | null;
  lang?: string | null;
  telemetryOptIn?: boolean;
  role: string;
  globalRole: string;
  source: string;
  discordId?: string | null;
  discordUsername?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `admin_list_users` envelope (admin.rs:1228). */
export interface AdminUserPage {
  users: AdminUserRow[];
  page: number;
  limit: number;
  total: number;
}

/** `SessionSummary` (models/auth.rs:24). */
export interface AdminSession {
  sessionId: string;
  ip?: string | null;
  userAgent?: string | null;
  createdAt: string;
  lastActivityAt?: string | null;
}

/** `AdminNote` (admin.rs:604). */
export interface AdminNoteWire {
  id: string;
  authorId: string;
  authorUsername?: string | null;
  content: string;
  createdAt: string;
}

/** `AuditLogEntry` / `AuditLogPage` (models/moderation.rs:325/354). */
export interface AdminAuditEntry {
  id: string;
  moderatorId?: string | null;
  moderatorUsername: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: Record<string, unknown> | null;
  createdAt: string;
}
export interface AdminAuditPage {
  items: AdminAuditEntry[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** `ServerConfig` (admin.rs:830). */
export interface ServerConfigWire {
  maxUsersPerClan: number;
  maxTemplatesPerUser: number;
  maxApiKeysPerUser: number;
  maxFileSizeMb: number;
  rateLimitPerMinute: number;
  maintenanceMode: boolean;
  featureFlags: Record<string, boolean>;
  allowPublicTemplatePublishing: boolean;
  autoApproveModeratorTemplates: boolean;
}

/** `MaintenanceStatus` (admin.rs:875). */
export interface MaintenanceStatusWire {
  enabled: boolean;
  reason?: string | null;
  estimatedEndTime?: string | null;
}

/** `admin_impersonate_user` → `V3AuthResponse` (admin.rs:728). */
export interface ImpersonateResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
  user: { id: string; username: string; displayName?: string | null; role: string };
}

export function buildAdminApi(client: BackendClient) {
  const u = (ref: string) => `/admin/users/${encodeURIComponent(ref)}`;
  return {
    // --- lists / dashboard -------------------------------------------------
    /** Search users: free-text q + exact role filter + page/limit (camelCase
     *  query names match `AdminUserListQuery`, admin.rs:1167). */
    listUsers: (params?: { q?: string; role?: string; page?: number; limit?: number }) =>
      client.get<AdminUserPage>("/admin/users", params),

    stats: () => client.get<AdminStatsWire>("/admin/stats"),

    /** Prometheus text exposition (client returns non-JSON bodies as string). */
    metrics: () => client.get<string>("/admin/metrics"),

    // --- per-user ------------------------------------------------------------
    getUser: (ref: string) => client.get<AdminUserRow>(u(ref)),

    updateUser: (ref: string, body: Record<string, unknown>) =>
      client.patch<AdminUserRow>(u(ref), body),

    ban: (ref: string, reason?: string, durationMinutes?: number) =>
      client.post(`${u(ref)}/ban`, { reason, durationMinutes }),

    unban: (ref: string) => client.delete(`${u(ref)}/ban`),

    mute: (ref: string, reason?: string, durationMinutes?: number) =>
      client.post(`${u(ref)}/mute`, { reason, durationMinutes }),

    unmute: (ref: string) => client.delete(`${u(ref)}/mute`),

    promote: (ref: string, role: string) => client.post<AdminUserRow>(`${u(ref)}/promote`, { role }),

    /** Owner-only. The backend demands the literal word in a `confirmation`
     *  field (ConfirmationRequest, admin.rs:395) — the UI collects it from a
     *  type-the-word dialog and passes it through verbatim. */
    wipeout: (ref: string, confirmation: string) =>
      client.post(`${u(ref)}/wipeout`, { confirmation }),

    removeFromClan: (ref: string) => client.post(`${u(ref)}/remove-from-clan`, {}),

    resetAvatar: (ref: string) => client.post(`${u(ref)}/reset-avatar`, {}),

    resetUsername: (ref: string) =>
      client.post<{ ok: boolean; newUsername?: string }>(`${u(ref)}/reset-username`, {}),

    sessions: (ref: string) => client.get<AdminSession[]>(`${u(ref)}/sessions`),

    terminateSessions: (ref: string) =>
      client.delete<{ ok: boolean; count?: number }>(`${u(ref)}/sessions`),

    notes: (ref: string) => client.get<AdminNoteWire[]>(`${u(ref)}/notes`),

    addNote: (ref: string, content: string) =>
      client.post<AdminNoteWire>(`${u(ref)}/notes`, { content }),

    impersonate: (ref: string, durationMinutes?: number) =>
      client.post<ImpersonateResponse>(`${u(ref)}/impersonate`, { durationMinutes }),

    // --- messages ------------------------------------------------------------
    /** Global soft-delete of any chat message (moderator+). */
    deleteMessage: (id: string) =>
      client.delete(`/admin/messages/${encodeURIComponent(id)}`),

    // --- audit / system --------------------------------------------------------
    /** NOTE: `AdminAuditQuery` (admin.rs:747) has NO serde rename — the query
     *  params are snake_case (`per_page`, `target_type`), unlike the bodies. */
    audit: (params?: { page?: number; perPage?: number; action?: string; targetType?: string }) =>
      client.get<AdminAuditPage>("/admin/audit", {
        page: params?.page,
        per_page: params?.perPage,
        action: params?.action,
        target_type: params?.targetType,
      }),

    config: () => client.get<ServerConfigWire>("/admin/config"),

    /** Owner-only on the backend; partial camelCase body (ServerConfigUpdate). */
    updateConfig: (body: Record<string, unknown>) =>
      client.patch<ServerConfigWire>("/admin/config", body),

    maintenance: () => client.get<MaintenanceStatusWire>("/admin/maintenance"),

    setMaintenance: (body: { enabled: boolean; reason?: string; estimatedDurationMinutes?: number }) =>
      client.post<MaintenanceStatusWire>("/admin/maintenance", body),

    /** V3 broadcast (admin.rs:1005): plain message + optional role/user
     *  targeting. It lands as a `system_announcement` notification titled
     *  "Broadcast" — the richer title/kind composer stays on the legacy
     *  `/admin/broadcast` (see ui/admin-ui.ts broadcastNotification). */
    broadcast: (body: { message: string; targetRole?: string; targetUserIds?: string[] }) =>
      client.post<{ ok: boolean; recipients?: number }>("/admin/broadcast", body),

    // Deliberately NOT exposed: POST /admin/shutdown and /admin/restart. The
    // handlers can't actually stop the process (they only audit-log and ask
    // for operator action, admin.rs:1087) — surfacing prod kill switches in
    // the extension for a no-op would be all risk, no value.
  };
}
