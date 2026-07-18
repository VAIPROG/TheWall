/**
 * V3 data layer for the Community super-tab (chats + clans). Thin wrappers over
 * the backend client (`client.get/post/patch/delete` → V3 base `client.url`),
 * mirroring `src/ui/templates/api.ts`. DOM-free and import-safe in bare Bun: the
 * only import is the backend facade, and the module top does no DOM/network
 * work. Response/request shapes are serde `rename_all = "camelCase"` on the
 * backend, so all JSON keys are camelCase. Interfaces below only carry the
 * fields the Community screens (Tasks 3–6) actually use (YAGNI).
 */
import { getActiveClient } from "../../backend/index";
import { t } from "../../i18n";

/** Active backend client — but ONLY when it actually carries an auth token.
 *  Every Community endpoint is auth-required, so returning a token-less client
 *  (which `getActiveClient()` does before login — e.g. when the Hub auto-loads
 *  at startup) would fire requests with NO `Authorization` header. Treat "no
 *  token" as "not connected" so every Community request is authenticated. */
function authedClient() {
  const active = getActiveClient();
  return active && active.token ? active : null;
}

// ---------------------------------------------------------------------------
// Chat types
// ---------------------------------------------------------------------------

/** Chat `type` values (backend `chats.type` column): confirmed literals. */
export type ChatKind = "clan" | "dm" | "global" | "modmail";

