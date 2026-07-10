import { BackendClient } from "./client";

export interface AnimTemplateCreate {
  name: string;
  config: unknown;
  scope?: string;
  clan_id?: string;
}

export interface RegionCreate {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tolerance_pct?: number;
  ref_png: string;
  scope?: string;
  clan_id?: string;
  check_interval?: number;
}

/**
 * Compatibility surface for endpoints that still live under the unversioned
 * API root or `/api/v2/*`. Every call here resolves against `client.rootUrl`
 * (`.../api`) via the `*Root` helpers, NOT the V3 base.
 *
 * These awaits migration to V3 where a V3 equivalent exists:
 *   - animated templates → fold into the unified `the-wall-dev/2` template
 *     document (animation is an inline per-layer block, not a separate entity).
 *   - regions → no V3 equivalent yet; keep V2.
 *   - classic `/v2/templates` → superseded by `/api/v3/templates`.
 */
export function buildLegacyApi(client: BackendClient) {
  const animPath = (id: string) => `/v2/animated/templates/${encodeURIComponent(id)}`;
  const regionPath = (id: string) => `/v2/regions/${encodeURIComponent(id)}`;

  return {
    // V1/V2 animated templates -------------------------------------------
    // TODO(v3): animation now lives inline in the-wall-dev/2 template docs.
    listAnimTemplates: (clanId?: string) =>
      client.getRoot(
        "/v2/animated/templates" +
          (clanId ? `?clan_id=${encodeURIComponent(clanId)}` : ""),
      ),

    createAnimTemplate: (body: AnimTemplateCreate) =>
      client.postRoot("/v2/animated/templates", body),

    updateAnimTemplate: (id: string, body: Record<string, unknown>) =>
      client.putRoot(animPath(id), body),

    deleteAnimTemplate: (id: string) => client.deleteRoot(animPath(id)),

    sharedAnimTemplate: (id: string, pass?: string) =>
      client.getRoot(
        `${animPath(id)}/shared` +
          (pass ? `?pass=${encodeURIComponent(pass)}` : ""),
      ),

    previewAnimTemplate: (id: string, size = 64) =>
      `${client.rootUrl}/v2/animated/templates/${encodeURIComponent(id)}/preview?size=${size}`,

    approveAnimTemplate: (id: string) =>
      client.postRoot(`${animPath(id)}/approve`),

    // V1/V2 regions --------------------------------------------------------
    // TODO(v3): no V3 equivalent yet — awaits migration.
    listRegions: (clanId?: string) =>
      client.getRoot(
        "/v2/regions" + (clanId ? `?clan_id=${encodeURIComponent(clanId)}` : ""),
      ),

    getRegion: (id: string) => client.getRoot(regionPath(id)),

    createRegion: (body: RegionCreate) => client.postRoot("/v2/regions", body),

    updateRegion: (id: string, body: Record<string, unknown>) =>
      client.putRoot(regionPath(id), body),

    deleteRegion: (id: string) => client.deleteRoot(regionPath(id)),

    reportRegion: (id: string, brokenPct: number, ok: boolean) =>
      client.postRoot(`${regionPath(id)}/report`, { broken_pct: brokenPct, ok }),

    approveRegion: (id: string) => client.postRoot(`${regionPath(id)}/approve`),

    rejectRegion: (id: string) => client.postRoot(`${regionPath(id)}/reject`),

    // V1/V2 classic templates ---------------------------------------------
    // TODO(v3): superseded by /api/v3/templates.
    listTemplatesV2: (params?: {
      scope?: string;
      status?: string;
      limit?: number;
    }) => client.getRoot("/v2/templates", params),

    createTemplateV2: (body: {
      name: string;
      x: number;
      y: number;
      scale?: number;
      scope: string;
      share: string;
      clan_id?: string;
      access_password?: string;
    }) => client.postRoot("/v2/templates", body),

    sharedTemplate: (id: string, pass?: string) =>
      client.getRoot(
        `/v2/templates/${encodeURIComponent(id)}/shared` +
          (pass ? `?pass=${encodeURIComponent(pass)}` : ""),
      ),

    pinTemplateV2: (id: string, slot?: number) =>
      client.postRoot(`/v2/templates/${encodeURIComponent(id)}/pin`, { slot }),

    reportTemplate: (id: string, reason: string) =>
      client.postRoot(`/templates/${encodeURIComponent(id)}/report`, { reason }),

    approveTemplate: (id: string) =>
      client.postRoot(`/templates/${encodeURIComponent(id)}/approve`),

    deleteTemplate: (id: string) => client.deleteRoot(`/templates/${encodeURIComponent(id)}`),

    publicTemplates: (status = "approved") =>
      client.getRoot(`/templates/public?status=${encodeURIComponent(status)}`),

    // Relay chat -----------------------------------------------------------
    relayChat: (markdown: string) => client.postRoot("/chat/relay", { markdown }),
  };
}
