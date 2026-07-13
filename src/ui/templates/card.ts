/** Template card renderer for the Browse grid. Pure HTML-string render. */
import { badge } from "../kit/primitives";
import { esc } from "../../helpers";
import { previewUrl, type Chip, type TplSummary } from "./api";

const SCOPE_LABEL: Record<string, string> = { public: "PUBLIC", clan: "CLAN", private: "PRIVATE" };
const SCOPE_KIND: Record<string, "owner" | "admin" | "mod" | "member"> = {
  public: "mod",
  clan: "owner",
  private: "member",
};

/**
 * Card badges (unit-tested). Type-first, not approval-first: every card shows
 * STATIC/ANIMATED and its bundle size. In the `all` chip an origin badge tells
 * the user which scope the template came from (Public/Clan/Private).
 */
export function cardBadges(t: TplSummary, chip: Chip = "public"): string {
  const type = t.animated ? badge("🎞 ANIM", "admin") : badge("🖼 STATIC", "member");
  const bundle = (t.templateCount ?? 1) > 1 ? badge(`🧩 ${t.templateCount}`, "member") : "";
  const origin = chip === "all" ? badge(SCOPE_LABEL[t.scope] ?? t.scope.toUpperCase(), SCOPE_KIND[t.scope] ?? "member") : "";
  return type + bundle + origin;
}

/** A single template card. `data-open` carries the id for click delegation. */
export function templateCard(t: TplSummary, chip: Chip = "public"): string {
  const src = previewUrl(t.id, 128);
  return `<button class="wd-tplcard" data-open="${esc(t.id)}" title="${esc(t.name)}">
    <img class="wd-tplcard-img" src="${esc(src)}" loading="lazy" onerror="this.style.opacity=.2">
    <div class="wd-tplcard-name">${esc(t.name)}</div>
    <div class="wd-tplcard-badges">${cardBadges(t, chip)}</div>
  </button>`;
}
