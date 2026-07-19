import { cfg, saveCfg } from "../config";
import { BackendClient } from "./client";
import { StoredBackend, BackendUser } from "./types";

const BACKENDS_KEY = "walldev_backends";

/**
 * Normalize a backend URL to the versioned V3 API base. The typed client
 * resolves V3 paths (`/users/me`, `/clans`, …) against this base, so it MUST
 * end with `/v3`. Legacy `/v2` and V1 paths are reached via the client's
 * root-scoped helpers (see BackendClient.rootUrl). Accepts either `.../api`
 * (legacy config) or an already-versioned `.../api/v3`.
 */
export function toV3ApiBase(url?: string): string {
  const base = (url || "https://the-wall.vai-rice.space/api").replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? base.replace(/\/v\d+$/, "/v3") : base + "/v3";
}

const LEGACY_URL = toV3ApiBase(cfg.backendUrl);
const LEGACY_TOKEN = cfg.backendToken;
const LEGACY_REFRESH = cfg.refreshToken;

let globalMe: BackendUser | undefined = undefined;

export function getMe(): BackendUser | undefined {
  return globalMe;
}

export function setMe(u: BackendUser | undefined): void {
  globalMe = u;
  // Identity arriving/leaving is a state change the status card cares about
  // (e.g. session restored from a stored token without a fresh login).
  emitBackendStateEvent();
}

function loadStoredBackends(): StoredBackend[] {
  try {
    const raw = localStorage.getItem(BACKENDS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoredBackend[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Migrate any pre-versioned URLs (`.../api`) to the V3 base.
        for (const b of parsed) b.url = toV3ApiBase(b.url);
        return parsed;
      }
    }
  } catch {}

  // Migration from single-backend config.
  return [
    {
      id: "default",
      label: "The Wall",
      url: LEGACY_URL || "https://the-wall.vai-rice.space/api/v3",
      token: LEGACY_TOKEN || "",
      refreshToken: LEGACY_REFRESH || undefined,
      active: true,
      enabled: true,
    },
  ];
}

export const backends: StoredBackend[] = loadStoredBackends();

export function saveBackends(): void {
  localStorage.setItem(BACKENDS_KEY, JSON.stringify(backends));
}

/**
 * Keep the legacy single-backend `cfg` fields in sync with the ACTIVE
 * backend. The multi-backend store is the token truth (login/refresh write
 * here via BackendClient.setToken), but plenty of older code still reads
 * `cfg.backendToken` — the Settings connection card, the `me.html#wd_jwt=`
 * OAuth handoff, the connect/disconnect toggle. Without the mirror those all
 * saw an empty token after the migration and reported "not connected" on a
 * perfectly healthy session.
 */
function syncLegacyTokenMirror(): void {
  const b = backends.find((x) => x.active) || backends[0];
  if (!b) return;
  const token = b.token || "";
  const refresh = b.refreshToken || "";
  if (cfg.backendToken !== token || cfg.refreshToken !== refresh) {
    cfg.backendToken = token;
    cfg.refreshToken = refresh;
    saveCfg();
  }
}

// Seed the mirror at boot: the stored backends may carry a token from a
// previous session that never made it back into cfg.
syncLegacyTokenMirror();

/** Epoch ms of the last successful request on any client (liveness hint). */
let lastOkAt = 0;

export function getLastOkAt(): number {
  return lastOkAt;
}

/** Notify UI (Settings card, titlebar, links rows) that backend state moved. */
function emitBackendStateEvent(): void {
  // Guard: pure/unit-test contexts have no DOM.
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent("wd:backend-state"));
}

export function getActiveBackend(): StoredBackend | null {
  return backends.find((b) => b.active && b.enabled) || backends.find((b) => b.enabled) || null;
}

export function setActiveBackend(id: string): void {
  for (const b of backends) b.active = b.id === id;
  saveBackends();
}

export function addBackend(b: StoredBackend): void {
  backends.push(b);
  if (b.active) setActiveBackend(b.id);
  else saveBackends();
}

export function removeBackend(id: string): void {
  const idx = backends.findIndex((b) => b.id === id);
  if (idx < 0) return;
  backends.splice(idx, 1);
  if (backends.length > 0 && !backends.some((b) => b.active)) {
    backends[0].active = true;
  }
  saveBackends();
}

export function updateBackend(id: string, patch: Partial<StoredBackend>): void {
  const b = backends.find((x) => x.id === id);
  if (!b) return;
  Object.assign(b, patch);
  saveBackends();
}

const clients = new Map<string, BackendClient>();

export function getClient(id?: string): BackendClient | null {
  const backend = id ? backends.find((b) => b.id === id) : getActiveBackend();
  if (!backend) return null;
  let c = clients.get(backend.id);
  if (!c) {
    c = new BackendClient({
      backend,
      onStateChange: (b) => {
        saveBackends();
        if (!b.enabled) setMe(undefined);
        // Token/enabled/me changed → refresh the legacy mirror and let any
        // status UI (Settings card, titlebar) repaint reactively.
        syncLegacyTokenMirror();
        emitBackendStateEvent();
      },
    });
    // Liveness: stamp every successful response so the status card can say
    // "connected" from evidence, not from a flag that goes stale.
    c.addResponseInterceptor((value) => {
      lastOkAt = Date.now();
      return value;
    });
    clients.set(backend.id, c);
  }
  return c;
}

export function getActiveClient(): BackendClient | null {
  return getClient();
}

export function getClientForUrl(url: string): BackendClient | null {
  const normalized = url.replace(/\/+$/, "").toLowerCase();
  const b = backends.find((x) => x.url.replace(/\/+$/, "").toLowerCase() === normalized);
  return b ? getClient(b.id) : null;
}

export function clearClients(): void {
  clients.clear();
}
