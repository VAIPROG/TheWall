import { $ } from "../helpers";
import { t, pluralize } from "../i18n";
import { getPaintInfo } from "../paint-state";
import { fetchCoinBalance } from "../site-api";
import { runSellAll, runSellPrompt } from "../sell-all";

export function updatePaintCurrent(): void {
  const el = $("paint-current");
  if (!el) return;
  const info = getPaintInfo();
  if (info.px <= 0) {
    el.textContent = t("paintCurrentNone");
    return;
  }
  const cans = info.totalCans;
  const cansLabel = pluralize(cans, "paintCan");
  el.textContent = t("paintCurrentLine", { px: info.px, cans, cansLabel });
}

export function updateProfilePaintLine(): void {
  const el = $("profile-paint");
  if (!el) return;
  const info = getPaintInfo();
  if (info.px <= 0) {
    el.textContent = t("profilePaintEmpty");
    return;
  }
  const cans = info.totalCans;
  const cansLabel = pluralize(cans, "paintCan");
  el.textContent = t("profilePaintAmount", { px: info.px, cans, cansLabel });
}

export async function updateProfileBalance(): Promise<void> {
  const el = $("profile-coins");
  if (!el) return;
  const coins = await fetchCoinBalance();
  if (coins === null) {
    el.textContent = t("profileCoinsUnknown");
    return;
  }
  el.textContent = t("profileCoinsAmount", { coins: Math.floor(coins) });
}

export function wireSellButton(
  id: string,
  mode: "all" | "prompt",
  refresh: () => void,
): void {
  $(id)?.addEventListener("click", async () => {
    const btn = $(id) as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      if (mode === "all") await runSellAll();
      else await runSellPrompt();
      refresh();
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}
