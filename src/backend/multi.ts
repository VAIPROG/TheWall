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
      },
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
