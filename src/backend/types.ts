// Core backend types and interfaces.
//
// This module is backend-agnostic: it does not depend on browser APIs or the
// extension config. It defines the shape of users, backends, errors, and the
// request contract used by BackendClient.

// ---------------------------------------------------------------------------
// User shapes
// ---------------------------------------------------------------------------

/**
 * Public account projection returned by V3 auth endpoints
 * (`/auth/site`, `/auth/session`, `/auth/refresh`, etc.).
 */
export interface AccountPublic {
  id: string;
  username: string;
  displayName?: string;
  role?: string;
}

/**
 * A social account listed in another user's public profile.
 */
export interface SocialAccountPublic {
  provider: string;
  username?: string;
  isVerified?: boolean;
  linkedAt?: string;
}

/**
 * Full "self" profile returned by `/api/v3/users/me`.
 */
export interface UserSelf extends AccountPublic {
  bio?: string;
  /** Preferred UI language (e.g. "en", "ru"). */
  lang?: string;
  /** @deprecated use lang */
  preferredLang?: string;
  telemetryOptIn?: boolean;
  globalRole?: string;
  avatarUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  siteIdentities?: SiteIdentity[];
  linkedAccounts?: ProviderLink[];
  apiKeyCount?: number;
  blockListCount?: number;

  // Legacy V2 aliases kept until all callers are migrated.
  /** @deprecated use discordId */
  discord_id?: string;
  discordId?: string;
  /** @deprecated use discordUsername */
  discord_username?: string;
  discordUsername?: string;
  /** @deprecated use clanRole */
  clan_role?: string;
  clanRole?: string;
  /** @deprecated use hasCustomAvatar */
  has_custom_avatar?: boolean;
  hasCustomAvatar?: boolean;
  socialLinks?: Record<string, string>;
}

/**
 * Public profile of another user returned by `/api/v3/users/{ref}`.
 */
export interface UserProfilePublic extends AccountPublic {
  bio?: string;
  avatarUrl?: string;
  clanId?: string;
  createdAt?: string;
  socialAccounts?: SocialAccountPublic[];
}

/**
 * Generic backend user type used by the extension. In most places it is a
 * `UserSelf`; after lightweight auth endpoints it may be an `AccountPublic`.
 */
export type BackendUser = UserSelf;

// ---------------------------------------------------------------------------
// Identities and providers
// ---------------------------------------------------------------------------

export interface SiteIdentity {
  id: string;
  accountId: string;
  source: string;
  externalId: string;
  siteUsername?: string;
  linkedAt?: string;
  lastSeenAt?: string;
}

export interface ProviderLink {
  id: string;
  accountId: string;
  provider: string;
  providerUid: string;
  username?: string;
  isVerified?: boolean;
  isPublic?: boolean;
  linkedAt?: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface BackendAuthResponse {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  user?: BackendUser;
}

/** @deprecated use BackendAuthResponse */
export interface BackendAuthResult extends BackendAuthResponse {}

export interface SessionInfo {
  user: BackendUser;
  siteIdentities?: SiteIdentity[];
  providers?: ProviderLink[];
}

export interface OAuthStartResponse {
  authorizeUrl: string;
  state: string;
}

export interface OAuthCallbackBody {
  code: string;
  state: string;
}

export interface MergeInitiateResponse {
  mergeToken: string;
  expiresIn?: number;
}

export interface MergeResult extends BackendAuthResponse {
  mergedAccountId: string;
}

export interface RecoveryPhraseResponse {
  phrase: string;
  wordCount?: number;
  createdAt?: string;
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

export type FeedEventType = "snapshot" | "signal" | "announcement" | "milestone";

export interface FeedMedia {
  type: "image" | "video" | "link" | string;
  url: string;
  label?: string;
  size?: string;
}

export interface FeedEvent {
  id: string;
  eventType: FeedEventType | string;
  source: string;
  externalId: string;
  title?: string;
  description?: string;
  payload: Record<string, unknown>;
  media: FeedMedia[];
  occurredAt: string;
  createdAt: string;
  notes?: Record<string, string>;
}

export interface SnapshotSizeInfo {
  bytes?: number;
  width?: number;
  height?: number;
  discordUrl?: string;
  telegramUrl?: string;
}

export interface SnapshotPayload {
  batchId?: string;
  sizes: Record<string, SnapshotSizeInfo>;
}

export interface SignalPayload {
  numId?: number;
  name?: string;
  location?: string;
  imageFile?: string;
  submittedAt?: number;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryEvent {
  name: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface TelemetryLogEntry {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: Record<string, unknown>;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export interface Restriction {
  id: string;
  userId: string;
  kind: "ban" | "mute" | "clan_mute";
  scope: "global" | "clan";
  scopeId?: string;
  reason?: string;
  createdAt: string;
  expiresAt?: string;
  removedAt?: string;
}

export interface Report {
  id: string;
  reporterId?: string;
  targetType: string;
  targetId: string;
  reason: string;
  status: "open" | "resolved" | "dismissed";
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Backend / request
// ---------------------------------------------------------------------------

export interface StoredBackend {
  /** Stable id used to pick this backend from the list. */
  id: string;
  /** Human label (e.g. "The Wall", "WPLACE"). */
  label: string;
  /** Base URL without trailing slash, e.g. https://the-wall.vai-rice.space/api/v3 */
  url: string;
  /** Access token (JWT or API key). */
  token: string;
  /** Refresh token for JWT sessions. */
  refreshToken?: string;
  /** Whether this backend is currently selected. */
  active: boolean;
  /** Optional identity for this backend (set after login/me). */
  me?: BackendUser;
  /** When false the backend is kept but not used. */
  enabled: boolean;
}

export interface BackendState {
  backends: StoredBackend[];
  /** Id of the currently active backend. */
  activeId: string | null;
}

export interface BackendRequestInit {
  method?: string;
  path: string;
  body?: unknown;
  /**
   * Resolve `path` against the API *root* (e.g. `.../api`) instead of the
   * versioned V3 base (`.../api/v3`). Used by the legacy compat layer to reach
   * `/v2/...` and unversioned V1 endpoints (`/chat/relay`, `/clan/...`).
   */
  root?: boolean;
  /** Override the default auth header. */
  noAuth?: boolean;
  /** Custom headers merged into the request. */
  headers?: Record<string, string>;
  /** Abort signal. */
  signal?: AbortSignal;
}

export interface BackendError extends Error {
  status?: number;
  path?: string;
  backendId?: string;
}

export const BACKEND_HEADER = "X-ClientVersion-TheWallDev-API";
export const BACKEND_VERSION = "3";
