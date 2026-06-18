/**
 * Paint state observer + "empty→refilled" notification queue.
 *
 * Watches the site's `.paint-bar` and fires CustomEvents whenever the value
 * changes. Other parts of the extension subscribe to the events:
 *
 *   wd:paint-changed         every meaningful tick (px / partial / extraCans)
 *   wd:paint-empty           edge: paint just hit zero
 *   wd:paint-refilled        edge: paint just went from zero to positive
 *
 * State machine (the "queue" pattern the user asked for):
 *
 *   When paint drops to zero we set an `awaitingRefill` flag and remember
 *   the timestamp in localStorage. The flag stays set until we see paint
 *   become positive again — at that exact moment we fire `wd:paint-refilled`
 *   with `detail.awayMs = now - awaitingSince` and clear the flag. The flag
 *   survives reloads and tab close, so:
 *
 *     - The user runs out of paint, closes the tab.
 *     - The site refills offline.
 *     - The user returns hours later → the very first tick after boot
 *       sees `awaitingRefill && px > 0` and fires the refilled event with
 *       the away duration, letting the listener pick a "while you were
 *       away" message variant.
 *
 * Bootstrap rule:
 *   The first time we read the DOM after page load we DO NOT fire any
 *   transition event. The previous version had `lastInfo` starting at
 *   `{px: 0}`, which caused the very first tick to compare `0 → N` and
 *   fire a spurious refill event whenever you opened the site with paint
 *   in the bank. We now run a baseline tick that sets `lastInfo` and the
 *   `initialized` flag, and only THEN we start emitting events.
 *
 * Why DOM-based?
 *   The site's player state lives in a closure-scoped object named `R`,
 *   exposed as `window.player` only in dev builds. Production users can't
 *   reach it. The DOM, however, always has:
 *
 *     <div class="paint-bar"
 *          style="--paint-remaining: 47%"
 *          data-tooltip="Paint Remaining: 47% (47px)">
 *     <span class="spray-can-count">+3</span>
 *
 *   The CSS variable gives the partial fraction; the tooltip gives the
 *   exact pixel count of the partial can; and `.spray-can-count` gives how
 *   many additional full cans are stockpiled. Total px is therefore:
 *
 *     px = extraCans * PAINT_PER_CAN + partial
 *
 * Public API:
 *   startPaintWatch()      kick off the observer; safe to call repeatedly
 *   stopPaintWatch()       teardown for tests
 *   getPaintInfo()         synchronous snapshot of current state
 *
 * NOTE on fair-play: this module is strictly *read-only*. It never paints,
 * never injects pixels, and never touches the WebSocket.
 */
import { log } from "./log";
import {
  PAINT_PER_CAN,
  PAINT_POLL_INTERVAL_MS,
  SEL,
} from "./constants";

/** Snapshot returned by getPaintInfo(). All count fields are derived from
 *  `px` via deriveCanFields() so display and sell paths never disagree. */
export type PaintInfo = {
  /** Total paint in px. Canonical source of truth — all other fields derive
   *  from this. */
  px: number;
  /** Total spray cans: `Math.ceil(px / PAINT_PER_CAN)`, or 0 if px=0.
   *  Use this everywhere (display, sell-all confirm, sell prompt). */
  totalCans: number;
  /** Full extra spray cans beyond the current one: `max(0, totalCans - 1)`.
   *  Kept for callers that talk about "extra" cans specifically (e.g.
   *  matching the site's "+N" badge). */
  extraCans: number;
  /** Pixels in the current spray can. Range 0..PAINT_PER_CAN. Equals
   *  `px - extraCans*PAINT_PER_CAN` so adding the parts back gives `px`. */
  partial: number;
  /** Epoch-ms when paint next refills, or 0 if unknown / not waiting. */
  nextRefill: number;
};

/** Derive cans/partial from a px count. Single source of truth — both the
 *  player-state path and the DOM path call this. */
