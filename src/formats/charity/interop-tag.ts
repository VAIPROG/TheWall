/**
 * Charity has no field for our author UUID / backend URL. To let a Charity
 * export round-trip its origin back into the extension, we smuggle a marker of
 * the form `(TheWallDev: ID:{UUID};BACKEND:{URL})` into the template name (and
 * optionally a contact). Opt-out at the call site. On decode we parse it back
 * out and strip it from the visible name.
 */
export interface InteropIdentity { id?: string; backendUrl?: string; }

const TAG_RE = /\(TheWallDev:\s*ID:([^;)\s]+)(?:;BACKEND:([^)]+))?\)/;

export function encodeInteropTag(idy: InteropIdentity): string {
  const id = idy.id ?? "";
  const backend = idy.backendUrl ? `;BACKEND:${idy.backendUrl}` : "";
  return `(TheWallDev: ID:${id}${backend})`;
}

export function parseInteropTag(text: string): InteropIdentity | null {
  const m = TAG_RE.exec(text || "");
  if (!m) return null;
  return { id: m[1] || undefined, backendUrl: m[2] || undefined };
}

export function stripInteropTag(text: string): string {
  return (text || "").replace(TAG_RE, "").replace(/\s{2,}/g, " ");
}
