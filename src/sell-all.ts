/**
 * "Sell spray cans" — explicit, user-confirmed convenience action.
 *
 * What the site does:
 *   The site's coin modal has a "Sell Spray Can" button that converts ONE
 *   spray can (the current partial one, then the next full ones in
 *   implementation order) into coins. Each click sends:
 *
 *     POST https://filianislost.com/cursor/buyCoins
 *
 *   with the auth-token from localStorage as the `Authorization` header.
 *   Selling many cans means clicking the button many times.
 *
 * What we expose:
 *   • runSellAll()              — sell every can the user owns (partial included)
 *   • runSellAmount(n)          — sell exactly N cans, capped at what's available
 *   • runSellPrompt()           — dialog with a number field, default = "all"
 *
 *   All three reuse the same loop: refuse while drawing, fire one POST per
 *   can with SELL_CAN_SPACING_MS gap, surface progress as toasts, return a
 *   SellAllResult summary.
 *
 * Fair-play boundary:
 *   This is the only paint-related write the extension can perform, and it
 *   only runs after explicit user confirmation. We never auto-loop without
 *   the user's consent, and we never bypass the "no selling while drawing"
 *   guard. The endpoint we hit is the same one the site itself uses — no
 *   private API, no WebSocket injection.
 *
 * Public API:
 *   runSellAll()    → Promise<SellAllResult>
 *   runSellAmount() → Promise<SellAllResult>
 *   runSellPrompt() → Promise<SellAllResult>
 */
import { siteToken } from "./site-api";
import { log } from "./log";
import { getPaintInfo } from "./paint-state";
import { confirmDlg, errorDlg, infoDlg, promptDlg } from "./dialog";
import { t, pluralize } from "./i18n";
import { toast } from "./notify";
import {
  PAINT_PER_CAN,
  PAINT_PER_COIN,
  SELL_CAN_SPACING_MS,
  SELL_CAN_URL,
} from "./constants";

/** Format an integer with thin-space thousands separators. Some long-time
 *  users have 100+ cans (10 000+ px), and bare digit strings get hard to
 *  read at that scale. We use a narrow no-break space so the digits stay
 *  on one line. */
function fmtN(n: number): string {
  return Math.floor(n).toLocaleString("en-US").replace(/,/g, " ");
}

/** Heuristic check for "user is currently drawing". On dev-mode pages we can
 *  read `localPaintIncrement` directly; on production we approximate by
 *  looking for the site's `.confirm-draw-btn` (only visible while drawing). */
function isBusyDrawing(): boolean {
  const p: any = (window as any).player;
  if (p) {
    if (typeof p.localPaintIncrement === "number" && p.localPaintIncrement !== 0) {
      return true;
    }
  }
  const confirmBtn = document.querySelector(".confirm-draw-btn");
  return !!confirmBtn;
}

export type SellAllResult = {
  sold: number;
  failed: boolean;
  reason?: string;
};

/** Fire exactly one buyCoins POST. Returns the parsed JSON body when present
 *  so a future caller could surface the per-can coin payout, but we don't
 *  rely on the shape — the site is authoritative. */
async function sellOne(): Promise<{ ok: boolean; status: number; body?: any }> {
  const tok = siteToken();
  if (!tok) return { ok: false, status: 401 };
  try {
    const r = await fetch(SELL_CAN_URL, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Authorization: tok,
      },
      body: "{}",
    });
    let body: any = null;
    try { body = await r.json(); } catch { /* may be empty */ }
    return { ok: r.ok, status: r.status, body };
  } catch (e: any) {
    log.err("SELL", e?.message || String(e));
    return { ok: false, status: 0 };
  }
}

/**
 * Run a confirmed sell loop for `cans` spray cans. Skips the busy-drawing
 * and nothing-to-sell branches if either applies. Returns a SellAllResult
 * summary the caller can display.
 */
