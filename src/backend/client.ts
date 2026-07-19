import { BackendError, BackendRequestInit, BackendUser, StoredBackend } from "./types";

export interface BackendClientOptions {
  backend: StoredBackend;
  onStateChange?: (b: StoredBackend) => void;
}

export type RequestInterceptor = (
  init: BackendRequestInit,
) => BackendRequestInit | Promise<BackendRequestInit>;
export type ResponseInterceptor = <T>(
  value: T,
  meta: { path: string; status: number },
) => T | Promise<T>;
export type ErrorInterceptor = (
  err: BackendError,
  meta: { path: string },
) => BackendError | Promise<BackendError>;

const RETRY_LIMIT = 2;
const TIMEOUT_MS = 15_000;

function buildError(
  message: string,
  extras: Partial<BackendError> & { backendId?: string },
): BackendError {
  const err: BackendError = new Error(message);
  if (extras.status !== undefined) err.status = extras.status;
  if (extras.path !== undefined) err.path = extras.path;
  if (extras.backendId !== undefined) err.backendId = extras.backendId;
  return err;
}

export class BackendClient {
  private backend: StoredBackend;
  private onStateChange?: (b: StoredBackend) => void;
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];

  constructor(opts: BackendClientOptions) {
    this.backend = opts.backend;
    this.onStateChange = opts.onStateChange;
  }

  get id(): string {
    return this.backend.id;
  }

  get label(): string {
    return this.backend.label;
  }

  get url(): string {
    return this.backend.url.replace(/\/+$/, "");
  }

  /**
   * API root without the version segment, e.g. `.../api` when `url` is
   * `.../api/v3`. Legacy/V1 endpoints and `/v2/...` paths resolve against this.
   */
  get rootUrl(): string {
    return this.url.replace(/\/v\d+$/, "");
  }

  /** Alias of `url` kept for backwards compatibility with legacy callers. */
  get base(): string {
    return this.url;
  }

  get on(): boolean {
    return this.backend.enabled && !!(this.url && this.backend.token);
  }

  get enabled(): boolean {
    return this.backend.enabled;
  }

  get me(): BackendUser | undefined {
    return this.backend.me;
  }

  get token(): string {
    return this.backend.token;
  }

  get refreshToken(): string | undefined {
    return this.backend.refreshToken;
  }

  setMe(u: BackendUser | undefined): void {
    this.backend.me = u;
    this.emitChange();
  }

  setToken(token: string, refreshToken?: string): void {
    this.backend.token = token;
    if (refreshToken !== undefined) this.backend.refreshToken = refreshToken;
    this.emitChange();
  }

  setEnabled(enabled: boolean): void {
    this.backend.enabled = enabled;
    this.emitChange();
  }

  addRequestInterceptor(fn: RequestInterceptor): () => void {
    this.requestInterceptors.push(fn);
    return () => {
      const idx = this.requestInterceptors.indexOf(fn);
      if (idx >= 0) this.requestInterceptors.splice(idx, 1);
    };
  }

  addResponseInterceptor(fn: ResponseInterceptor): () => void {
    this.responseInterceptors.push(fn);
    return () => {
      const idx = this.responseInterceptors.indexOf(fn);
      if (idx >= 0) this.responseInterceptors.splice(idx, 1);
    };
  }

  addErrorInterceptor(fn: ErrorInterceptor): () => void {
    this.errorInterceptors.push(fn);
    return () => {
      const idx = this.errorInterceptors.indexOf(fn);
      if (idx >= 0) this.errorInterceptors.splice(idx, 1);
    };
  }

  /**
   * Low-level request with automatic retry and token refresh.
   */
  async req<T = unknown>(
    init: BackendRequestInit,
    _retry = false,
    _attempt = 0,
  ): Promise<T> {
    if (!this.url) throw new Error(`backend ${this.id} not configured`);

    let next = init;
    for (const fn of this.requestInterceptors) {
      next = await fn(next);
    }

    // A FormData body means multipart/form-data (e.g. the V3 avatar upload,
    // POST /api/v3/users/me/avatar with a `file` field). In that case DON'T set
    // Content-Type — the browser adds it WITH the multipart boundary — and pass
    // the FormData through unserialized. Everything else is JSON.
    const isForm = typeof FormData !== "undefined" && next.body instanceof FormData;
    const headers: Record<string, string> = {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      "X-ClientVersion-TheWallDev-API": "3",
      ...(next.headers || {}),
    };
    if (!next.noAuth && this.backend.token) {
      headers.Authorization = `Bearer ${this.backend.token}`;
    }

    const url = (next.root ? this.rootUrl : this.url) + next.path;
    const body =
      next.body === undefined
        ? undefined
        : isForm
          ? (next.body as FormData)
          : JSON.stringify(next.body);

    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort("ERR_TIMEOUT"), TIMEOUT_MS);
    if (next.signal) {
      next.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }

    let r: Response;
    try {
      r = await fetch(url, {
        method: next.method || "GET",
        headers,
        body,
        signal: ctrl.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      const isAbort = e?.name === "AbortError" || /timeout/i.test(String(e?.message));
      const retriable = isAbort || /failed to fetch|network/i.test(String(e?.message || e));
      if (retriable && _attempt < RETRY_LIMIT) {
        const backoff = 200 * (1 << _attempt);
        await new Promise((res) => setTimeout(res, backoff));
        return this.req(init, _retry, _attempt + 1);
      }
      const err = buildError(isAbort ? "ERR_TIMEOUT" : (e?.message || String(e)), {
        backendId: this.id,
        path: init.path,
      });
      throw await this.applyErrorInterceptors(err, init.path);
    } finally {
      clearTimeout(timer);
    }

    if (r.status === 401 && !_retry && this.backend.refreshToken) {
      if (await this.refresh()) return this.req(init, true, 0);
    }
    if (r.status >= 500 && _attempt < RETRY_LIMIT) {
      const backoff = 200 * (1 << _attempt);
      await new Promise((res) => setTimeout(res, backoff));
      return this.req(init, _retry, _attempt + 1);
    }

    if (!r.ok) {
      let detail = "";
      try {
        const t = await r.text();
        if (t) detail = t.slice(0, 200);
      } catch {}
      const err = buildError(`${init.path} -> ${r.status}${detail ? `: ${detail}` : ""}`, {
        status: r.status,
        path: init.path,
        backendId: this.id,
      });
      throw await this.applyErrorInterceptors(err, init.path);
    }

    let data: T;
    if (r.status === 204) {
      data = null as T;
    } else {
      const text = await r.text();
      if (!text) {
        data = null as T;
      } else {
        try {
          data = JSON.parse(text) as T;
        } catch {
          data = text as T;
        }
      }
    }

    for (const fn of this.responseInterceptors) {
      data = await fn(data, { path: init.path, status: r.status });
    }
    return data;
  }

  private async applyErrorInterceptors(err: BackendError, path: string): Promise<BackendError> {
    for (const fn of this.errorInterceptors) {
      err = await fn(err, { path });
    }
    return err;
  }

  /** Convenience GET. */
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T> {
    const qs = query
      ? "?" +
        new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return this.req<T>({ method: "GET", path: path + qs });
  }

  /** Convenience POST. */
  post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "POST", path, body });
  }

  /** Convenience PATCH. */
  patch<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "PATCH", path, body });
  }

  /** Convenience DELETE. */
  delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "DELETE", path, body });
  }

  /** Convenience PUT. */
  put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "PUT", path, body });
  }

  // --- Root-scoped variants (resolve against `.../api`, not `.../api/v3`) ---
  // Used by the legacy compat layer for `/v2/...` and unversioned V1 paths.

  getRoot<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T> {
    const qs = query
      ? "?" +
        new URLSearchParams(
          Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== null)
            .map(([k, v]) => [k, String(v)]),
        ).toString()
      : "";
    return this.req<T>({ method: "GET", path: path + qs, root: true });
  }

  postRoot<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "POST", path, body, root: true });
  }

  putRoot<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "PUT", path, body, root: true });
  }

  deleteRoot<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.req<T>({ method: "DELETE", path, body, root: true });
  }

  /**
   * Exchange a refresh token for a new access token.
   */
  async refresh(): Promise<boolean> {
    if (!this.backend.refreshToken) return false;
    try {
      const r = await fetch(`${this.url}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: this.backend.refreshToken }),
      });
      if (!r.ok) return false;
      const d = (await r.json()) as { token: string; refreshToken?: string };
      this.setToken(d.token, d.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  private emitChange(): void {
    this.onStateChange?.(this.backend);
  }
}

/** Type guard for BackendError objects. */
export function isBackendError(err: unknown): err is BackendError {
  return err instanceof Error && "backendId" in (err as Error);
}

/** Extract a typed BackendError from an unknown throw value. */
export function toBackendError(err: unknown, fallbackPath = ""): BackendError {
  if (isBackendError(err)) return err;
  if (err instanceof Error) {
    const be: BackendError = new Error(err.message);
    be.path = fallbackPath;
    return be;
  }
  const be: BackendError = new Error(String(err));
  be.path = fallbackPath;
  return be;
}

/** Extract a numeric HTTP status from any thrown value. */
export function errStatus(err: unknown): number | undefined {
  if (isBackendError(err)) return err.status;
  return undefined;
}

/** Extract the backend id from any thrown value. */
export function errBackendId(err: unknown): string | undefined {
  if (isBackendError(err)) return err.backendId;
  return undefined;
}

/** Wrap an async call so it never throws; returns `{ok, data, error}`. */
export async function safeCall<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T; error?: undefined } | { ok: false; data?: undefined; error: BackendError }> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: toBackendError(e) };
  }
}
