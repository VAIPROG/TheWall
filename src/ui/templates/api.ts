/**
 * V3 template data layer for the Templates super-tab. Thin wrappers over the
 * backend client (`client.get/post/patch/delete` → V3 base `client.url`). No
 * legacy calls. Previews/animated use the V3 render endpoints; because an
 * `<img>`/`<gif>` tag can't send an Authorization header, the access token is
 * passed as `?session=<jwt>` (the backend accepts a JWT there as of v6.2.3),
 * so previews resolve for clan/private/pending templates the caller can see.
 */
import { getActiveClient } from "../../backend/index";

export type Chip = "all" | "public" | "clan" | "mine";

export interface TplSummary {
  id: string;
  name: string;
  userId: string;
  scope: string;
  status: string;
  version?: number;
  clanId?: string | null;
  templateCount?: number;
  /** True when any layer carries a sprite-sheet animation (renders as a GIF). */
  animated?: boolean;
  hasDocument?: boolean;
  verifiedAt?: string | null;
  createdAt?: string;
  x?: number;
  y?: number;
}

/** Pure chip → list query mapping (unit-tested). `mine` is resolved to the
 *  caller's author id inside {@link listTemplates}. When `showUnverified` is
 *  false (default) Public/Clan/All are filtered to approved templates only;
 *  `mine` always returns every status (it's the caller's own work). */
export function listParams(chip: Chip, showUnverified = false): Record<string, unknown> {
  const approved = showUnverified ? {} : { status: "approved" };
  if (chip === "public") return { scope: "public", ...approved, limit: 200 };
  if (chip === "clan") return { scope: "clan", ...approved, limit: 200 };
  if (chip === "mine") return { mine: true, limit: 200 };
  return { ...approved, limit: 200 };
}

export async function listTemplates(chip: Chip, showUnverified = false): Promise<TplSummary[]> {
  const c = getActiveClient();
  if (!c) return [];
  const p: Record<string, unknown> = { ...listParams(chip, showUnverified) };
  if (p.mine) {
    delete p.mine;
    if (c.me) p.author = c.me.id; // owner sees all of their own (any scope/status)
  }
  return c.get<TplSummary[]>("/templates", p);
}

/** `?session=<jwt>` suffix so `<img>` requests authenticate (empty when anon). */
function authSuffix(): string {
  const c = getActiveClient();
  return c?.token ? `&session=${encodeURIComponent(c.token)}` : "";
}

/** V3 still preview (webp). Authenticated via `?session=` for private templates. */
export function previewUrl(id: string, size = 128, layer = 0): string {
  const c = getActiveClient();
  if (!c) return "";
  return `${c.url}/templates/${encodeURIComponent(id)}/preview?size=${size}&layer=${layer}${authSuffix()}`;
}

/** V3 animated GIF preview. */
export function animatedUrl(id: string, layer = 0): string {
  const c = getActiveClient();
  if (!c) return "";
  return `${c.url}/templates/${encodeURIComponent(id)}/animated?layer=${layer}${authSuffix()}`;
}

// ---------------------------------------------------------------------------
// Publish / Share
// ---------------------------------------------------------------------------

export type Scope = "private" | "clan" | "public";
export type AuthorVisibility = "full" | "anon" | "hidden";

/** Parse a free-form id/domain list (comma / whitespace / newline separated)
 *  into a deduped, trimmed array. Pure — unit-tested. */
export function parseIdList(raw: string): string[] {
  const seen = new Set<string>();
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

/** Access-control block. All fields optional; empty ones are omitted from the
 *  document so the ACL treats them as "unset". Enforced by the backend. */
export interface AccessConfig {
  usersWhitelist?: string[];
  usersBlocklist?: string[];
  allowedToEdit?: { userIds?: string[]; clanIds?: string[] };
  domainsWhitelist?: string[];
}

export interface PublishInput {
  /** Base the-wall-dev/2 document (from the overlay hand-off or an upload). */
  document: Record<string, unknown>;
  scope: Scope;
  clanId?: string | null;
  password?: string;
  authorVisibility: AuthorVisibility;
  access?: AccessConfig;
  notes?: string[];
}

/** Apply the author-visibility choice to a document, mirroring the backend
 *  PATCH transform: anon → "anon" string, hidden → null, full → structured. */
function applyAuthor(doc: Record<string, unknown>, vis: AuthorVisibility, meId?: string): void {
  if (vis === "anon") doc.author = "anon";
  else if (vis === "hidden") doc.author = null;
  else doc.author = meId ? { id: meId } : doc.author ?? null;
}

/** Merge non-empty access fields into the document root (where the ACL reads them). */
function applyAccess(doc: Record<string, unknown>, a?: AccessConfig): void {
  if (!a) return;
  if (a.usersWhitelist?.length) doc.usersWhitelist = a.usersWhitelist;
  if (a.usersBlocklist?.length) doc.usersBlocklist = a.usersBlocklist;
  const ate = a.allowedToEdit;
  if (ate && (ate.userIds?.length || ate.clanIds?.length)) {
    doc.allowedToEdit = {
      ...(ate.userIds?.length ? { userIds: ate.userIds } : {}),
      ...(ate.clanIds?.length ? { clanIds: ate.clanIds } : {}),
    };
  }
  if (a.domainsWhitelist?.length) doc.domainsWhitelist = a.domainsWhitelist;
}

/** POST /templates/new — create a V3 template from a the-wall-dev/2 document. */
export async function createTemplate(input: PublishInput): Promise<{ template: TplSummary; warnings?: string[] }> {
  const c = getActiveClient();
  if (!c) throw new Error("not connected");
  const doc: Record<string, unknown> = { ...input.document, format: "the-wall-dev/2" };
  applyAccess(doc, input.access);
  if (input.notes?.length) doc.notes = input.notes;
  applyAuthor(doc, input.authorVisibility, c.me?.id);
  const body = {
    scope: input.scope,
    clanId: input.scope === "clan" ? input.clanId ?? undefined : undefined,
    source: { format: "the-wall-dev/2", document: doc },
    accessPassword: input.password?.trim() ? input.password.trim() : undefined,
  };
  return c.post("/templates/new", body);
}

/** PATCH /templates/{id} — flexible edit (scope, access, author visibility). */
export async function patchTemplate(id: string, patch: Record<string, unknown>): Promise<TplSummary> {
  const c = getActiveClient();
  if (!c) throw new Error("not connected");
  return c.patch(`/templates/${encodeURIComponent(id)}`, patch);
}

/** Owner download URL for an export format (authenticated via ?session=). */
export function exportUrl(id: string, format: "wall-dev" | "charity" = "wall-dev"): string {
  const c = getActiveClient();
  if (!c) return "";
  return `${c.url}/templates/${encodeURIComponent(id)}/${format}${authSuffix()}`;
}

/** A shareable site link that autoloads the template (`?the_wall_dev=<export>`).
 *  The export URL carries `?password=` when supplied so a recipient without an
 *  account can still open a password-protected template; it never leaks the
 *  sharer's session token. Public templates need no credential. */
export function shareLink(id: string, password?: string): string {
  const c = getActiveClient();
  if (!c) return "";
  const pw = password?.trim() ? `?password=${encodeURIComponent(password.trim())}` : "";
  const exp = `${c.url}/templates/${encodeURIComponent(id)}/wall-dev${pw}`;
  let origin = "";
  try {
    origin = new URL(c.url).origin;
  } catch {
    origin = "";
  }
  return `${origin}/?the_wall_dev=${encodeURIComponent(exp)}`;
}
