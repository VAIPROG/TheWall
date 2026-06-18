import { VERSION } from "./constants";
import { log } from "./log";
import { toast } from "./notify";

const SIGNATURE_URL = "https://the-wall.vai-rice.space/dist/signature.json";
const POLL_INTERVAL = 30 * 60 * 1000; // 30 min
const SKIP_KEY = "walldev_skip_version";

interface Signature {
  version: string;
  hash: string;
  built_at: string;
  downloads: {
    userscript: string;
    chrome_zip: string;
    firefox_zip: string;
    /** Optional in older signature files. The landing page only shows this
     *  link when the field is present. */
    safari_zip?: string;
  };
  notes?: string;
}

/**
 * Compare two dotted version strings ("4.2.0" vs "4.10.1").
 *
 * Returns a negative number if `a < b`, positive if `a > b`, 0 if equal.
 * Non-numeric segments are coerced to 0, missing segments are treated as 0
 * (so "4.2" == "4.2.0"). This is the only place the rule lives — both the
 * background poller and the "Check for update" button defer here.
 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function checkOnce(): Promise<void> {
  try {
    const r = await fetch(SIGNATURE_URL + "?_=" + Date.now(), { cache: "no-store" });
    if (!r.ok) return;
    const sig: Signature = await r.json();
    if (!sig.version) return;
    if (cmpVersion(sig.version, VERSION) <= 0) return;
    if (localStorage.getItem(SKIP_KEY) === sig.version) return;
    log("UPDATE", "OK", `${VERSION} -> ${sig.version}`);
    toast(
      "Update available",
      `v${sig.version} is out (you have v${VERSION}). Settings → check for update.`,
    );
    // Stash latest for UI to read
    (window as any).__WALL_UPDATE__ = sig;
  } catch (e: any) {
    log("UPDATE", "WARN", e.toString());
  }
}

export function startUpdateChecker(): void {
  setTimeout(checkOnce, 5000);
  setInterval(checkOnce, POLL_INTERVAL);
}

export function manualCheck(): Promise<Signature | null> {
  return fetch(SIGNATURE_URL + "?_=" + Date.now(), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
}

export function skipVersion(v: string): void {
  localStorage.setItem(SKIP_KEY, v);
}
