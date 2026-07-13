import { BackendClient, isBackendError, safeCall, toBackendError } from "./client";
import { BackendUser } from "./types";

export interface LoggerContext {
  [key: string]: unknown;
}

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: LoggerContext;
  timestamp: string;
}

export interface BatchLoggerOptions {
  client?: BackendClient;
  /** Max lines to keep in memory before forcing a flush. */
  maxBuffer?: number;
  /** Flush interval in milliseconds. */
  flushIntervalMs?: number;
  /** Minimum level to keep/send. */
  level?: "debug" | "info" | "warn" | "error";
  /** When true, also echo logs to console. */
  echo?: boolean;
}

const LEVEL_RANK: Record<LogLine["level"], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class BatchLogger {
  private client?: BackendClient;
  private buffer: LogLine[] = [];
  private maxBuffer: number;
  private flushIntervalMs: number;
  private minLevel: LogLine["level"];
  private echo: boolean;
  private timer?: number;

  constructor(opts: BatchLoggerOptions = {}) {
    this.client = opts.client;
    this.maxBuffer = opts.maxBuffer ?? 50;
    this.flushIntervalMs = opts.flushIntervalMs ?? 30_000;
    this.minLevel = opts.level ?? "info";
    this.echo = opts.echo ?? false;
    // Guard `window` so this module is import-safe outside a browser (unit
    // tests, SSR). In the extension `window` always exists.
    if (this.flushIntervalMs > 0 && typeof window !== "undefined") {
      this.timer = window.setInterval(() => this.flush(), this.flushIntervalMs);
    }
  }

  setClient(client: BackendClient | undefined): void {
    this.client = client;
  }

  private shouldLog(level: LogLine["level"]): boolean {
    return LEVEL_RANK[level] >= LEVEL_RANK[this.minLevel];
  }

  private push(level: LogLine["level"], message: string, context?: LoggerContext): void {
    if (!this.shouldLog(level)) return;
    const line: LogLine = {
      level,
      message,
      context,
      timestamp: new Date().toISOString(),
    };
    this.buffer.push(line);
    if (this.echo) {
      const args = context ? [message, context] : [message];
      if (level === "error") console.error(...args);
      else if (level === "warn") console.warn(...args);
      else console.log(...args);
    }
    if (this.buffer.length >= this.maxBuffer) {
      this.flush();
    }
  }

  debug(message: string, context?: LoggerContext): void {
    this.push("debug", message, context);
  }

  info(message: string, context?: LoggerContext): void {
    this.push("info", message, context);
  }

  warn(message: string, context?: LoggerContext): void {
    this.push("warn", message, context);
  }

  error(message: string, context?: LoggerContext): void {
    this.push("error", message, context);
  }

  logError(err: unknown, context?: LoggerContext): void {
    const be = toBackendError(err);
    this.push("error", be.message, {
      ...context,
      status: be.status,
      path: be.path,
      backendId: be.backendId,
    });
  }

  async flush(): Promise<void> {
    if (!this.client?.on || this.buffer.length === 0) return;
    const batch = this.buffer.splice(0);
    const result = await safeCall(() => this.client!.post("/telemetry/logs", { logs: batch }),
    );
    if (!result.ok) {
      // Put failed logs back at the front, capped to avoid unbounded growth.
      this.buffer.unshift(...batch.slice(-this.maxBuffer));
    }
  }

  destroy(): void {
    if (this.timer) {
      window.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }
}

export const logger = new BatchLogger({ echo: true });

/** Attach global error + promise rejection logging. */
export function enableGlobalErrorLogging(userGetter?: () => BackendUser | undefined): void {
  window.addEventListener("error", (e) => {
    logger.error("window.error", {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
      userId: userGetter?.()?.id,
    });
  });
  window.addEventListener("unhandledrejection", (e) => {
    logger.error("unhandledrejection", {
      reason: String(e.reason),
      userId: userGetter?.()?.id,
    });
  });
}

export { isBackendError, safeCall, toBackendError };
