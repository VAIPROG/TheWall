import { $, esc } from "../helpers";
import { t } from "../i18n";
import { ic, achIcon as achIconHelper } from "../icons";
import { listMine, type AchievementRow } from "../achievements";

// ---------------------------------------------------------------------------
// Achievement list (Profile pane)
// ---------------------------------------------------------------------------

const ACH_CATEGORY_KEYS: Record<string, string> = {
  general: "achCategoryGeneral",
  pixels: "achCategoryPixels",
  templates: "achCategoryTemplates",
  clan: "achCategoryClan",
  social: "achCategorySocial",
  tools: "achCategoryTools",
  time: "achCategoryTime",
  easter: "achCategoryEaster",
};

// Render a small SVG medallion (24px) from icons.ts for each row. The
// previous emoji-based map has been replaced — see achIcon() in icons.ts.
function renderAchIcon(name: string): string {
  return achIconHelper(name, 24);
}

export async function loadAchievementList(): Promise<void> {
  const list = $("ach-list");
  const summary = $("ach-summary");
  if (!list) return;

  const all = await listMine();
  if (!all.length) {
    list.innerHTML = `<div style="padding:6px;color:var(--sub)">${esc(t("achLocked"))}</div>`;
    if (summary) summary.textContent = "";
    return;
  }

  const unlocked = all.filter((a) => a.unlockedAt);
  const totalPts = unlocked.reduce((s, a) => s + a.points, 0);
  if (summary) {
    summary.textContent =
      t("achUnlockedCount", {
        got: String(unlocked.length),
        all: String(all.length),
      }) +
      " · " +
      t("achTotalPoints", { n: String(totalPts), label: t("achPoints") });
  }

  // Group by category
  const byCat = new Map<string, AchievementRow[]>();
  for (const a of all) {
    const arr = byCat.get(a.category) || [];
    arr.push(a);
    byCat.set(a.category, arr);
  }

  let html = "";
  for (const [cat, items] of byCat) {
    const catLabel = t(ACH_CATEGORY_KEYS[cat] || "achCategoryGeneral");
    html += `<div style="font-weight:bold;font-size:10px;color:var(--sub);margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px">${esc(catLabel)}</div>`;
    for (const a of items) {
      const got = !!a.unlockedAt;
      const icon = renderAchIcon(a.iconUrl);
      const opacity = got ? "1" : "0.35";
      const name = got
        ? esc(a.title)
        : a.secret
          ? esc(t("achSecret"))
          : esc(a.title);
      const desc = got
        ? esc(a.description)
        : a.secret
          ? "???"
          : esc(a.description);
      const pts = `<span style="margin-left:auto;font-size:9px;color:var(--sub)">${a.points} ${esc(t("achPoints"))}</span>`;
      const dateStr = a.unlockedAt
        ? `<span style="font-size:9px;color:var(--sub);margin-left:6px">${new Date(a.unlockedAt).toLocaleDateString()}</span>`
        : "";
      html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;opacity:${opacity};border-bottom:1px solid rgba(128,128,128,.15)">
        <span style="flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:bold;font-size:11px">${name}${dateStr}</div>
          <div style="font-size:10px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
        </div>
        ${pts}
      </div>`;
    }
  }
  list.innerHTML = html;
}

// Inner content of the Achievements sub-section (no `.wp-pane` wrapper) —
// Achievements are now folded into the Profile super-tab, so this html is
// embedded inside `#profile-sub-ach`. Ids (`#ach-summary`/`#ach-list`) are kept
// intact so loadAchievementList() targets them unchanged.
export function buildAchievementsContent(): string {
  return `<div class="wp-group"><div class="wp-legend">${ic("star")}${t("achTabTitle")}</div>
                      <div id="ach-summary" style="padding:4px 0;font-size:10px;color:var(--sub)"></div>
                      <div id="ach-list" class="wp-list" style="max-height:520px;overflow-y:auto"><div style="padding:6px;color:var(--sub)">${t("syncing")}</div></div>
                  </div>`;
}