export interface ChatSummary {
  id: string;
  /** JSON key is `type`; one of {@link ChatKind}. */
  type: ChatKind;
  clanId?: string | null;
  dmKey?: string | null;
  topic?: string | null;
  slowmodeSeconds: number;
  createdAt: string;
  unreadCount: number;
  lastMessageAt?: string | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface Message {
  id: string;
  chatId: string;
  authorId?: string | null;
  authorUsername?: string | null;
  content: string;
  replyToId?: string | null;
  editedAt?: string | null;
  editCount: number;
  deletedAt?: string | null;
  deletedBy?: string | null;
  isSystem: boolean;
  isDeleted: boolean;
  version: number;
  createdAt: string;
  reactions: Reaction[];
}

export interface Participant {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  role?: string | null;
  roleRank?: number | null;
  lastReadMessageId?: string | null;
  isMuted: boolean;
}

export interface ChatViewer {
  role?: string | null;
  canPost: boolean;
  isMuted: boolean;
  lastReadMessageId?: string | null;
}

export interface ChatDetail {
  id: string;
  type: ChatKind;
  clanId?: string | null;
  dmKey?: string | null;
  topic?: string | null;
  slowmodeSeconds: number;
  createdAt: string;
  participantCount: number;
  unreadCount: number;
  lastMessageAt?: string | null;
  viewer: ChatViewer;
  participants: Participant[];
  recentMessages: Message[];
  pinnedMessageIds: string[];
}

// ---------------------------------------------------------------------------
// Clan types
// ---------------------------------------------------------------------------

export type MembershipStatus = "member" | "pending" | "invited" | "none";
export type ClanRole = "member" | "moderator" | "admin" | "owner";

export interface ClanViewer {
  role?: ClanRole | null;
  membershipStatus: MembershipStatus;
  canManageMembers?: boolean;
  canManageSettings?: boolean;
  canModerateChat?: boolean;
  canPostTemplates?: boolean;
}

export interface ClanStats {
  memberCount: number;
  templateCount: number;
  onlineCount?: number | null;
}

/** A clan as it appears in list results and detail. `ClanSummary` and
 *  `ClanDetail` share the same wire shape (`ClanView`); the alias documents
 *  intent at call sites. */
export interface ClanSummary {
  id: string;
  name: string;
  description?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  ownerId?: string | null;
  memberCount: number;
  chatId?: string | null;
  joinPolicy?: string | null;
  tag?: string | null;
  verified?: boolean;
  discoverable?: boolean;
  createdAt?: string;
  updatedAt?: string;
  stats?: ClanStats;
  ownerVerified: boolean;
  ownerVerifiedVia?: string | null;
  ownerVerifiedAt?: string | null;
  viewer?: ClanViewer;
}

export type ClanDetail = ClanSummary;

export interface ClanMember {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
  role: ClanRole;
  joinedAt: string;
  roleRank: number;
  permissions: string[];
  nickname?: string | null;
  title?: string | null;
  lastActiveAt?: string | null;
}

export interface ClanInvite {
  id: string;
  code: string;
  createdBy?: string | null;
  targetUserId?: string | null;
  maxUses?: number | null;
  useCount: number;
  expiresAt?: string | null;
  createdAt: string;
}

export interface ClanApplication {
  id: string;
  clanId: string;
  applicant: { userId: string; username: string; displayName: string; avatarUrl?: string | null };
  message?: string | null;
  status: string;
  createdAt: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
}

export interface ClanSettings {
  joinPolicy: string;
  templateScopeDefault?: string;
  moderationPreferences?: Record<string, unknown>;
  chatPermissions?: {
    whoCanPost?: string;
    slowmodeSeconds?: number;
    whoCanInvite?: string;
    whoCanPostTemplates?: string;
  };
  discoverable?: boolean;
  defaultMemberRole?: string;
  memberCap?: number | null;
}

/** Paginated envelope shared by clans list and clan-members list. */
export interface Page<T> {
  items: T[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

// Create-clan chooser (v6.2.8) wire shapes.
export interface OwnedGuild {
  id: string;
}
export interface SiteSuggestion {
  source: string;
  externalId: string;
  name: string;
  displayName?: string | null;
  discordId?: string | null;
  icon?: string | null;
}

// ---------------------------------------------------------------------------
// PURE core (unit-tested — no client, no DOM, no network)
// ---------------------------------------------------------------------------

export type ChatRef =
  | { kind: "clan"; chatId: string }
  | { kind: "dm"; userRef: string }
  | { kind: "modmail" }
  | { kind: "global" };

/** Resolve a ChatRef to its V3 message endpoints (pure — unit-tested).
 *  Clan and global chats have a distinct `/read` endpoint; DM/modmail read-state
 *  is handled server-side on fetch, so `read` is undefined for those. */
export function chatEndpoints(ref: ChatRef): { list: string; send: string; read?: string } {
  if (ref.kind === "clan")
    return {
      list: `/chats/${encodeURIComponent(ref.chatId)}/messages`,
      send: `/chats/${encodeURIComponent(ref.chatId)}/messages`,
      read: `/chats/${encodeURIComponent(ref.chatId)}/read`,
    };
  if (ref.kind === "dm")
    return {
      list: `/dm/${encodeURIComponent(ref.userRef)}`,
      send: `/dm/${encodeURIComponent(ref.userRef)}`,
    };
  // The site-wide global chat is a first-class kind with its own /read — it is
  // NOT modmail (conflating them opened the modmail endpoint for a global row).
  if (ref.kind === "global")
    return {
      list: `/chats/global/messages`,
      send: `/chats/global/messages`,
      read: `/chats/global/read`,
    };
  // modmail (fallback): fixed path, read-state server-managed on fetch.
  return { list: `/chats/global/modmail`, send: `/chats/global/modmail` };
}

/** The peer's user id in a DM `dmKey` ("uuidA:uuidB", canonical) — the one that
 *  isn't `meId`. Returns null for a malformed/absent key. Pure (unit-tested). */
export function peerOf(dmKey: string | undefined, meId: string | undefined): string | null {
  if (!dmKey || !meId) return null;
  const parts = dmKey.split(":");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (a === meId) return b;
  if (b === meId) return a;
  return null;
}

/** Derive a human display title from a chat summary (pure — unit-tested).
 *  - clan  → topic || "Clan chat"
 *  - dm    → the peer handle. `dmKey` is an opaque, canonically-ordered pair of
 *            user ids (not usernames), so it can't yield a friendly name here;
 *            we fall back to `topic` when present, else "Direct message". The
 *            real peer name comes from ChatDetail.participants at render time.
 *  - global→ "Global"
 *  - modmail → "Modmail" */
export function chatTitle(c: ChatSummary): string {
  switch (c.type) {
    case "clan":
      return c.topic?.trim() || "Clan chat";
    case "dm":
      return c.topic?.trim() || "Direct message";
    case "modmail":
      return "🛡 " + (t("commModmail") || "Modmail");
    case "global":
      return c.topic?.trim() || "🌐 " + (t("commGlobalChat") || "Global");
    default:
      return c.topic?.trim() || "Chat";
  }
}

// ---------------------------------------------------------------------------
// Chat wrappers
// ---------------------------------------------------------------------------

export interface ListMessagesOpts {
  before?: string;
  after?: string;
  limit?: number;
}

export async function listChats(clanId?: string): Promise<ChatSummary[]> {
  const c = authedClient();
  if (!c) return [];
  return c.get<ChatSummary[]>("/chats", clanId ? { clanId } : undefined);
}

export async function getChat(id: string): Promise<ChatDetail | null> {
  const c = authedClient();
  if (!c) return null;
  return c.get<ChatDetail>(`/chats/${encodeURIComponent(id)}`);
}

/** List messages for a chat (reverse-chronological). For clan chats the list
 *  path takes before/after/limit cursors; DM/modmail return a ChatDetailView,
 *  from which we surface `recentMessages`. */
export async function listMessages(ref: ChatRef, opts: ListMessagesOpts = {}): Promise<Message[]> {
  const c = authedClient();
  if (!c) return [];
  const { list } = chatEndpoints(ref);
  if (ref.kind === "clan") {
    return c.get<Message[]>(list, {
      before: opts.before,
      after: opts.after,
      limit: opts.limit,
    });
  }
  const detail = await c.get<ChatDetail>(list);
  return detail?.recentMessages ?? [];
}

export async function sendMessage(ref: ChatRef, content: string, replyToId?: string): Promise<Message> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<Message>(chatEndpoints(ref).send, { content, replyToId });
}

/** Mark a chat read. Only clan chats expose a `/read` endpoint; DM/modmail
 *  no-op (read-state is server-managed on fetch). */
export async function markRead(ref: ChatRef, messageId?: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  const { read } = chatEndpoints(ref);
  if (!read) return;
  await c.post(read, { messageId });
}

export async function editMessage(
  cid: string,
  mid: string,
  content: string,
  expectedVersion?: number,
): Promise<Message> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.patch<Message>(
    `/chats/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}`,
    { content, expectedVersion },
  );
}

export async function deleteMessage(cid: string, mid: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.delete(`/chats/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}`);
}

/** Add (`on=true`) or remove a reaction. Emoji is URL-encoded into the path. */
export async function react(cid: string, mid: string, emoji: string, on: boolean): Promise<void> {
  const c = authedClient();
  if (!c) return;
  const path = `/chats/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/reactions/${encodeURIComponent(emoji)}`;
  if (on) await c.put(path);
  else await c.delete(path);
}

export async function reportMessage(cid: string, mid: string, reason: string, evidence?: string): Promise<void> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  await c.post(
    `/chats/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/report`,
    { reason, evidence },
  );
}

