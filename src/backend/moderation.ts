import { BackendClient } from "./client";
import { Report, Restriction } from "./types";

export interface CreateRestrictionRequest {
  userId: string;
  kind: "ban" | "mute" | "clan_mute";
  scope?: "global" | "clan";
  scopeId?: string;
  reason?: string;
  durationMinutes?: number;
}

export interface CreateReportRequest {
  targetType: string;
  targetId: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Wire shapes — verified against backend/src/routes/v3/moderation/* + models.
// ---------------------------------------------------------------------------

/** `RestrictionView` (models/moderation.rs:74). NOTE: the view omits
 *  `removedAt` — a lifted restriction is indistinguishable from an active
 *  permanent one on this wire (flagged as a backend gap). */
export interface RestrictionViewWire {
  id: string;
  userId: string;
  scope: string;
  clanId?: string | null;
  appliedBy?: string | null;
  appliedAt: string;
  expiresAt?: string | null;
  reason?: string | null;
  sanctions: {
    mute: boolean;
    ban: boolean;
    publishTemplates: boolean;
    inviteToClan: boolean;
    sendReports: boolean;
    sendModmail: boolean;
  };
}

export interface RestrictionPageWire {
  items: RestrictionViewWire[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** `ReportView` (models/moderation.rs:182). */
export interface ReportViewWire {
  id: string;
  type: string;
  targetId: string;
  targetType: string;
  reporterId?: string | null;
  reporterUsername: string;
  reason: string;
  evidence?: string | null;
  status: "open" | "reviewing" | "resolved" | "dismissed";
  assignedModId?: string | null;
  resolution?: string | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportPageWire {
  items: ReportViewWire[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

/** Valid `ReportResolve.resolution` values (reports.rs:252). */
export type ReportResolution =
  | "content_removed"
  | "no_action_needed"
  | "user_warned"
  | "user_restricted"
  | "other";

/** Valid `ReportDismiss.reason` values (reports.rs:343). */
export type ReportDismissReason = "duplicate" | "false_report" | "not_actionable" | "other";

/** `TemplateSummary` as returned by the moderation queue (models/templates.rs:94). */
export interface QueueTemplateWire {
  id: string;
  userId?: string | null;
  name: string;
  x: number;
  y: number;
  scale: number;
  scope: string;
  status: string;
  version: number;
  clanId?: string | null;
  verifiedAt?: string | null;
  createdAt: string;
  hasDocument: boolean;
}

export interface QueuePageWire {
  items: QueueTemplateWire[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export function buildModerationApi(client: BackendClient) {
  return {
    // Restrictions -------------------------------------------------------
    /** Moderator+; returns the RestrictionPage envelope (restrictions.rs:180). */
    listRestrictions: (params?: { userId?: string; scope?: string; active?: boolean; page?: number; perPage?: number }) =>
      client.get<RestrictionPageWire>("/restrictions", {
        user_id: params?.userId,
        scope: params?.scope,
        active: params?.active,
        page: params?.page,
        per_page: params?.perPage,
      }),

    // NOTE: no `createRestriction` wrapper — the backend `RestrictionCreate`
    // takes a nested `sanctions` object (models/moderation.rs), not the flat
    // shape the old wrapper sent (it would 400). Restrictions are created via
    // the report-resolve path (`resolveReport({ createRestriction: true })`).

    getRestriction: (id: string) => client.get<Restriction>(`/restrictions/${encodeURIComponent(id)}`),

    updateRestriction: (id: string, body: Partial<CreateRestrictionRequest>) =>
      client.patch<Restriction>(`/restrictions/${encodeURIComponent(id)}`, body),

    deleteRestriction: (id: string) => client.delete(`/restrictions/${encodeURIComponent(id)}`),

    /** Paginated envelope (restrictions.rs:494 returns RestrictionPage, not a
     *  bare array). Lists ALL rows newest-first — `UserRestrictionsQuery` has
     *  no `active` filter (only the global `/restrictions` list does). */
    userRestrictions: (userRef: string, params?: { page?: number; perPage?: number }) =>
      client.get<RestrictionPageWire>(`/users/${encodeURIComponent(userRef)}/restrictions`, {
        page: params?.page,
        per_page: params?.perPage,
      }),

    // Reports ------------------------------------------------------------
    /** NOTE: `ListReportsQuery` (reports.rs:104) has no serde rename — the
     *  query params are snake_case `per_page` and the type filter is the
     *  literal `type`. */
    listReports: (params?: { page?: number; perPage?: number; status?: string; type?: string }) =>
      client.get<ReportPageWire>("/moderation/reports", {
        page: params?.page,
        per_page: params?.perPage,
        status: params?.status,
        type: params?.type,
      }),

    getReport: (id: string) => client.get<ReportViewWire>(`/moderation/reports/${encodeURIComponent(id)}`),

    /** PATCH: move status (open/reviewing/resolved/dismissed), assign, note.
     *  Setting `reviewing` with no assignee auto-assigns the caller. */
    updateReport: (id: string, body: { status?: string; assignedModId?: string; notes?: string }) =>
      client.patch<ReportViewWire>(`/moderation/reports/${encodeURIComponent(id)}`, body),

    /** Resolve with a typed resolution; `createRestriction` bans the resolved
     *  target's owning user (reports.rs:263). */
    resolveReport: (
      id: string,
      body: { resolution: ReportResolution; notes?: string; createRestriction?: boolean },
    ) => client.post<ReportViewWire>(`/moderation/reports/${encodeURIComponent(id)}/resolve`, body),

    dismissReport: (id: string, reason?: ReportDismissReason) =>
      client.post<ReportViewWire>(`/moderation/reports/${encodeURIComponent(id)}/dismiss`, { reason }),

    // NOTE: V3 has no generic create-report route — reports are filed per
    // entity (`/templates/{id}/report`, `/chats/.../report`, `/clans/{id}/report`).
    // TODO(phase3): route createReport through the entity-specific endpoints.
    createReport: (body: CreateReportRequest) => client.post<Report>("/reports", body),

    // Template approval queue ---------------------------------------------
    /** Pending templates, oldest first (queue.rs; snake_case `per_page`). */
    queue: (params?: { page?: number; perPage?: number }) =>
      client.get<QueuePageWire>("/moderation/queue", {
        page: params?.page,
        per_page: params?.perPage,
      }),

    approveTemplate: (id: string, notes?: string) =>
      client.post(`/moderation/queue/${encodeURIComponent(id)}/approve`, { notes }),

    rejectTemplate: (id: string, notes?: string) =>
      client.post(`/moderation/queue/${encodeURIComponent(id)}/reject`, { notes }),

    // Audit --------------------------------------------------------------
    /** Moderation-scoped audit list (audit_log.rs — page/per_page only; the
     *  admin console uses the richer filterable `/admin/audit` instead). */
    audit: (params?: { page?: number; perPage?: number }) =>
      client.get("/moderation/audit-log", { page: params?.page, per_page: params?.perPage }),
  };
}
