import { ic } from "../icons";
import { t } from "../i18n";
import { esc } from "../helpers";
import { MAIL_FILTERS } from "../mail-model";

// Inner content of the Mail sub-section (no `.wp-pane` wrapper) — Mail is
// folded into the Profile super-tab, so this html is embedded inside
// `#profile-sub-mail` rather than mounting a standalone pane.
//
// Mail is a pure V3 NOTIFICATIONS inbox: list + type filters + refresh /
// mark-all-read. The DM composer + chat list that used to live here moved to
// the Community super-tab (src/ui/community) — do NOT re-add `#dm-*` ids here
// without wiring them, and keep every id below in sync with wireMailUI().
export function buildMailContent(): string {
  const filters = MAIL_FILTERS.map(
    (f, i) =>
      `<button class="wp-btn${i === 0 ? " active" : ""}" data-mail-filter="${f.value}" style="flex:1;min-width:38px;padding:2px 6px;margin:0">${esc(f.label)}</button>`,
  ).join("");
  return `<div class="wp-group">
                      <div class="wp-legend">${ic("bell")}Inbox <span id="mail-unread-count" style="font-weight:normal;color:var(--accent);margin-left:4px"></span></div>
                      <div class="wp-tabbar" id="mail-filters" style="display:flex;gap:2px;margin-bottom:4px;flex-wrap:wrap">${filters}</div>
                      <div class="wp-list" id="mail-list" style="max-height:280px;min-height:60px"><div style="padding:6px;color:var(--sub)">${t("syncing")}</div></div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-mail-refresh" style="flex:1;margin:0">${ic("scan", 10)}Refresh</button>
                          <button class="wp-btn" id="btn-mail-markread" style="flex:1;margin:0" title="${esc(t("mailMarkAllReadHint"))}">${ic("check", 10)}${t("markRead")}</button>
                      </div>
                  </div>`;
}
