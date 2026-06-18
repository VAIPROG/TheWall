import { cfg, saveCfg } from "./config";
import { log } from "./log";
import { siteToken } from "./site-api";

export interface BackendUser {
  username: string;
  id: string | number;
  discord_id?: string;
  discord_username?: string;
  role?: string;
  clan_role?: string;
  cursor_id?: string;
  preferred_lang?: string;
  has_custom_avatar?: boolean;
}

let _me: BackendUser | null = null;
export function getMe(): BackendUser | null { return _me; }
export function setMe(u: BackendUser | null): void { _me = u; }

export const Backend = {
  get base(): string {
    return (cfg.backendUrl || "").replace(/\/+$/, "");
  },
  get on(): boolean {
    return !!(this.base && cfg.backendToken);
  },
  /**
   * Make a backend request with automatic retry on transient failures.
   *
   * Two flavours of recovery share this entry point:
   *   - 401 + refresh token present → refresh and retry once (existing).
   *   - Network timeout / fetch error / 5xx → retry up to RETRY_LIMIT
   *     times with exponential backoff (200 ms, 400 ms, 800 ms).
   *
   * The `_retry` parameter doubles as a "we already refreshed once" flag so
   * the auth path can't loop infinitely; the network-retry counter is
   * passed separately so the two recovery strategies stay independent.
   */
  async req(
    method: string,
    path: string,
    body?: any,
    _retry?: boolean,
    _attempt = 0,
  ): Promise<any> {
    if (!this.base) throw new Error("backend not configured");
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (cfg.backendToken) h.Authorization = `Bearer ${cfg.backendToken}`;

    const RETRY_LIMIT = 2;            // total retries on network errors
    const TIMEOUT_MS = 15_000;        // give up on a single attempt after 15 s
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort("ERR_TIMEOUT"), TIMEOUT_MS);

    let r: Response;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: h,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      // Map AbortError + generic network failures onto a uniform retry path.
      const isAbort = e?.name === "AbortError" || /timeout/i.test(String(e?.message));
      const retriable = isAbort || /failed to fetch|network/i.test(String(e?.message || e));
      if (retriable && _attempt < RETRY_LIMIT) {
        const backoff = 200 * (1 << _attempt);
        await new Promise((res) => setTimeout(res, backoff));
        return this.req(method, path, body, _retry, _attempt + 1);
      }
      throw new Error(isAbort ? "ERR_TIMEOUT" : (e?.message || String(e)));
    }
    clearTimeout(timer);

    if (r.status === 401 && !_retry && cfg.refreshToken) {
      if (await this.refresh()) return this.req(method, path, body, true, 0);
    }
    // 5xx retry — same backoff as network errors, capped at RETRY_LIMIT.
    if (r.status >= 500 && _attempt < RETRY_LIMIT) {
      const backoff = 200 * (1 << _attempt);
      await new Promise((res) => setTimeout(res, backoff));
      return this.req(method, path, body, _retry, _attempt + 1);
    }
    if (!r.ok) {
      let msg = `${path} -> ${r.status}`;
      try { const t = await r.text(); if (t) msg += `: ${t.slice(0, 200)}`; } catch {}
      throw new Error(msg);
    }
    if (r.status === 204) return null;
    const text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  },
  async login(): Promise<any> {
    const tok = siteToken();
    if (!this.base || !tok) return null;
    const r = await fetch(this.base + "/auth/site", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteToken: tok }),
    });
    if (!r.ok) throw new Error("auth/site -> " + r.status);
    const data = await r.json();
    cfg.backendToken = data.token;
    cfg.refreshToken = data.refreshToken || "";
    saveCfg();
    _me = data.user || _me;
    return data;
  },
  async refresh(): Promise<boolean> {
    try {
      const r = await fetch(this.base + "/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: cfg.refreshToken }),
      });
      if (!r.ok) return false;
      const d = await r.json();
      cfg.backendToken = d.token;
      if (d.refreshToken) cfg.refreshToken = d.refreshToken;
      saveCfg();
      return true;
    } catch {
      return false;
    }
  },
  me: () => Backend.req("GET", "/auth/me"),
  i18n: (lng: string) => Backend.req("GET", `/i18n/${lng}`),
  notifications: () => Backend.req("GET", "/notifications"),
  ackNotifications: (ids: string[]) => Backend.req("POST", "/notifications/ack", { ids }),
  announcements: () => Backend.req("GET", "/announcements"),
  clanMessages: (since?: string) => Backend.req("GET", `/clan/chat${since ? `?since=${since}` : ""}`),
  sendClanMessage: (text: string) => Backend.req("POST", "/clan/chat", { text }),
  deleteClanMessage: (id: string) => Backend.req("DELETE", `/clan/chat/${encodeURIComponent(id)}`),
  clanMembers: () => Backend.req("GET", "/clan/members"),
  moderationApply: (message: string) => Backend.req("POST", "/clan/moderation/apply", { message }),
  listClanTemplates: () => Backend.req("GET", "/clan/templates"),
  publicTemplates: (status?: string) => Backend.req("GET", `/templates/public?status=${status || "approved"}`),
  shareTemplate: (tpl: any) => Backend.req("POST", "/templates", tpl),
  reportTemplate: (id: string, reason: string) => Backend.req("POST", `/templates/${encodeURIComponent(id)}/report`, { reason }),
  approveTemplate: (id: string) => Backend.req("POST", `/templates/${encodeURIComponent(id)}/approve`),
  myAvatar: () => Backend.req("GET", "/me/avatar"),
  setAvatar: (image: string) => Backend.req("PUT", "/me/avatar", { image }),
  leaderboard: () => Backend.req("GET", "/stats/leaderboard"),
  relayChat: (markdown: string) => Backend.req("POST", "/chat/relay", { markdown }),
  async listTemplatesV2(params?: { scope?: string; status?: string; limit?: number }): Promise<any[]> {
    const qs = params ? new URLSearchParams(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)])
    ).toString() : "";
    return this.req("GET", "/v2/templates" + (qs ? "?" + qs : ""));
  },
  async createTemplateV2(body: { name: string; x: number; y: number; scale?: number; scope: string; share: string; clan_id?: string; access_password?: string }): Promise<any> {
    return this.req("POST", "/v2/templates", body);
  },
  /** Share-code fetch for classic templates: correct `pass` opens even
   *  private rows (no session needed); mirrors sharedAnimTemplate below. */
  sharedTemplate: (id: string, pass?: string) =>
    Backend.req(
      "GET",
      `/v2/templates/${encodeURIComponent(id)}/shared` +
        (pass ? `?pass=${encodeURIComponent(pass)}` : ""),
    ),
  async listMailbox(kind?: string): Promise<any[]> {
    return this.req("GET", "/v2/mailbox" + (kind ? "?kind=" + kind : ""));
  },

  /* --- animated-template configs (the-wall-dev/1 envelopes) -------------- */
  listAnimTemplates: (clanId?: string) =>
    Backend.req("GET", "/v2/animated/templates" + (clanId ? `?clan_id=${encodeURIComponent(clanId)}` : "")),
  createAnimTemplate: (body: { name: string; config: unknown; scope?: string; clan_id?: string }) =>
    Backend.req("POST", "/v2/animated/templates", body),
  updateAnimTemplate: (id: string, body: Record<string, unknown>) =>
    Backend.req("PUT", `/v2/animated/templates/${encodeURIComponent(id)}`, body),
  deleteAnimTemplate: (id: string) =>
    Backend.req("DELETE", `/v2/animated/templates/${encodeURIComponent(id)}`),
  /** Share-link fetch: correct `pass` opens even private configs (no session
   *  needed); otherwise the caller's session must pass visibility rules. */
  sharedAnimTemplate: (id: string, pass?: string) =>
    Backend.req(
      "GET",
      `/v2/animated/templates/${encodeURIComponent(id)}/shared` +
        (pass ? `?pass=${encodeURIComponent(pass)}` : ""),
    ),

  /* --- protected regions -------------------------------------------------- */
  listRegions: (clanId?: string) =>
    Backend.req("GET", "/v2/regions" + (clanId ? `?clan_id=${encodeURIComponent(clanId)}` : "")),
  getRegion: (id: string) => Backend.req("GET", `/v2/regions/${encodeURIComponent(id)}`),
  createRegion: (body: {
    name: string; x: number; y: number; w: number; h: number;
    tolerance_pct?: number; ref_png: string; scope?: string; clan_id?: string;
    check_interval?: number;
  }) => Backend.req("POST", "/v2/regions", body),
  updateRegion: (id: string, body: Record<string, unknown>) =>
    Backend.req("PUT", `/v2/regions/${encodeURIComponent(id)}`, body),
  deleteRegion: (id: string) =>
    Backend.req("DELETE", `/v2/regions/${encodeURIComponent(id)}`),
  reportRegion: (id: string, brokenPct: number, ok: boolean) =>
    Backend.req("POST", `/v2/regions/${encodeURIComponent(id)}/report`, { broken_pct: brokenPct, ok }),
  approveRegion: (id: string) =>
    Backend.req("POST", `/v2/regions/${encodeURIComponent(id)}/approve`),
  rejectRegion: (id: string) =>
    Backend.req("POST", `/v2/regions/${encodeURIComponent(id)}/reject`),
};
