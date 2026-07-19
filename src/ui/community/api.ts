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

/** Global-moderation lock state on a clan (`ClanView.moderation`; only present
 *  while at least one field is locked — backend omits it otherwise). */
export interface ClanModeration {
  lockedFields: string[];
  lockedBy?: string | null;
  lockedAt?: string | null;
  reason?: string | null;
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
  moderation?: ClanModeration | null;
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

/** How a thread is addressed. `clan` is really "by concrete chat id" — the
 *  generic `/chats/{id}/...` routes work for ANY chat the caller can access,
 *  which is also how a global moderator opens (and replies into) another
 *  user's modmail thread from the triage flow. */
export type ChatRef =
  | { kind: "clan"; chatId: string }
  | { kind: "dm"; userRef: string }
  | { kind: "modmail" }
  | { kind: "global" };

/** Resolve a ChatRef to its V3 message endpoints (pure — unit-tested).
 *  Only clan refs expose a `read` path: the backend read route (`read.rs`) is
 *  `Path<Uuid>` — it does NOT accept the literal `global` selector (400), and
 *  DM/modmail have no id on the ref at all. Read-state for every kind is
 *  handled by {@link markRead} with the CONCRETE chat id (taken from a loaded
 *  message / detail), which the read route accepts for any accessible chat. */
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
  // The site-wide global chat is a first-class kind — it is NOT modmail
  // (conflating them opened the modmail endpoint for a global row). The list
  // and send routes take the `global` selector; `/chats/global/read` would 400
  // (Uuid-only route), so no `read` here — markRead uses the resolved id.
  if (ref.kind === "global")
    return {
      list: `/chats/global/messages`,
      send: `/chats/global/messages`,
    };
  // modmail (fallback): fixed path, thread get-or-created server-side on fetch.
  return { list: `/chats/global/modmail`, send: `/chats/global/modmail` };
}

/** Sort messages oldest→newest (pure — unit-tested). The `/messages` list
 *  endpoints return newest-first (created_at DESC) while ChatDetail
 *  `recentMessages` is already chronological; normalising here lets the thread
 *  render + append in one order regardless of which endpoint fed it. Ties fall
 *  back to id so the order is deterministic. Returns a new array. */
export function chronological(list: Message[]): Message[] {
  return [...list].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
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
 *  PLAIN TEXT ONLY: this string doubles as the thread's back-header title,
 *  which panel-stack runs through esc() — markup would show as raw text. The
 *  per-type glyph is an SVG on the Hub ROW (hub.ts), never part of the title.
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
      return t("commModmail") || "Modmail";
    case "global":
      return c.topic?.trim() || t("commGlobalChat") || "Global";
    default:
      return c.topic?.trim() || "Chat";
  }
}

/** Fixed Hub ordering rank per chat type: Modmail → Global → Clan → DMs. */
const CHAT_TYPE_RANK: Record<ChatKind, number> = { modmail: 0, global: 1, clan: 2, dm: 3 };

/** Order chats for the Hub list by TYPE priority (modmail → global → clan →
 *  dm), keeping the backend's last-message-desc order WITHIN each type —
 *  Array.prototype.sort is stable, so a rank-only comparator preserves the
 *  incoming relative order. Unknown types sink to the bottom. Pure
 *  (unit-tested); returns a new array. */
export function chatOrder(list: ChatSummary[]): ChatSummary[] {
  return [...list].sort(
    (a, b) => (CHAT_TYPE_RANK[a.type] ?? 9) - (CHAT_TYPE_RANK[b.type] ?? 9),
  );
}

/** Compact change-fingerprint of a rendered message list (pure — unit-tested).
 *  Covers everything `renderMessage` paints: id, version (bumps on edit),
 *  edited/deleted flags and the reaction chips. The thread screen compares
 *  fingerprints across its 5s poll and SKIPS the innerHTML re-render when
 *  nothing changed — re-painting recreates every animated-emote `<img>` (decode
 *  + layout thrash every poll), which is what made emotes lag. */
export function messagesFingerprint(list: Message[]): string {
  return list
    .map(
      (m) =>
        `${m.id}:${m.version}:${m.editedAt ?? ""}:${m.isDeleted ? 1 : 0}:` +
        m.reactions.map((r) => `${r.emoji}=${r.count}${r.reactedByMe ? "*" : ""}`).join(","),
    )
    .join("|");
}

/** Normalised global-role string from a `me` payload (pure — unit-tested).
 *  The field name drifted across backend versions (`globalRole` on V3,
 *  `global_role` on rich /v2/auth/me, bare `role` on legacy bootstraps), so
 *  every screen used to re-implement this defensive read — now shared. */
