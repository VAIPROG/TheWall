/**
 * Client-side `domainsWhitelist` enforcement. The the-wall-dev/2 format lets an
 * author restrict which sites a template may be loaded on (CLIENT-SIDE only —
 * the backend does not enforce it, so this is best-effort courtesy, not
 * security). An empty/absent list means "allowed everywhere".
 */

/** Whether a template restricted to `domainsWhitelist` may load on `host`.
 *  Matches the exact hostname or any subdomain of a listed domain, so
 *  "site.com" also allows "www.site.com". A leading "*." is tolerated. */
export function isAllowedOnDomain(
  domainsWhitelist: string[] | undefined | null,
  host: string = typeof location !== "undefined" ? location.hostname : "",
): boolean {
  if (!domainsWhitelist || domainsWhitelist.length === 0) return true;
  const h = host.toLowerCase();
  return domainsWhitelist.some((d) => {
    const dd = String(d).trim().toLowerCase().replace(/^\*\./, "");
    return dd !== "" && (h === dd || h.endsWith("." + dd));
  });
}

/** Extract `domainsWhitelist` from a the-wall-dev document (object or JSON string). */
export function domainsOf(input: unknown): string[] | undefined {
  let obj: unknown = input;
  if (typeof input === "string") {
    try {
      obj = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  const dw = (obj as { domainsWhitelist?: unknown } | null | undefined)?.domainsWhitelist;
  return Array.isArray(dw) ? dw.filter((x): x is string => typeof x === "string") : undefined;
}
