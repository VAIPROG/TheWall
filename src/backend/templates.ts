import { BackendClient } from "./client";

export interface TemplateCreateRequest {
  scope: "public" | "clan" | "private";
  clanId?: string;
  source: {
    format: "the-wall-dev/2" | "the-wall-dev/1" | "charity";
    document: unknown;
  };
  accessPassword?: string;
}

export interface TemplatePatchRequest {
  expectedVersion?: number;
  scope?: "public" | "clan" | "private";
  clanId?: string | null;
  doc?: unknown;
  layerOps?: unknown[];
  accessPassword?: string;
}

export function buildTemplatesApi(client: BackendClient) {
  const path = (id: string) => `/templates/${encodeURIComponent(id)}`;

  return {
    list: (params?: { scope?: string; status?: string; author?: string; limit?: number; cursor?: string }) =>
      client.get("/templates", params),

    get: (id: string) => client.get(path(id)),

    wallDev: (id: string) => client.get(`${path(id)}/wall-dev`),

    charity: (id: string) => client.get(`${path(id)}/charity`),

    png: (id: string, layer = 0) =>
      `${client.url}${path(id)}/png?layer=${encodeURIComponent(layer)}`,

    preview: (id: string, size: 64 | 128 | 256 = 128, layer = 0) =>
      `${client.url}${path(id)}/preview?size=${size}&layer=${layer}`,

    /**
     * Animated GIF of a layer's sprite-sheet animation. Static layers fall back
     * to a still PNG, so this is always safe to point an <img> at. `size` fits
     * each frame into a size×size box (nearest-neighbour); omit for native.
     */
    animated: (id: string, layer = 0, size?: number) =>
      `${client.url}${path(id)}/animated?layer=${layer}` +
      (size ? `&size=${size}` : ""),

    create: (body: TemplateCreateRequest) => client.post("/templates/new", body),

    patch: (id: string, body: TemplatePatchRequest) => client.patch(path(id), body),

    delete: (id: string) => client.delete(path(id)),

    report: (id: string, reason: string) =>
      client.post(`${path(id)}/report`, { reason }),

    verify: (id: string, decision: "approve" | "reject", reason?: string) =>
      client.post(`${path(id)}/verify`, { decision, reason }),

    pin: (id: string) => client.post(`${path(id)}/pin`),

    unpin: (id: string) => client.delete(`${path(id)}/pin`),

    listPinned: () => client.get("/templates/pinned"),
  };
}

/** Build a full PNG URL that can be passed to Charity or an img tag. */
export function pngUrl(client: BackendClient, id: string, layer = 0): string {
  return buildTemplatesApi(client).png(id, layer);
}

/** Build a preview URL. */
export function previewUrl(client: BackendClient, id: string, size: 64 | 128 | 256 = 128, layer = 0): string {
  return buildTemplatesApi(client).preview(id, size, layer);
}

/** Build an animated-GIF URL (still-PNG fallback for static layers). */
export function animatedUrl(client: BackendClient, id: string, layer = 0, size?: number): string {
  return buildTemplatesApi(client).animated(id, layer, size);
}