export function roleFromMe(
  me: { globalRole?: string; global_role?: string; role?: string } | null | undefined,
): string {
  return String(me?.globalRole || me?.global_role || me?.role || "").toLowerCase();
}

/** Whether the signed-in user is a global moderator+ (UX gating only — the
 *  backend enforces the real permission on every route). */
export function isGlobalModerator(): boolean {
  const r = roleFromMe(getActiveClient()?.me as Parameters<typeof roleFromMe>[0]);
  return r === "moderator" || r === "admin" || r === "owner";
}

/** Whether the signed-in user is a global admin+ (UX gating only). */
export function isGlobalAdmin(): boolean {
  const r = roleFromMe(getActiveClient()?.me as Parameters<typeof roleFromMe>[0]);
  return r === "admin" || r === "owner";
}

// ---------------------------------------------------------------------------
// Clan global-moderation (takedown / unlock) — moderator+ only
// ---------------------------------------------------------------------------

/** The presentation fields a global moderator can strip/lock (mirrors the
 *  backend `LOCKABLE_FIELDS` in moderation/clans.rs). */
export const TAKEDOWN_FIELDS = ["avatar", "banner", "description", "tag", "discoverable"] as const;
export type TakedownField = (typeof TAKEDOWN_FIELDS)[number];
export type TakedownAction = "strip" | "strip_and_lock";

export interface ClanTakedownBody {
  fields: string[];
  action: TakedownAction;
  reason: string;
}

/** Validate + build a takedown request body (pure — unit-tested). Mirrors the
 *  backend checks (non-empty known fields, reason 1–1000 chars, action enum) so
 *  a bad form fails locally with a clear signal instead of a 400. Returns null
 *  when invalid. */
export function takedownBody(
  fields: string[],
  action: string,
  reason: string,
): ClanTakedownBody | null {
  const clean = fields.filter((f): f is TakedownField =>
    (TAKEDOWN_FIELDS as readonly string[]).includes(f),
  );
  const r = reason.trim();
  if (!clean.length || clean.length !== fields.length) return null;
  if (!r || r.length > 1000) return null;
  if (action !== "strip" && action !== "strip_and_lock") return null;
  return { fields: clean, action, reason: r };
}

/** POST /moderation/clans/{id}/takedown — strip (and optionally lock)
 *  presentation fields. Global moderator+ only; returns the updated ClanView. */
export async function takedownClan(id: string, body: ClanTakedownBody): Promise<ClanDetail> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<ClanDetail>(`/moderation/clans/${encodeURIComponent(id)}/takedown`, body);
}

/** POST /moderation/clans/{id}/unlock — release moderation locks on the given
 *  fields (backend requires a non-empty `fields` list; pass the currently
 *  locked ones from `ClanDetail.moderation.lockedFields`). */
export async function unlockClan(id: string, fields: string[], reason?: string): Promise<ClanDetail> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<ClanDetail>(`/moderation/clans/${encodeURIComponent(id)}/unlock`, { fields, reason });
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

/** List messages for a chat, normalised to CHRONOLOGICAL order (oldest→newest).
 *  Clan AND global refs hit `/chats/{id|global}/messages`, which returns a
 *  `Message[]` array (newest-first) and takes before/after/limit cursors.
 *  DM/modmail return a ChatDetailView OBJECT, from which we surface
 *  `recentMessages`. (Global previously fell into the detail path — the array
 *  has no `.recentMessages`, so the global chat always looked empty and a
 *  just-sent message "vanished" on reload.) */
export async function listMessages(ref: ChatRef, opts: ListMessagesOpts = {}): Promise<Message[]> {
  const c = authedClient();
  if (!c) return [];
  const { list } = chatEndpoints(ref);
  if (ref.kind === "clan" || ref.kind === "global") {
    const page = await c.get<Message[]>(list, {
      before: opts.before,
      after: opts.after,
      limit: opts.limit,
    });
    return chronological(page ?? []);
  }
  const detail = await c.get<ChatDetail>(list);
  return chronological(detail?.recentMessages ?? []);
}

export async function sendMessage(ref: ChatRef, content: string, replyToId?: string): Promise<Message> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  return c.post<Message>(chatEndpoints(ref).send, { content, replyToId });
}

/** Mark a chat read by its CONCRETE chat id (`POST /chats/{uuid}/read` — the
 *  backend route is Uuid-only, so the caller must resolve the real id first;
 *  for non-clan refs it comes off a loaded message's `chatId`). Best-effort:
 *  read-state is never worth surfacing an error (or leaking an unhandled
 *  rejection from a fire-and-forget call site), so failures are swallowed. */
