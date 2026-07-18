// Re-exports for the new backend module.
//
// This is the single entry point for all backend access. Import the typed
// facade via `api(getActiveClient())`, or the client/state helpers directly.
// The legacy `src/backend.ts` singleton has been removed — everything now
// flows through the versioned BackendClient (see multi.ts / client.ts).

export * from "./types";
export * from "./client";
export * from "./multi";
export * from "./auth";
export * from "./templates";
export * from "./chats";
export * from "./notifications";
export * from "./users";
export * from "./clans";
export * from "./admin";
export * from "./regions";
export { buildAchievementsApi, type CreateAchievementRequest, type AdminGrantRequest, type AchievementEventRequest } from "./achievements";
export * from "./feed";
export * from "./telemetry";
export * from "./moderation";
export * from "./mailbox";
export * from "./link-status";
export * from "./conn-status";
export * from "./legacy";
export * from "./logger";
export { getMe, setMe } from "./multi";

import { BackendClient } from "./client";
import { buildAchievementsApi } from "./achievements";
import { buildAdminApi } from "./admin";
import { buildAuthApi } from "./auth";
import { buildChatsApi } from "./chats";
import { buildClansApi } from "./clans";
import { buildFeedApi } from "./feed";
import { buildLegacyApi } from "./legacy";
import { buildMailboxApi } from "./mailbox";
import { buildModerationApi } from "./moderation";
import { buildNotificationsApi } from "./notifications";
import { buildRegionsApi } from "./regions";
import { buildTelemetryApi } from "./telemetry";
import { buildTemplatesApi } from "./templates";
import { buildUsersApi } from "./users";

/**
 * Assemble the full typed API for a BackendClient.
 *
 * Usage:
 *   import { getActiveClient, api } from "./backend";
 *   const client = getActiveClient();
 *   if (client) {
 *     const a = api(client);
 *     const me = await a.users.me();
 *   }
 */
export function api(client: BackendClient) {
  return {
    client,
    auth: buildAuthApi(client),
    users: buildUsersApi(client),
    clans: buildClansApi(client),
    chats: buildChatsApi(client),
    notifications: buildNotificationsApi(client),
    templates: buildTemplatesApi(client),
    feed: buildFeedApi(client),
    achievements: buildAchievementsApi(client),
    telemetry: buildTelemetryApi(client),
    moderation: buildModerationApi(client),
    mailbox: buildMailboxApi(client),
    legacy: buildLegacyApi(client),
    admin: buildAdminApi(client),
    regions: buildRegionsApi(client),
  };
}

export type BackendApi = ReturnType<typeof api>;
