/**
 * Tiny structured logger with a DOS-prompt aesthetic. Used everywhere in the
 * extension so console output is consistent and grep-friendly.
 *
 * Levels:
 *   TRACE  fine-grained timing / per-event ticks (very chatty, debug only)
 *   DEBUG  developer diagnostics: arguments, intermediate values
 *   INFO   normal operational events ("button clicked", "fetched N items")
 *   OK     success / completion of a non-trivial action
 *   WARN   recoverable issue worth noticing
 *   ERR    failure (caller is generally expected to recover or surface)
 *   FAIL   alias of ERR, kept for legacy call sites
 *
 * Usage:
 *   log("MAIL", "INFO", `loading kind="${kind}"`);
 *   log.info ("MAIL", `loading kind="${kind}"`);   // shorthand
 *   log.warn ("EMOTE", "channel fetch failed: " + e);
 *   log.err  ("PROGRESS", "canvas read blocked", { x, y, err: e });
 *   log.debug("OVERLAY", "applyOverlayScale called with cfg", cfg);
 *
 * The shorthand methods accept an optional `extra` payload which will be
 * console.dir'd on a follow-up line — handy for surfacing structured state
 * without stringifying it manually.
 *
 * To control verbosity at runtime, set localStorage.WALLDEV_LOG_LEVEL to one
 * of TRACE/DEBUG/INFO/OK/WARN/ERR (default INFO). Anything below the level
 * is suppressed.
 */

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "OK" | "WARN" | "ERR" | "FAIL";

const LEVEL_RANK: Record<LogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO:  2,
  OK:    3,
  WARN:  4,
  ERR:   5,
  FAIL:  5,
};

function activeLevel(): number {
  try {
    const raw = localStorage.getItem("WALLDEV_LOG_LEVEL");
    if (!raw) return LEVEL_RANK.INFO;
    const k = raw.toUpperCase() as LogLevel;
    return LEVEL_RANK[k] ?? LEVEL_RANK.INFO;
  } catch { return LEVEL_RANK.INFO; }
}

const STYLE = {
  prompt: "color:#5577ff;font-weight:bold;",
  path:   "color:#888;",
  cmd:    "color:#ddd;",
  reset:  "color:inherit;",
  TRACE:  "color:#888;font-style:italic;",
  DEBUG:  "color:#3a9;",
  INFO:   "color:#7af;",
  OK:     "color:#3a3;font-weight:bold;",
  WARN:   "color:#fb3;font-weight:bold;",
  ERR:    "color:#f55;font-weight:bold;",
  FAIL:   "color:#f55;font-weight:bold;",
} as const;

function emit(level: LogLevel, action: string, details: string, extra?: unknown): void {
  if ((LEVEL_RANK[level] ?? LEVEL_RANK.INFO) < activeLevel()) return;

  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const styleForLevel = STYLE[level] || STYLE.OK;

  console.log(
    `%cC:\\WALLDEV>%c ${ts} %c${action.padEnd(18)}%c ${level.padEnd(5)}%c ${details}`,
    STYLE.prompt,
    STYLE.path,
    STYLE.cmd,
    styleForLevel,
    STYLE.reset,
  );
  if (extra !== undefined) {
    // console.dir gives clean expandable output; better than concat-stringify.
    // eslint-disable-next-line no-console
    console.dir(extra);
  }
}

/** Legacy three-arg form. New code should prefer the shorthand helpers below. */
export function log(action: string, status: LogLevel | string = "OK", details = ""): void {
  const lvl = (status.toString().toUpperCase() as LogLevel);
  const safe: LogLevel = (LEVEL_RANK[lvl] !== undefined ? lvl : "INFO") as LogLevel;
  emit(safe, action, details);
}

log.trace = (action: string, details: string, extra?: unknown) => emit("TRACE", action, details, extra);
log.debug = (action: string, details: string, extra?: unknown) => emit("DEBUG", action, details, extra);
log.info  = (action: string, details: string, extra?: unknown) => emit("INFO",  action, details, extra);
log.ok    = (action: string, details: string, extra?: unknown) => emit("OK",    action, details, extra);
log.warn  = (action: string, details: string, extra?: unknown) => emit("WARN",  action, details, extra);
log.err   = (action: string, details: string, extra?: unknown) => emit("ERR",   action, details, extra);

/** Toggle the level at runtime: `wd_log_level("DEBUG")` in console. */
(globalThis as any).wd_log_level = (lvl: string) => {
  try { localStorage.setItem("WALLDEV_LOG_LEVEL", lvl.toUpperCase()); } catch {}
  emit("INFO", "LOG_LEVEL", `set to ${lvl.toUpperCase()}`);
};