function deriveCanFields(px: number): Pick<PaintInfo, "totalCans" | "extraCans" | "partial"> {
  if (px <= 0) return { totalCans: 0, extraCans: 0, partial: 0 };
  const totalCans = Math.ceil(px / PAINT_PER_CAN);
  const extraCans = totalCans - 1;
  const partial = px - extraCans * PAINT_PER_CAN;
  return { totalCans, extraCans, partial };
}

export type PaintRefillDetail = PaintInfo & {
  /** Milliseconds spent in the "empty" state before this refill. 0 if we
   *  weren't tracking an empty period (e.g. paint was gifted while you
   *  still had ink, or the previous run didn't see the 0-transition). */
  awayMs: number;
};

const QUEUE_KEY = "wd_paint_queue_v1";

type QueueEntry = {
  awaitingRefill: boolean;
  awaitingSince: number;
};

function readQueue(): QueueEntry {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return { awaitingRefill: false, awaitingSince: 0 };
    const q = JSON.parse(raw);
    if (typeof q?.awaitingRefill !== "boolean") {
      return { awaitingRefill: false, awaitingSince: 0 };
    }
    return {
      awaitingRefill: !!q.awaitingRefill,
      awaitingSince: typeof q.awaitingSince === "number" ? q.awaitingSince : 0,
    };
  } catch {
    return { awaitingRefill: false, awaitingSince: 0 };
  }
}

/**
 * Persisted "last seen" snapshot so we can detect refills that happened
 * across browser restarts. The original `awaitingRefill` queue requires us
 * to have OBSERVED the empty transition — if the user closes the browser
 * before paint hits zero, we never set the flag, and the refilled event
 * never fires on the next launch. Tracking lastSeen lets us infer the
 * refill from cold by comparing the snapshot to the just-read DOM value.
 *
 * `lastSeenPx`/`lastSeenAt` get written on every meaningful tick — light
 * (one localStorage.setItem per real change) and easy to reason about.
 */
const SEEN_KEY = "wd_paint_seen_v1";

/** Heuristic threshold for "the paint moved up enough that something must
 *  have refilled it" when comparing a cold-start reading to the last
 *  persisted snapshot. One can = PAINT_PER_CAN (1000) px in the live game;
 *  half a can is plenty to dismiss noise from observer races. */
const COLD_REFILL_DELTA_PX = PAINT_PER_CAN / 2;

/** Minimum gap between snapshot and cold-start tick to count as "away".
 *  Anything shorter is just the same session reloading and we don't want
 *  to fire spurious refilled toasts for that. */
const COLD_REFILL_MIN_AWAY_MS = 60_000;

interface LastSeen {
  px: number;
  at: number;
}

function readLastSeen(): LastSeen | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (typeof j?.px !== "number" || typeof j?.at !== "number") return null;
    return { px: j.px, at: j.at };
  } catch {
    return null;
  }
}

function writeLastSeen(px: number): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ px, at: Date.now() }));
  } catch { /* quota — ignore */ }
}

function writeQueue(q: QueueEntry): void {
  try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch {}
}

let lastInfo: PaintInfo = { px: 0, totalCans: 0, extraCans: 0, partial: 0, nextRefill: 0 };
let initialized = false;
let started = false;
let pollTimer: number | null = null;
let attrObserver: MutationObserver | null = null;
let queue: QueueEntry = { awaitingRefill: false, awaitingSince: 0 };

/** Parse "Paint Remaining: 47% (47px)" → 47. */
function parseTooltipPx(tooltip: string | null | undefined): number | null {
  if (!tooltip) return null;
  const m = /\((\d+)\s*px\)/.exec(tooltip);
  if (!m) return null;
  return Number(m[1]);
}

/** Parse "+3" → 3. */
function parseExtraCans(span: Element | null): number {
  if (!span) return 0;
  const txt = (span.textContent || "").trim();
  const m = /([+-]?\d+)/.exec(txt);
  return m ? Number(m[1]) : 0;
}

