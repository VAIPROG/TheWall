/** Template card renderer for the Browse grid. Pure HTML-string render. */
import { badge } from "../kit/primitives";
import { esc } from "../../helpers";
import { previewUrl, type TplSummary } from "./api";

/** Bundle + verification badges for a summary (unit-tested). */
export function cardBadges(t: TplSummary): string {
  const bundle = (t.templateCount ?? 1) > 1 ? badge(`🧩 ${t.templateCount}`, "member") : "";
  const verified =
    t.status === "approved" ? badge("✓", "mod") : t.status === "pending" ? badge("⏳", "member") : "";
  return bundle + verified;
}

/** A single template card. `data-open` carries the id for click delegation. */
export function templateCard(t: TplSummary): string {
  const src = previewUrl(t.id, 128);
  return `<button class="wd-tplcard" data-open="${esc(t.id)}" title="${esc(t.name)}">
    <img class="wd-tplcard-img" src="${esc(src)}" loading="lazy" onerror="this.style.opacity=.2">
    <div class="wd-tplcard-name">${esc(t.name)}</div>
    <div class="wd-tplcard-badges">${cardBadges(t)}</div>
  </button>`;
}