async function runSellLoop(cans: number): Promise<SellAllResult> {
  if (isBusyDrawing()) {
    log.warn("SELL", "refused — user is drawing");
    errorDlg(t("sellAllBusy"));
    return { sold: 0, failed: true, reason: "busy" };
  }
  if (cans <= 0) {
    log.info("SELL", "nothing to sell (count=0)");
    infoDlg(t("sellAllNothing"));
    return { sold: 0, failed: false };
  }
  const info = getPaintInfo();
  // totalCans is the canonical can count from paint-state; same value the
  // Profile / Settings displays show. Using anything else here is what
  // caused the historical "display says 2 cans but sell says 10" bug.
  const available = info.totalCans;
  if (cans > available) {
    log.warn("SELL", `clamped ${cans} → ${available} (available cans)`);
    cans = available;
  }
  // Approximate coin payout: every PAINT_PER_COIN px is one coin. The server
  // is authoritative on the final number.
  const approxPx = Math.min(info.px, cans * PAINT_PER_CAN);
  const approxCoins = Math.floor(approxPx / PAINT_PER_COIN);
  const cansLabel = pluralize(cans, "paintCan");
  log.info("SELL", `prompting for ${cans} cans (~${approxCoins} coins)`);
  const ok = await confirmDlg(
    t("sellAllConfirm", {
      cans: fmtN(cans),
      cansLabel,
      coins: fmtN(approxCoins),
    }),
  );
  if (!ok) {
    log.info("SELL", "user cancelled");
    return { sold: 0, failed: false };
  }

  let sold = 0;
  for (let i = 0; i < cans; i++) {
    log.trace("SELL", `selling ${i + 1}/${cans}`);
    const res = await sellOne();
    if (!res.ok) {
      const reason = res.status ? `HTTP ${res.status}` : "network";
      log.warn("SELL", `failed at ${i + 1}/${cans}: ${reason}`);
      toast(t("sellAllTitle"), t("sellAllFailed", { at: i + 1, err: reason }));
      return { sold, failed: true, reason };
    }
    sold += 1;
    // Show progress only every 5 cans (or final) so large 100+ runs don't
    // flood the toast stack.
    if (sold === cans || sold % 5 === 0) {
      toast(
        t("sellAllTitle"),
        t("sellAllInProgress", { done: fmtN(sold), total: fmtN(cans) }),
      );
    }
    await new Promise((r) => setTimeout(r, SELL_CAN_SPACING_MS));
  }
  log.ok("SELL", `sold ${sold} can(s)`);
  toast(t("sellAllTitle"), t("sellAllDone", { sold: fmtN(sold) }));
  return { sold, failed: false };
}

/** Sell every spray can the user owns, partial included. */
export async function runSellAll(): Promise<SellAllResult> {
  log.info("SELL", "runSellAll() invoked");
  return runSellLoop(getPaintInfo().totalCans);
}

/** Sell exactly `amount` cans, capped at available. */
export async function runSellAmount(amount: number): Promise<SellAllResult> {
  log.info("SELL", `runSellAmount(${amount}) invoked`);
  return runSellLoop(Math.max(0, Math.floor(amount)));
}

/**
 * Prompt the user for a number (defaults to "all"). Accepts the literal
 * string "all" / "max" / "*" or a positive integer. Returns the loop result
 * after the user confirms.
 */
export async function runSellPrompt(): Promise<SellAllResult> {
  const info = getPaintInfo();
  const available = info.totalCans;
  if (available <= 0) {
    infoDlg(t("sellAllNothing"));
    return { sold: 0, failed: false };
  }
  const cansLabel = pluralize(available, "paintCan");
  const raw = await promptDlg(
    t("sellPromptBody", { available: fmtN(available), cansLabel }),
    String(available),
    t("sellPromptTitle"),
  );
  if (raw == null) {
    log.info("SELL", "prompt cancelled");
    return { sold: 0, failed: false };
  }
  const trimmed = String(raw).trim().toLowerCase();
  let amount: number;
  if (trimmed === "all" || trimmed === "max" || trimmed === "*" || trimmed === "") {
    amount = available;
  } else {
    amount = parseInt(trimmed, 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      errorDlg(t("sellPromptInvalid", { raw: trimmed }));
      return { sold: 0, failed: true, reason: "invalid input" };
    }
  }
  return runSellLoop(amount);
}
