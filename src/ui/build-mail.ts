import { ic } from "../icons";
import { t } from "../i18n";
import { esc } from "../helpers";

// Inner content of the Mail sub-section (no `.wp-pane` wrapper) — Mail is now
// folded into the Profile super-tab, so this html is embedded inside
// `#profile-sub-mail` rather than mounting a standalone pane. All ids are kept
// intact so wireMailUI()/loadNotifications() bind exactly as before.
export function buildMailContent(): string {
  return `<div class="wp-group">
                      <div class="wp-legend">${ic("bell")}Inbox <span id="mail-unread-count" style="font-weight:normal;color:var(--accent);margin-left:4px"></span></div>
                      <div class="wp-tabbar" id="mail-filters" style="display:flex;gap:2px;margin-bottom:4px;flex-wrap:wrap">
                          <button class="wp-btn active" data-mail-kind="" style="flex:1;min-width:54px;padding:2px 6px;margin:0">All</button>
                          <button class="wp-btn" data-mail-kind="dm" style="flex:1;min-width:54px;padding:2px 6px;margin:0">DMs</button>
                          <button class="wp-btn" data-mail-kind="announcement" style="flex:1;min-width:54px;padding:2px 6px;margin:0">News</button>
                          <button class="wp-btn" data-mail-kind="clan_alert" style="flex:1;min-width:54px;padding:2px 6px;margin:0">Alerts</button>
                          <button class="wp-btn" data-mail-kind="modmail" style="flex:1;min-width:54px;padding:2px 6px;margin:0">Modmail</button>
                      </div>
                      <div class="wp-list" id="mail-list" style="max-height:280px;min-height:60px"><div style="padding:6px;color:var(--sub)">${t("syncing")}</div></div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-mail-refresh" style="flex:1;margin:0">${ic("scan", 10)}Refresh</button>
                          <button class="wp-btn" id="btn-mail-markread" style="flex:1;margin:0" title="${esc(t("mailMarkAllReadHint"))}">${ic("check", 10)}${t("markRead")}</button>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("send")}New DM</div>
                      <input type="text" id="dm-to" name="dm_to" class="wp-input" autocomplete="off" placeholder="@username (auto-complete by typing @)">
                      <textarea id="dm-body" name="dm_body" class="wp-input" rows="3" autocomplete="off" placeholder="Markdown + :emote: + @mention. Press Ctrl+Enter to send."></textarea>
                      <button class="wp-btn primary" id="btn-dm-send" style="width:100%">${ic("send")}Send DM</button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("mailDmHint")}</div>
                      <div id="dm-mention-suggest" class="wp-mention-suggest"></div>
                  </div>`;
}
