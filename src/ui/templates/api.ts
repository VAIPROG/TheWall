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