/** Parse "Next refill in: 1m 23s" timer text into a future epoch-ms. */
function parseNextRefillFromTimer(): number {
  const b = document.querySelector(SEL.paintTimer);
  if (!b) return 0;
  const txt = (b.textContent || "").trim();
  let totalMs = 0;
  const re = /(\d+)\s*([dhms])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(txt))) {
    const v = Number(m[1]);
    switch (m[2]) {
      case "d": totalMs += v * 86400 * 1000; break;
      case "h": totalMs += v * 3600 * 1000; break;
      case "m": totalMs += v * 60 * 1000; break;
      case "s": totalMs += v * 1000; break;
    }
  }
  return totalMs > 0 ? Date.now() + totalMs : 0;
}

function readPlayerState(): PaintInfo | null {
  const p = (window as any).player;
  if (p && typeof p.paintRemaining === "number") {
    const px = Math.max(0, p.paintRemaining as number);
    return {
      px,
      ...deriveCanFields(px),
      nextRefill: p.nextRefill || 0,
    };
  }
  return null;
}

function readDomState(): PaintInfo | null {
  const bar = document.querySelector(SEL.paintBar);
  if (!bar) return null;
  const tooltipPx = parseTooltipPx(bar.getAttribute("data-tooltip"));
  if (tooltipPx === null) return null;
  const extraCansSpan = document.querySelector(SEL.sprayCanCount);
  const domExtras = parseExtraCans(extraCansSpan);
  // The site computes Q = paintRemaining - 1, then shows:
  //   spray-can-count = Math.floor(Q / F0)   ("+N")
  //   tooltip "(Mpx)" = Q % F0
  // So `domExtras * F0 + tooltipPx = paintRemaining - 1`. We add 1 back so the
  // total px we report matches what the player object would say — and so
  // Math.ceil(px / F0) returns the visible can count.
  //
  // Edge case: when paintRemaining == 0 the site also shows "0px / +0", and
  // there's no way to distinguish 0 from 1 from the DOM alone. We detect the
  // "Out of paint" state by the refill timer being visible; if so, force 0.
  const rawCount = domExtras * PAINT_PER_CAN + tooltipPx;
  const timerVisible = !!document.querySelector(SEL.paintTimer);
  const px = rawCount === 0 && timerVisible ? 0 : rawCount + 1;
  return {
    px,
    ...deriveCanFields(px),
    nextRefill: parseNextRefillFromTimer(),
  };
}

export function getPaintInfo(): PaintInfo {
  const fresh = readPlayerState() || readDomState();
  return fresh || lastInfo;
}

function fireChanged(prev: PaintInfo, next: PaintInfo): void {
  document.dispatchEvent(
    new CustomEvent("wd:paint-changed", { detail: { prev, next } }),
  );
}

function fireEmpty(info: PaintInfo): void {
  document.dispatchEvent(
    new CustomEvent("wd:paint-empty", { detail: info }),
  );
  log.ok("PAINT", "empty — queue refill notification");
}

function fireRefilled(info: PaintInfo, awayMs: number): void {
  const detail: PaintRefillDetail = { ...info, awayMs };
  document.dispatchEvent(
    new CustomEvent("wd:paint-refilled", { detail }),
  );
  log.ok(
    "PAINT",
    `refilled: ${info.px}px (${info.totalCans} cans, awayMs=${awayMs})`,
  );
}

/** Called on every observed transition AFTER the bootstrap tick. */
function processTransition(prev: PaintInfo, next: PaintInfo): void {
  // Edge: just went empty.
  if (prev.px > 0 && next.px === 0) {
    if (!queue.awaitingRefill) {
      queue = { awaitingRefill: true, awaitingSince: Date.now() };
      writeQueue(queue);
      fireEmpty(next);
    }
    return;
  }
  // Edge: just refilled.
  if (prev.px === 0 && next.px > 0 && queue.awaitingRefill) {
    const awayMs = Date.now() - queue.awaitingSince;
    queue = { awaitingRefill: false, awaitingSince: 0 };
    writeQueue(queue);
    fireRefilled(next, awayMs);
  }
}

