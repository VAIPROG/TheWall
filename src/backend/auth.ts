import { BackendClient } from "./client";
import {
  AccountPublic,
  BackendAuthResponse,
  BackendUser,
  MergeInitiateResponse,
  MergeResult,
  OAuthCallbackBody,
  OAuthStartResponse,
  RecoveryPhraseResponse,
  SessionInfo,
} from "./types";

/**
 * Authentication and account-recovery API for TheWall V3.
 *
 * All methods that produce a new session (`loginWithSiteToken`, `refresh`,
 * `recover`, `oauthCallback`, `merge`) update the active backend's token and
 * cached identity automatically. `logout()` clears them.
 */
export interface BackendAuthApi {
  /** Current session: account + site identities + OAuth providers. */
  session(): Promise<SessionInfo>;

  /** Convenience shortcut: `session().user`. */
  me(): Promise<BackendUser>;

  /** Exchange a site token (e.g. from filianislost.com) for a JWT session. */
  loginWithSiteToken(site: string, token: string): Promise<BackendAuthResponse>;

  /** Exchange the stored refresh token for a fresh JWT session. */
  refresh(): Promise<BackendAuthResponse>;

  /** Log out the current account everywhere. */
  logout(): Promise<void>;

  /** Generate a new BIP-39 recovery phrase (returned ONCE). */
  recoveryPhrase(): Promise<RecoveryPhraseResponse>;

  /** Recover an account using a previously saved recovery phrase. */
  recover(phrase: string): Promise<BackendAuthResponse>;

  /** Start an account merge: obtain a token to give to the other account. */
  mergeInitiate(): Promise<MergeInitiateResponse>;

  /** Complete a merge using a token received from another account. */
  merge(mergeToken: string): Promise<MergeResult>;

  /** Build an OAuth authorization URL for the given provider. */
  oauthStart(
    provider: string,
    intent: "login" | "link" | string,
    redirectUri?: string,
  ): Promise<OAuthStartResponse>;

  /** Complete OAuth flow after the provider redirects back. */
  oauthCallback(provider: string, code: string, state: string): Promise<BackendAuthResponse>;
}

export function buildAuthApi(client: BackendClient): BackendAuthApi {
  const applyAuth = (res: { accessToken?: string; refreshToken?: string; user?: AccountPublic }): BackendAuthResponse => {
    if (res.accessToken) client.setToken(res.accessToken, res.refreshToken);
    if (res.user) client.setMe(res.user as BackendUser);
    return {
      accessToken: res.accessToken || client.token,
      refreshToken: res.refreshToken || client.refreshToken,
      user: (res.user || client.me) as BackendUser | undefined,
    };
  };

  const clearSession = () => {
    client.setToken("");
    client.setMe(undefined);
  };

  return {
    session: () => client.get<SessionInfo>("/auth/session"),

    me: async () => {
      const s = await client.get<SessionInfo>("/auth/session");
      return s.user;
    },

    loginWithSiteToken: async (site, token) => {
      const res = await client.req<{
        accessToken: string;
        refreshToken?: string;
        expiresIn?: number;
        tokenType?: string;
        user: AccountPublic;
      }>({
        method: "POST",
        path: "/auth/site",
        body: { site, token },
        noAuth: true,
      });
      return applyAuth(res);
    },

    refresh: async () => {
      if (!client.refreshToken) throw new Error("no refresh token");
      const ok = await client.refresh();
      if (!ok) throw new Error("refresh failed");
      const s = await client.get<SessionInfo>("/auth/session");
      return {
        accessToken: client.token,
        refreshToken: client.refreshToken,
        user: s.user,
      };
    },

    logout: async () => {
      try {
        await client.post("/auth/logout");
      } finally {
        clearSession();
      }
    },

    recoveryPhrase: () =>
      client.post<RecoveryPhraseResponse>("/users/me/recovery/phrase"),

    recover: async (phrase) => {
      const res = await client.req<{
        accessToken: string;
        refreshToken?: string;
        user: AccountPublic;
      }>({
        method: "POST",
        path: "/auth/recover",
        body: { phrase },
        noAuth: true,
      });
      return applyAuth(res);
    },

    mergeInitiate: () =>
      client.post<MergeInitiateResponse>("/auth/merge/initiate"),

    merge: async (mergeToken) => {
      const res = await client.post<{
        mergedAccountId: string;
        accessToken: string;
        refreshToken?: string;
        user: AccountPublic;
      }>("/users/me/merge", { mergeToken });
      return {
        mergedAccountId: res.mergedAccountId,
        ...applyAuth(res),
      };
    },

    oauthStart: (provider, intent, redirectUri) => {
      const qs = new URLSearchParams({ intent });
      if (redirectUri) qs.set("redirectUri", redirectUri);
      return client.get<OAuthStartResponse>(`/auth/oauth/${encodeURIComponent(provider)}/start?${qs.toString()}`);
    },

    oauthCallback: async (provider, code, state) => {
      const res = await client.req<{
        accessToken: string;
        refreshToken?: string;
        user: AccountPublic;
      }>({
        method: "POST",
        path: `/auth/oauth/${encodeURIComponent(provider)}/callback`,
        body: { code, state } as OAuthCallbackBody,
        noAuth: true,
      });
      return applyAuth(res);
    },
  };
}

/** @deprecated import { buildAuthApi } instead */
export const AuthApi = { build: buildAuthApi };