export async function markRead(chatId: string, messageId?: string): Promise<void> {
  const c = authedClient();
  if (!c || !chatId) return;
  try {
    await c.post(`/chats/${encodeURIComponent(chatId)}/read`, { messageId });
  } catch {
    /* best-effort */
  }
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

/** The caller's clan via GET /clans/mine (active memberships ∪ owned; usually
 *  0–1). Prefer an owned clan, else the first. null when none / not connected. */
export async function myClan(): Promise<ClanSummary | null> {
  const c = authedClient();
  if (!c) return null;
  const mine = await c.get<ClanSummary[]>("/clans/mine");
  if (!mine?.length) return null; // client.get can yield null on 204/empty body
  const me = c.me?.id;
  return mine.find((cl) => cl.ownerId && cl.ownerId === me) ?? mine[0];
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

/** Resolve a user id from a ref (username / `@name` / uuid) via
 *  `GET /users/{ref}` (`resolve_user_ref` on the backend). Best-effort: null
 *  when not connected, unknown user, or any error — callers use it to
 *  pre-validate DM targets and to open modmail triage. */
export async function getUserId(ref: string): Promise<string | null> {
  const c = authedClient();
  if (!c || !ref) return null;
  try {
    const u = await c.get<{ id?: string }>(`/users/${encodeURIComponent(ref)}`);
    return u?.id ?? null;
  } catch {
    return null;
  }
}

/** Fetch a modmail thread detail. With no argument this is the caller's own
 *  thread (get-or-created server-side). Global moderators may pass a target
 *  user id to read that user's thread — the backend query param is snake_case
 *  `user_id` (ModmailQuery has no camelCase rename; confirmed in modmail.rs).
 *  NOTE for repliers: `POST /chats/global/modmail` always posts into the
 *  CALLER's own thread, so a moderator must reply via the generic
 *  `/chats/{detail.id}/messages` route instead (the thread screen does this
 *  when opened by concrete chat id). */
export async function getModmailThread(userId?: string): Promise<ChatDetail | null> {
  const c = authedClient();
  if (!c) return null;
  return c.get<ChatDetail>("/chats/global/modmail", userId ? { user_id: userId } : undefined);
}

/** Public avatar URL for a user id/ref, served by the v6.4.0 endpoint that never
 *  404s (custom → linked Discord → seeded identicon). Safe as a bare `<img>` src
 *  — no auth needed, no onerror fallback required. */
export function avatarUrl(ref: string): string {
  // Public avatar URL for an <img> (no request fired here → no auth needed);
  // use the raw active client, not authedClient(), so avatars still resolve.
  const c = getActiveClient();
  if (!c) return "";
  return `${c.url}/users/${encodeURIComponent(ref)}/avatar`;
}

/** Public clan-avatar image URL (v6.4.0 serve, never 404s → identicon fallback). */
export function clanAvatarUrl(id: string): string {
  const c = getActiveClient();
  return c ? `${c.url}/clans/${encodeURIComponent(id)}/avatar` : "";
}

/** Public clan-banner image URL (v6.4.0 serve, never 404s → gradient fallback). */
export function clanBannerUrl(id: string): string {
  const c = getActiveClient();
  return c ? `${c.url}/clans/${encodeURIComponent(id)}/banner` : "";
}

/** Upload a clan avatar (clan-admin only). `dataUrl` is a `data:` URL image. */
export async function uploadClanAvatar(id: string, dataUrl: string): Promise<void> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  await c.post(`/clans/${encodeURIComponent(id)}/avatar`, { image: dataUrl });
}

/** Reset a clan avatar to the identicon fallback (clan-admin only). */
export async function deleteClanAvatar(id: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.delete(`/clans/${encodeURIComponent(id)}/avatar`);
}

/** Upload a clan banner (clan-admin only). `dataUrl` is a `data:` URL image. */
export async function uploadClanBanner(id: string, dataUrl: string): Promise<void> {
  const c = authedClient();
  if (!c) throw new Error("not connected");
  await c.post(`/clans/${encodeURIComponent(id)}/banner`, { image: dataUrl });
}

/** Reset a clan banner to the gradient fallback (clan-admin only). */
export async function deleteClanBanner(id: string): Promise<void> {
  const c = authedClient();
  if (!c) return;
  await c.delete(`/clans/${encodeURIComponent(id)}/banner`);
}
