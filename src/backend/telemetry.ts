import { BackendClient } from "./client";
import { TelemetryEvent, TelemetryLogEntry } from "./types";

export interface TelemetryBatch {
  events?: TelemetryEvent[];
  logs?: TelemetryLogEntry[];
}

export interface HealthCheck {
  status: "ok" | "degraded" | "down";
  version?: string;
  timestamp: string;
}

export function buildTelemetryApi(client: BackendClient) {
  return {
    /** Submit telemetry events. */
    events: (events: TelemetryEvent[]) =>
      client.post("/telemetry/events", { events }),

    /** Upload structured logs. */
    logs: (logs: TelemetryLogEntry[]) => client.post("/telemetry/logs", { logs }),

    /** Query recent server logs (admin). */
    queryLogs: (params?: { level?: string; limit?: number; since?: string }) => client.get("/telemetry/logs", params),

    /** Export logs as JSON (admin). */
    exportLogs: (params?: { since?: string; level?: string }) => client.get("/telemetry/logs/export", params),

    /** Health check. */
    health: () => client.get<HealthCheck>("/telemetry/health"),

    /** Metrics (admin). */
    metrics: () => client.get("/telemetry/metrics"),

    /**
     * Submit events and logs together. There is no single V3 batch route, so
     * this fans out to /telemetry/events and /telemetry/logs.
     */
    batch: async (body: TelemetryBatch) => {
      if (body.events?.length) await client.post("/telemetry/events", { events: body.events });
      if (body.logs?.length) await client.post("/telemetry/logs", { logs: body.logs });
    },
  };
}
