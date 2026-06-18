import { CURSOR_INVENTORY_URL, SITE } from "./constants";
import { log } from "./log";
import { errMsg } from "./helpers";

export function siteToken(): string | null {
  return localStorage.getItem("auth-token");
}

export async function siteApi(endpoint: string): Promise<any> {
  const tok = siteToken();
  if (!tok) return null;
  try {
    const r = await fetch(`${SITE}/user/${endpoint}`, {
      headers: { Authorization: tok },
    });
    if (r.ok) return await r.json();
    log("SITE_API", "WARN", `${endpoint} -> ${r.status}`);
  } catch (e: any) {
    log("SITE_API", "ERR", e.toString());
  }
  return null;
}

/**
 * Fetch the user's coin balance from the site. Reads `coins` out of the
 * `/cursor/inventory` payload, which the site itself caches as `v8` after
 * each Z5() refresh. Returns null when offline / unauthenticated.
 */
export async function fetchCoinBalance(): Promise<number | null> {
  // Fast path: when window.player is available (dev mode), v8 isn't exposed
  // but `player.user?.coins` sometimes is. We still fall back to the API.
  const p: any = (window as any).player;
  if (p?.user && typeof p.user.coins === "number") return p.user.coins;

  const tok = siteToken();
  if (!tok) return null;
  try {
    const r = await fetch(CURSOR_INVENTORY_URL, {
      headers: { Authorization: tok, "Content-Type": "application/json" },
      credentials: "same-origin",
    });
    if (!r.ok) {
      log("SITE_API", "WARN", `cursor/inventory -> ${r.status}`);
      return null;
    }
    const j = await r.json();
    return typeof j?.coins === "number" ? j.coins : null;
  } catch (e: any) {
    log("SITE_API", "ERR", `coin balance: ${errMsg(e)}`);
    return null;
  }
}
