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

export function buildModerationApi(client: BackendClient) {
  return {
    // Restrictions -------------------------------------------------------
    listRestrictions: (params?: { userId?: string; kind?: string }) => client.get<Restriction[]>("/restrictions", params),

    createRestriction: (body: CreateRestrictionRequest) => client.post<Restriction>("/restrictions", body),

    getRestriction: (id: string) => client.get<Restriction>(`/restrictions/${encodeURIComponent(id)}`),

    updateRestriction: (id: string, body: Partial<CreateRestrictionRequest>) =>
      client.patch<Restriction>(`/restrictions/${encodeURIComponent(id)}`, body),

    deleteRestriction: (id: string) => client.delete(`/restrictions/${encodeURIComponent(id)}`),

    userRestrictions: (userRef: string) =>
      client.get<Restriction[]>(`/users/${encodeURIComponent(userRef)}/restrictions`),

    // Reports ------------------------------------------------------------
    listReports: (params?: { status?: string; targetType?: string }) =>
      client.get<Report[]>("/moderation/reports", params),

    // NOTE: V3 has no generic create-report route — reports are filed per
    // entity (`/templates/{id}/report`, `/chats/.../report`, `/clans/{id}/report`).
    // TODO(phase3): route createReport through the entity-specific endpoints.
    createReport: (body: CreateReportRequest) => client.post<Report>("/reports", body),

    resolveReport: (id: string, resolution: "resolved" | "dismissed", note?: string) =>
      client.post<Report>(`/moderation/reports/${encodeURIComponent(id)}/resolve`, { resolution, note }),

    // Audit --------------------------------------------------------------
    audit: (params?: { page?: number; perPage?: number; action?: string; targetType?: string }) =>
      client.get("/moderation/audit-log", params),
  };
}