export async function pinMessage(cid: string, mid: string, on: boolean): Promise<void> {
  const c = authedClient();
  if (!c) return;
  const path = `/chats/${encodeURIComponent(cid)}/messages/${encodeURIComponent(mid)}/pin`;
  if (on) await c.post(path);
  else await c.delete(path);
}

// ---------------------------------------------------------------------------
// Clan wrappers
// ---------------------------------------------------------------------------

export interface ClanListQuery {
  page?: number;
  perPage?: number;
  search?: string;
  sortBy?: string;
  order?: string;
}

export async function listClans(query: ClanListQuery = {}): Promise<Page<ClanSummary>> {
  const c = authedClient();
  if (!c) return { items: [], page: 1, perPage: 0, total: 0, totalPages: 0 };
  return c.get<Page<ClanSummary>>("/clans", { ...query });
}

export async function getClan(id: string): Promise<ClanDetail | null> {
  const c = authedClient();
  if (!c) return null;
  return c.get<ClanDetail>(`/clans/${encodeURIComponent(id)}`);
}

export async function createClan(name: string, description?: string): Promise<ClanDetail> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<ClanDetail>("/clans/new", { name, description });
}

export async function updateClan(id: string, patch: Record<string, unknown>): Promise<ClanDetail> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.patch<ClanDetail>(`/clans/${encodeURIComponent(id)}`, patch);
}

export async function listMembers(id: string, page?: number, perPage?: number): Promise<Page<ClanMember>> {
  const c = authedClient();
  if (!c) return { items: [], page: 1, perPage: 0, total: 0, totalPages: 0 };
  return c.get<Page<ClanMember>>(`/clans/${encodeURIComponent(id)}/members`, { page, perPage });
}

export async function setMemberRole(
  cid: string,
  uid: string,
  role: "member" | "moderator" | "admin",
): Promise<ClanMember> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.patch<ClanMember>(
    `/clans/${encodeURIComponent(cid)}/members/${encodeURIComponent(uid)}`,
    { role },
  );
}

export async function kickMember(cid: string, uid: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.delete(`/clans/${encodeURIComponent(cid)}/members/${encodeURIComponent(uid)}`);
}

export async function leaveClan(id: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.post(`/clans/${encodeURIComponent(id)}/leave`);
}

export async function disbandClan(id: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.post(`/clans/${encodeURIComponent(id)}/disband`, { confirm: true });
}

export async function listInvites(id: string): Promise<ClanInvite[]> {
  const c = authedClient();
  if (!c) return [];
  return c.get<ClanInvite[]>(`/clans/${encodeURIComponent(id)}/invites`);
}

export interface CreateInviteBody {
  targetUserId?: string;
  maxUses?: number;
  expiresInHours?: number;
}

export async function createInvite(id: string, body: CreateInviteBody = {}): Promise<ClanInvite> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<ClanInvite>(`/clans/${encodeURIComponent(id)}/invites`, body);
}

