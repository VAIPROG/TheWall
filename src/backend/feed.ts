import { BackendClient } from "./client";
import { FeedEvent, FeedMedia } from "./types";

export interface FeedQuery {
  eventType?: string;
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  after?: string;
}

export interface CreateFeedBody {
  eventType: string;
  source?: string;
  externalId: string;
  title?: string;
  description?: string;
  payload?: Record<string, unknown>;
  media?: FeedMedia[];
  occurredAt?: string;
}

export interface FeedNoteBody {
  lang: string;
  note: string;
}

export function buildFeedApi(client: BackendClient) {
  const eventPath = (id: string) => `/feed/${encodeURIComponent(id)}`;

  return {
    /** List feed events. Public endpoint. */
    list: (query?: FeedQuery) => client.get<FeedEvent[]>("/feed", query as Record<string, unknown>),

    /** Get a single feed event. */
    get: (id: string) => client.get<FeedEvent>(eventPath(id)),

    /** Get per-language notes for an event. */
    notes: (id: string) => client.get<Record<string, string>>(`${eventPath(id)}/notes`),

    /** Legacy V2 snapshot compatibility. TODO(v3): superseded by feed events. */
    snapshots: (params?: { size?: string; limit?: number }) => client.getRoot("/v2/snapshots", params),

    /** Legacy V2 signal compatibility. TODO(v3): superseded by feed events. */
    signals: (params?: { limit?: number; since?: string }) => client.getRoot("/v2/signals", params),

    // Admin -------------------------------------------------------------
    create: (body: CreateFeedBody) => client.post<FeedEvent>("/admin/feed", body),

    upsertNote: (id: string, body: FeedNoteBody) =>
      client.post(`${eventPath(id)}/notes`, body),

    deleteNote: (id: string, lang: string) =>
      client.delete(`${eventPath(id)}/notes/${encodeURIComponent(lang)}`),
  };
}
