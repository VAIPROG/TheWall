/**
 * V3 template data layer for the Templates super-tab. Thin wrappers over the
 * backend client (`client.get/post/patch/delete` → V3 base `client.url`). No
 * legacy calls. Previews/animated use the V3 render endpoints (work for every
 * template after the prod backfill).
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
  hasDocument?: boolean;
  verifiedAt?: string | null;
  createdAt?: string;
  x?: number;
  y?: number;
}

/** Pure chip → list query mapping (unit-tested). `mine` is resolved to the
 *  caller's author id inside {@link listTemplates}. */
export function listParams(chip: Chip): Record<string, unknown> {
  if (chip === "public") return { scope: "public", status: "approved", limit: 200 };
  if (chip === "clan") return { scope: "clan", limit: 200 };
  if (chip === "mine") return { mine: true, limit: 200 };
  return { limit: 200 };
}

export async function listTemplates(chip: Chip): Promise<TplSummary[]> {
  const c = getActiveClient();
  if (!c) return [];
  const p: Record<string, unknown> = { ...listParams(chip) };
  if (p.mine) {
    delete p.mine;
    if (c.me) p.author = c.me.id; // owner sees all of their own (any scope/status)
  }
  return c.get<TplSummary[]>("/templates", p);
}

/** V3 still preview (webp). Works for every template post-backfill. */
export function previewUrl(id: string, size = 128, layer = 0): string {
  const c = getActiveClient();
  return c ? `${c.url}/templates/${encodeURIComponent(id)}/preview?size=${size}&layer=${layer}` : "";
}

/** V3 animated GIF preview. */
export function animatedUrl(id: string, layer = 0): string {
  const c = getActiveClient();
  return c ? `${c.url}/templates/${encodeURIComponent(id)}/animated?layer=${layer}` : "";
}