function tick(): void {
  const next = readPlayerState() || readDomState();
  if (!next) return;

  // Bootstrap: first real reading sets baseline silently. No transitions
  // fire. This is what fixes the "spurious refilled at boot" bug — without
  // it, opening the site with paint in the bank looked like a 0→N edge.
  if (!initialized) {
    lastInfo = next;
    initialized = true;
    log.info("PAINT", `baseline: ${next.px}px (extra ${next.extraCans})`);

    // Two cold-start refill paths — we take whichever fires first.
    //
    // Path A — explicit queue: the last live session observed paint go
    // to zero and persisted `awaitingRefill = true`. If we now see a
    // positive value, the refill landed while the tab was closed.
    if (queue.awaitingRefill && next.px > 0) {
      const awayMs = Date.now() - queue.awaitingSince;
      queue = { awaitingRefill: false, awaitingSince: 0 };
      writeQueue(queue);
      writeLastSeen(next.px);
      setTimeout(() => fireRefilled(next, awayMs), 0);
      return;
    }

    // Path B — inferred from snapshot: the user may have closed the
    // browser while paint was still positive but draining. They come
    // back later and it's noticeably higher than what we last persisted.
    // That's a cold refill we couldn't catch via path A. Threshold cuts:
    //   - jump must be ≥ COLD_REFILL_DELTA_PX (one half-can or better)
    //   - at least COLD_REFILL_MIN_AWAY_MS gap since the snapshot, so
    //     we don't confuse same-session reloads with real refills.
    const seen = readLastSeen();
    if (seen && next.px > seen.px + COLD_REFILL_DELTA_PX) {
      const awayMs = Date.now() - seen.at;
      if (awayMs >= COLD_REFILL_MIN_AWAY_MS) {
        log.info(
          "PAINT",
          `cold-start refill inferred: ${seen.px}→${next.px} after ${awayMs}ms`,
        );
        writeLastSeen(next.px);
        setTimeout(() => fireRefilled(next, awayMs), 0);
        return;
      }
    }

    // No refill to surface — just record the baseline for next time.
    writeLastSeen(next.px);
    // If we were waiting and we're still empty — keep waiting.
    return;
  }

  const prev = lastInfo;
  const changed =
    prev.px !== next.px ||
    prev.extraCans !== next.extraCans ||
    prev.partial !== next.partial;

  if (changed) {
    log.trace(
      "PAINT",
      `tick px ${prev.px}→${next.px} (extra ${prev.extraCans}→${next.extraCans})`,
    );
    lastInfo = next;
    // Persist the new snapshot every time the meaningful state changes,
    // so the cold-start path on the next boot has fresh data to compare
    // against. One localStorage write per real paint event is cheap.
    writeLastSeen(next.px);
    fireChanged(prev, next);
    processTransition(prev, next);
  } else {
    lastInfo = next;
  }
}

function attachAttrObserver(bar: Element): void {
  if (attrObserver) return;
  attrObserver = new MutationObserver(() => tick());
  attrObserver.observe(bar, {
    attributes: true,
    attributeFilter: ["style", "data-tooltip"],
  });
  const can = document.querySelector(SEL.sprayCanCount);
  if (can) attrObserver.observe(can, { childList: true, characterData: true, subtree: true });
  log.ok("PAINT", "attribute observer attached to .paint-bar");
}

/** Begin watching the paint bar. Idempotent. */
export function startPaintWatch(): void {
  if (started) return;
  started = true;
  queue = readQueue();
  log.info("PAINT", `startPaintWatch() — awaiting=${queue.awaitingRefill}`);

  const boot = (): void => {
    const bar = document.querySelector(SEL.paintBar);
    if (bar) {
      attachAttrObserver(bar);
      tick();
    }
  };
  boot();

  pollTimer = window.setInterval(() => {
    if (!attrObserver) boot();
    tick();
  }, PAINT_POLL_INTERVAL_MS);
}

/** Stop the observer + poll. Intended for tests / hot-reload teardown. */
export function stopPaintWatch(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  attrObserver?.disconnect();
  attrObserver = null;
  started = false;
  initialized = false;
  log.info("PAINT", "stopPaintWatch()");
}

export { PAINT_PER_CAN };
