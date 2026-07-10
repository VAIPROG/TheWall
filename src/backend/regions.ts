import { BackendClient } from "./client";

/**
 * Region protection API.
 *
 * NOTE: region protection is currently disabled for WPLACE because the backend
 * needs updates for V3. The methods are kept for future re-enable but do not
 * perform any network calls.
 */
export function buildRegionsApi(_client: BackendClient) {
  return {
    list: () => Promise.resolve([] as any[]),
    get: (_id: string) => Promise.resolve(null),
    create: (_body: unknown) => Promise.resolve(null),
    update: (_id: string, _body: unknown) => Promise.resolve(null),
    delete: (_id: string) => Promise.resolve(null),
    report: (_id: string, _brokenPct: number, _ok: boolean) => Promise.resolve(null),
    approve: (_id: string) => Promise.resolve(null),
    reject: (_id: string) => Promise.resolve(null),
  };
}
