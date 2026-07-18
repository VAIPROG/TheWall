/**
 * Linked-accounts (OAuth) status — wire shape + pure mapper.
 *
 * `GET /api/v2/me/links` returns a FLAT snake_case object (see
 * backend/src/routes/v2/links.rs `LinkStatus`), NOT the nested
 * `{ telegram: { username } }` shape the extension historically assumed —
 * that mismatch made every provider render as "not linked" forever. The
 * mapper below owns the translation so the UI never touches raw wire keys.
 *
 * Discord semantics deserve a note: `discord_id`/`discord_username` can come
 * from the site (filianislost login) OR from the OAuth link flow. DELETE
 * /me/links/discord only clears the `discord_linked_via_oauth` flag — the
 * site-sourced identity stays. So "linked via site" rows get a Connect
 * action (upgrade to OAuth), not a no-op Unlink.
 */

/** Exact response body of GET /api/v2/me/links (snake_case, all optional). */
export interface LinkStatusWire {
  discord_id?: string | null;
  discord_username?: string | null;
  discord_linked_via_oauth?: boolean | null;
  telegram_user_id?: string | null;
  telegram_username?: string | null;
  telegram_photo_url?: string | null;
  email?: string | null;
  email_request_status?: string | null;
}

export interface ProviderLinkRow {
  key: "telegram" | "discord";
  /** An identity is attached (any source). */
  linked: boolean;
  /** Human-readable handle to show (already provider-formatted, e.g. "@x"). */
  detail: string;
  /** Avatar/photo URL when the provider exposes one (Telegram only). */
  photoUrl?: string;
  /** True when Unlink is meaningful; false = show Connect instead. */
  canUnlink: boolean;
  /** Extra badge text, e.g. "via site" for site-sourced Discord identity. */
  note?: string;
}

/** Coerce a wire value that should be a non-empty string. */
function str(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * Map the raw /v2/me/links body into per-provider rows. Tolerates the legacy
 * nested shape (`{ telegram: { username } }`) defensively so a future backend
 * change can't regress the display back to "not linked".
 */
export function mapLinkStatus(raw: unknown): {
  telegram: ProviderLinkRow;
  discord: ProviderLinkRow;
} {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  // Legacy nested fallback: { telegram: { username }, discord: { username } }.
  const nestedTg = (s.telegram && typeof s.telegram === "object" ? s.telegram : {}) as Record<string, unknown>;
  const nestedDc = (s.discord && typeof s.discord === "object" ? s.discord : {}) as Record<string, unknown>;

  const tgId = str(s.telegram_user_id);
  const tgName = str(s.telegram_username) || str(nestedTg.username);
  const tgLinked = !!(tgId || tgName);

  const dcId = str(s.discord_id);
  const dcName = str(s.discord_username) || str(nestedDc.username);
  const dcOauth = s.discord_linked_via_oauth === true;
  const dcLinked = !!(dcId || dcName);

  return {
    telegram: {
      key: "telegram",
      linked: tgLinked,
      // Telegram usernames are optional — fall back to the numeric id.
      detail: tgLinked ? (tgName ? `@${tgName}` : `id ${tgId}`) : "",
      photoUrl: str(s.telegram_photo_url) || undefined,
      canUnlink: tgLinked,
    },
    discord: {
      key: "discord",
      linked: dcLinked,
      detail: dcLinked ? (dcName || `id ${dcId}`) : "",
      // DELETE only clears the OAuth flag — a site-sourced identity cannot
      // be unlinked here, so offer Connect (OAuth upgrade) instead.
      canUnlink: dcOauth,
      note: dcLinked && !dcOauth ? "via site" : undefined,
    },
  };
}
