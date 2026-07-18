/**
 * The reusable advanced clan card: a banner strip (backend gradient fallback)
 * with the overlaid clan avatar, name + tag + `ownerVerified` badge, and stat
 * chips (members / templates / online). Pure HTML string builder — no DOM, no
 * network (the banner/avatar URLs come from `api.ts` helpers that only compose a
 * public, never-404 path). The host screens (Hub / browse) own the click wiring
 * via the `data-clan` root attribute; this module is presentation only.
 */
import { esc } from "../../helpers";
import { badge } from "../kit/primitives";
import { t } from "../../i18n";
import { clanAvatarUrl, clanBannerUrl } from "./api";
import type { ClanSummary } from "./api";

export interface ClanCardOpts { context: "hub" | "browse" | "manage"; }

/** Advanced clan card: banner strip + overlaid avatar + name/tag/verified +
 *  stat chips. Pure HTML string. The banner/avatar URLs always resolve (backend
 *  serve never 404s). `context` tunes density (browse = compact). */
export function clanCard(cl: ClanSummary, opts: ClanCardOpts): string {
  const compact = opts.context === "browse";
  const ver = cl.ownerVerified ? badge("✓ " + (t("commVerified") || "verified"), "owner") : "";
  const tag = cl.tag ? `<span class="wd-clancard-tag">[${esc(cl.tag)}]</span>` : "";
  const members = cl.stats?.memberCount ?? cl.memberCount ?? 0;
  const templates = cl.stats?.templateCount ?? 0;
  const online = cl.stats?.onlineCount;
  const chips =
    `<span class="wd-clancard-chip">👥 ${esc(String(members))}</span>` +
    `<span class="wd-clancard-chip">📄 ${esc(String(templates))}</span>` +
    (online != null ? `<span class="wd-clancard-chip">🟢 ${esc(String(online))}</span>` : "");
  return `
    <div class="wd-clancard${compact ? " wd-clancard--compact" : ""}" data-clan="${esc(cl.id)}">
      <div class="wd-clancard-banner" style="background-image:url('${esc(clanBannerUrl(cl.id))}')"></div>
      <img class="wd-clancard-av" src="${esc(clanAvatarUrl(cl.id))}" alt="" width="40" height="40">
      <div class="wd-clancard-body">
        <div class="wd-clancard-name">${esc(cl.name)} ${tag} ${ver}</div>
        <div class="wd-clancard-chips">${chips}</div>
      </div>
    </div>`;
}
