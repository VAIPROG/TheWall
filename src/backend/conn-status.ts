/**
 * Connection-status resolver — the single source of truth for "is the
 * extension connected to the backend?".
 *
 * History: the Settings card used to check `cfg.backendToken`, but after the
 * multi-backend migration the real token lives in the `walldev_backends`
 * store (BackendClient.setToken → saveBackends) and `cfg.backendToken` was
 * never written on login — so the card said "not connected" forever while
 * every request worked. This resolver derives status from the CLIENT state
 * plus a liveness hint, and is pure so it can be unit-tested DOM-free.
 */

export interface ConnSnapshot {
  /** Backend entry enabled (client.enabled). */
  enabled: boolean;
  /** Non-empty base URL configured. */
  hasUrl: boolean;
  /** Non-empty access token present. */
  hasToken: boolean;
  /** Cached identity from a successful /auth/session (getMe()). */
  username?: string;
  /** Epoch ms of the last successful request, if tracked. */
  lastOkAt?: number;
  /** "Now" for liveness math (injectable for tests). */
  now?: number;
}

export interface ConnState {
  /** Token + URL + enabled — requests will carry auth and should succeed. */
  connected: boolean;
  /** A request actually succeeded recently (or an identity is cached). */
  live: boolean;
  /** Display name for the account card. */
  who: string;
}

/** How recent a successful request must be to count as "live". */
export const CONN_LIVE_WINDOW_MS = 5 * 60_000;

export function resolveConnState(s: ConnSnapshot): ConnState {
  const connected = s.enabled && s.hasUrl && s.hasToken;
  const now = s.now ?? Date.now();
  // Liveness is a hint, not a gate: a cached identity means /auth/session
  // succeeded this session; a fresh lastOkAt means any request landed.
  const live =
    connected &&
    (!!s.username || (typeof s.lastOkAt === "number" && now - s.lastOkAt < CONN_LIVE_WINDOW_MS));
  return {
    connected,
    live,
    who: connected ? s.username || "connected" : "",
  };
}