export async function revokeInvite(cid: string, iid: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.delete(`/clans/${encodeURIComponent(cid)}/invites/${encodeURIComponent(iid)}`);
}

export async function joinClan(id: string, inviteCode?: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.post(`/clans/${encodeURIComponent(id)}/join`, { inviteCode });
}

export async function applyForRole(cid: string, role: string, message?: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.post(`/clans/${encodeURIComponent(cid)}/apply/${encodeURIComponent(role)}`, { message });
}

export async function listApplications(id: string): Promise<ClanApplication[]> {
  const c = authedClient();
  if (!c) return [];
  return c.get<ClanApplication[]>(`/clans/${encodeURIComponent(id)}/applications`);
}

export async function reviewApplication(
  cid: string,
  aid: string,
  decision: "approve" | "reject",
  reason?: string,
): Promise<ClanApplication> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<ClanApplication>(
    `/clans/${encodeURIComponent(cid)}/applications/${encodeURIComponent(aid)}/review`,
    { decision, reason },
  );
}

export async function getSettings(id: string): Promise<ClanSettings | null> {
  const c = authedClient();
  if (!c) return null;
  return c.get<ClanSettings>(`/clans/${encodeURIComponent(id)}/settings`);
}

export async function updateSettings(id: string, patch: Record<string, unknown>): Promise<ClanSettings> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.patch<ClanSettings>(`/clans/${encodeURIComponent(id)}/settings`, patch);
}

// ---------------------------------------------------------------------------
// Create-clan chooser (v6.2.8)
// ---------------------------------------------------------------------------

export async function ownedGuilds(): Promise<OwnedGuild[]> {
  const c = authedClient();
  if (!c) return [];
  return c.get<OwnedGuild[]>("/clans/discord/owned-guilds");
}

/** The caller's stored site-clan suggestion, or null when the backend returns
 *  204 (the client normalises an empty body to null). */
export async function siteSuggestion(): Promise<SiteSuggestion | null> {
  const c = authedClient();
  if (!c) return null;
  return (await c.get<SiteSuggestion | null>("/clans/site-suggestion")) ?? null;
}

export interface FromGuildBody {
  guildId: string;
  name?: string;
  tag?: string;
}

export async function createFromGuild(body: FromGuildBody): Promise<{ id: string }> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<{ id: string }>("/clans/from-guild", body);
}

/** POST /clans/from-site — takes NO body; the server uses the caller's stored
 *  suggestion row (confirmed in backend/src/routes/v3/clans/discord.rs). */
export async function createFromSite(): Promise<{ id: string }> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<{ id: string }>("/clans/from-site");
}

/** Manual create is just the plain `POST /clans/new` path. */
export const createManual = createClan;

/** POST /clans/{id}/verify-ownership — takes NO body; the server verifies the
 *  clan's bound guild against the caller's owned-guild cache (confirmed in
 *  discord.rs). */
export async function verifyOwnership(id: string): Promise<{ id: string }> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<{ id: string }>(`/clans/${encodeURIComponent(id)}/verify-ownership`);
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** The caller's own clan, or null. `UserSelf` (GET /users/me) does NOT carry a
 *  clan id/membership, so we scan the clans list (perPage=100) and return the
 *  first whose viewer is a confirmed member. */
export async function myClan(): Promise<ClanSummary | null> {
  const c = authedClient();
  if (!c) return null;
  const page = await c.get<Page<ClanSummary>>("/clans", { perPage: 100 });
  return page?.items?.find((cl) => cl.viewer?.membershipStatus === "member") ?? null;
}

/** Resolve a user's username from a user id/ref (best-effort — for DM row/peer
 *  titles). Returns null when not connected, empty ref, or on any error so the
 *  caller can fall back to the raw ref. */
export async function getUsername(ref: string): Promise<string | null> {
  const c = authedClient();
  if (!c || !ref) return null;
  try {
    const u = await c.get<{ username?: string }>(`/users/${encodeURIComponent(ref)}`);
    return u?.username ?? null;
  } catch {
    return null;
  }
}

/** Avatar URL for a user id. Mirrors the `src/helpers.ts` convention
 *  (`${base}/avatar?userId=`) where `base` is the client's **root** URL (the
 *  avatar route lives under `/api`, not `/api/v3`). No `?session=` — the route
 *  is public (profile-modal / settings-tab both use it without a session). */
export function avatarUrl(userId: string): string {
  // Public avatar URL for an <img> (no request fired here → no auth needed);
  // use the raw active client, not authedClient(), so avatars still resolve.
  const c = getActiveClient();
  if (!c) return "";
  return `${c.rootUrl}/avatar?userId=${encodeURIComponent(userId)}`;
}
