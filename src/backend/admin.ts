import { BackendClient } from "./client";

export function buildAdminApi(client: BackendClient) {
  return {
    listUsers: () => client.get("/admin/users"),

    getUser: (ref: string) => client.get(`/admin/users/${encodeURIComponent(ref)}`),

    updateUser: (ref: string, body: Record<string, unknown>) =>
      client.patch(`/admin/users/${encodeURIComponent(ref)}`, body),

    ban: (ref: string, reason?: string, durationMinutes?: number) =>
      client.post(`/admin/users/${encodeURIComponent(ref)}/ban`, { reason, durationMinutes }),

    unban: (ref: string) => client.delete(`/admin/users/${encodeURIComponent(ref)}/ban`),

    mute: (ref: string, reason?: string, durationMinutes?: number) =>
      client.post(`/admin/users/${encodeURIComponent(ref)}/mute`, { reason, durationMinutes }),

    unmute: (ref: string) => client.delete(`/admin/users/${encodeURIComponent(ref)}/mute`),

    promote: (ref: string, role: string) =>
      client.post(`/admin/users/${encodeURIComponent(ref)}/promote`, { role }),

    wipeout: (ref: string, confirm: string) =>
      client.post(`/admin/users/${encodeURIComponent(ref)}/wipeout`, { confirm }),

    audit: (params?: { page?: number; perPage?: number; action?: string; targetType?: string }) => client.get("/admin/audit", params),

    config: () => client.get("/admin/config"),

    updateConfig: (body: Record<string, unknown>) => client.patch("/admin/config", body),

    maintenance: () => client.get("/admin/maintenance"),

    setMaintenance: (body: { enabled: boolean; reason?: string; estimatedDurationMinutes?: number }) => client.post("/admin/maintenance", body),

    broadcast: (body: { message: string; targetRole?: string; targetUserIds?: string[] }) => client.post("/admin/broadcast", body),
  };
}
