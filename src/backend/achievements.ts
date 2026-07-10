import { BackendClient } from "./client";

export type AchievementRarity = "common" | "uncommon" | "rare" | "legendary" | "unique";

export interface AchievementCatalog {
  id: string;
  category: string;
  title: string;
  description: string;
  iconUrl?: string;
  rarity: AchievementRarity;
  unlockCriteria: UnlockCriteria;
  points: number;
  secret: boolean;
}

export type UnlockCriteria =
  | { kind: "manual" }
  | { kind: "event"; event: string }
  | { kind: "condition"; condition: string }
  | { kind: "achievementCount"; count: number };

export type GrantSource =
  | { kind: "system" }
  | { kind: "admin"; by: string; reason?: string }
  | { kind: "event"; name: string }
  | { kind: "selfUnlocked" };

export interface AchievementGrant {
  achievement: AchievementCatalog;
  grantedAt: string;
  grantedBy: GrantSource;
  metadata?: unknown;
}

export interface AchievementEventResponse {
  new: boolean;
  achievement?: AchievementCatalog;
}

export interface AchievementRecheckResponse {
  newlyUnlocked: string[];
}

export interface AchievementEventRequest {
  event: string;
  metadata?: Record<string, unknown>;
}

export interface AdminGrantRequest {
  userId: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAchievementRequest {
  id: string;
  category: string;
  title: string;
  description: string;
  iconUrl?: string;
  rarity?: AchievementRarity;
  unlockCriteria?: UnlockCriteria;
  points?: number;
  secret?: boolean;
}

export function buildAchievementsApi(client: BackendClient) {
  const path = (id: string) => `/achievements/${encodeURIComponent(id)}`;

  return {
    /** List own achievements (catalog + grants). */
    listMine: () =>
      client.get<AchievementGrant[]>("/users/me/achievements"),

    /** Re-evaluate condition-based achievements. */
    recheck: () =>
      client.post<AchievementRecheckResponse>("/users/me/achievements/recheck"),

    /** Fire a client-side achievement event. */
    event: (body: AchievementEventRequest) =>
      client.post<AchievementEventResponse>("/users/me/achievements/event", body),

    /** List public achievements for a user. */
    listFor: (userRef: string) =>
      client.get<AchievementGrant[]>(`/users/${encodeURIComponent(userRef)}/achievements`),

    // Admin -------------------------------------------------------------
    adminCatalog: (includeSecret?: boolean) =>
      client.get<AchievementCatalog[]>("/admin/achievements/catalog", { includeSecret }),

    adminGrants: (params?: { userId?: string; page?: number; perPage?: number }) => client.get("/admin/achievements/grants", params),

    adminCreate: (body: CreateAchievementRequest) =>
      client.post<AchievementCatalog>("/admin/achievements/catalog", body),

    adminUpdate: (achievementId: string, body: Partial<CreateAchievementRequest>) =>
      client.patch<AchievementCatalog>(path(achievementId), body),

    adminDelete: (achievementId: string) =>
      client.delete(path(achievementId)),

    adminGrant: (achievementId: string, body: AdminGrantRequest) =>
      client.post(path(achievementId) + "/grant", body),

    adminRevoke: (achievementId: string, userId: string, reason?: string) =>
      client.delete(`${path(achievementId)}/revoke/${encodeURIComponent(userId)}`, { reason }),
  };
}
