import { $, esc } from "./helpers";
import { ic } from "./icons";
import { t } from "./i18n";
import { cfg } from "./config";
import { VERSION } from "./constants";
import { PALETTE, activeColor } from "./palette";
import { injectStyle } from "./styles";
import { applyTheme, applyUiScale, applyCozy, watchSiteTheme } from "./theme";
import { applyOverlayScale, updateLockBtn } from "./overlay";
import { wireUI } from "./ui-wire";
import { syncProfile, loadGuilds, refreshNotifications } from "./data";

// <option> list for the publish/protect scope selects. Protection adds a
// device-local scope on top of the shared private/clan/public set.
function scopeOptions(opts: { local?: boolean } = {}): string {
  const rows: Array<[string, string]> = [];
  if (opts.local) rows.push(["local", "scopeLocal"]);
  rows.push(
    ["private", "scopePrivate"],
    ["clan", "scopeClan"],
    ["public", "scopePublic"],
  );
  return rows
    .map(([value, key]) => `<option value="${value}">${t(key)}</option>`)
    .join("");
}

function paletteSwatches(): string {
  return `<div class="wp-sw">${PALETTE.map(
    (h) =>
      `<button data-hex="${h}" style="background:${h}" title="${h}" class="${h === activeColor ? "sel" : ""}"></button>`,
  ).join("")}</div>`;
}

export function buildUI(): void {
  if ($("walldev-tool")) return;
  injectStyle();
  const win = document.createElement("div");
  win.id = "walldev-tool";
  win.innerHTML = `
      <div class="wp-titlebar" id="wp-drag">
          <span class="wp-tcap"><span class="wp-led"></span><span>${t("title")}</span></span>
          <span class="wp-tbtns">
              <span id="wp-status" style="font-weight:normal;font-size:10px;margin-right:4px">${t("offline")}</span>
              <span class="wp-tbtn" id="wp-min" title="minimize">${ic("minimize", 10)}</span>
              <span class="wp-tbtn" id="wp-close" title="hide">${ic("xcom", 10)}</span>
          </span>
      </div>
      <div class="wp-body">
          <div class="wp-tabs">
              <div class="wp-tab active" data-p="ov">${ic("grid")}${t("tabOverlay")}</div>
              <div class="wp-tab" data-p="sh">${ic("send")}${t("tabShare")}</div>
              <div class="wp-tab" data-p="tp">${ic("disk")}${t("tabTpl")}</div>
              <div class="wp-tab" data-p="pt">${ic("shield")}${t("tabProtect")}</div>
              <div class="wp-tab" data-p="ma">${ic("bell")}Mail</div>
              <div class="wp-tab" data-p="so">${ic("globe")}${t("tabSocial")}</div>
              <div class="wp-tab" data-p="pr">${ic("user")}${t("tabProfile")}</div>
              <div class="wp-tab" data-p="ah">${ic("star")}${t("achTabTitle")}</div>
              <div class="wp-tab" data-p="cl">${ic("shield")}${t("tabClan")}</div>
              <div class="wp-tab" data-p="se">${ic("gear")}${t("tabSettings")}</div>
              <div class="wp-tab" data-p="ad" id="tab-admin" style="display:none">${ic("shield")}Admin</div>
          </div>
          <div class="wp-content">
              <!-- OVERLAY -->
              <div class="wp-pane active" data-p="ov">
                  <div class="wp-group"><div class="wp-legend">${ic("disk")}${t("file")}</div>
                      <input type="file" id="file-upload" accept="image/*" class="wp-input" style="font:11px sans-serif">
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("send")}${t("ovShareLegend")}</div>
                      <button class="wp-btn primary" id="btn-jump-share" style="width:100%">${ic("send")}${t("ovShareGo")} →</button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("ovShareHint")}</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("pin")}${t("coords")}</div>
                      <div class="wp-row"><div>X<input type="number" id="coord-x" name="coord_x" autocomplete="off" class="wp-input" value="0"></div>
                      <div>Y<input type="number" id="coord-y" name="coord_y" autocomplete="off" class="wp-input" value="0"></div></div>
                      <button class="wp-btn" id="btn-pick">${ic("pin")}${t("pickPoint")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${t("scale")}: <span id="scale-val">${Math.round((cfg.overlayScale || 1) * 100)}%</span></div>
                      <input type="range" id="scale-range" min="5" max="1000" step="5" value="${Math.round((cfg.overlayScale || 1) * 100)}" style="width:100%">
                      <div style="display:flex;gap:4px;margin-top:4px;flex-wrap:wrap">
                          <button class="wp-btn" data-scale-preset="10" style="flex:1;min-width:46px;padding:2px 4px;margin:0">10%</button>
                          <button class="wp-btn" data-scale-preset="25" style="flex:1;min-width:46px;padding:2px 4px;margin:0">25%</button>
                          <button class="wp-btn" data-scale-preset="50" style="flex:1;min-width:46px;padding:2px 4px;margin:0">50%</button>
                          <button class="wp-btn" data-scale-preset="100" style="flex:1;min-width:46px;padding:2px 4px;margin:0">100%</button>
                          <button class="wp-btn" data-scale-preset="200" style="flex:1;min-width:46px;padding:2px 4px;margin:0">200%</button>
                          <button class="wp-btn" data-scale-preset="500" style="flex:1;min-width:46px;padding:2px 4px;margin:0">500%</button>
                      </div>
                      <input type="number" id="scale-input" min="5" max="1000" step="1" value="${Math.round((cfg.overlayScale || 1) * 100)}" class="wp-input" style="margin-top:4px;font:11px monospace" title="exact %">
                  </div>
                  <div class="wp-group" id="opacity-group" style="${cfg.compactMarkers ? "display:none" : ""}"><div class="wp-legend">${t("opacity")}</div>
                      <input type="range" id="opacity-range" min="0" max="1" step="0.05" value="${cfg.defaultOpacity}" style="width:100%">
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">Opacity has no effect in dots mode — dots are always fully opaque for max readability.</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("grid")}Compact markers</div>
                      <label class="wp-check"><input type="checkbox" id="cfg-compact-markers" ${cfg.compactMarkers ? "checked" : ""}> Render every missing pixel as a small opaque dot (canvas stays visible)</label>
                      <div id="compact-size-wrap" style="margin-top:4px;${cfg.compactMarkers ? "" : "display:none"}">
                          Dot size: <span id="compact-size-val">${cfg.compactMarkerSize}%</span> of pixel
                          <input type="range" id="cfg-compact-size" min="10" max="90" step="5" value="${cfg.compactMarkerSize}" style="width:100%">
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">Marker is centred inside each canvas pixel. Pixels already matching the canvas are skipped.</div>
                          <div style="margin-top:8px">Live refresh: <span id="dots-refresh-val">${cfg.dotsRefreshMs}ms</span>
                              <input type="range" id="cfg-dots-refresh" min="200" max="10000" step="100" value="${cfg.dotsRefreshMs}" style="width:100%">
                              <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">How often the overlay re-checks the canvas. 500 ms = snappy, 2000 ms = quieter.</div>
                          </div>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("bolt")}${t("animLegend")}</div>
                      <div class="wp-hud" id="anim-status">${t("animStatusOff")}</div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-anim-stop" style="flex:1;margin:0">${t("animStop")}</button>
                          <button class="wp-btn" id="btn-anim-advanced" style="flex:1;margin:0">${t("animAdvanced")} ▸</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("animHint")}</div>
                      <div id="anim-advanced-wrap" style="display:none;margin-top:6px">
                          <div class="wp-row">
                              <div>W<input type="number" id="anim-frame-w" class="wp-input" min="1"></div>
                              <div>H<input type="number" id="anim-frame-h" class="wp-input" min="1"></div>
                              <div>#<input type="number" id="anim-frame-count" class="wp-input" min="1"></div>
                          </div>
                          <button class="wp-btn" id="btn-anim-autosplit" style="margin-top:4px;width:100%">${t("animAutosplit")}</button>
                          <div class="wp-row" style="margin-top:4px">
                              <select id="anim-layout" class="wp-input" style="font:11px sans-serif">
                                  <option value="grid">${t("animLayoutGrid")}</option>
                                  <option value="line">${t("animLayoutLine")}</option>
                              </select>
                              <select id="anim-order" class="wp-input" style="font:11px sans-serif">
                                  <option value="row">${t("animOrderRow")}</option>
                                  <option value="column">${t("animOrderColumn")}</option>
                                  <option value="serpentine">${t("animOrderSerp")}</option>
                              </select>
                          </div>
                          <div style="margin-top:4px">${t("animFrameMs")}
                              <input type="number" id="anim-frame-ms" class="wp-input" min="50" step="50" value="1000">
                          </div>
                          <label class="wp-check"><input type="checkbox" id="anim-looping" checked> ${t("animLooping")}</label>
                          <div style="margin-top:4px">${t("animScaling")}
                              <select id="anim-scaling" class="wp-input" style="font:11px sans-serif">
                                  <option value="native">${t("animScalingNative")}</option>
                                  <option value="scaled">${t("animScalingScaled")}</option>
                              </select>
                          </div>
                          <div style="display:flex;gap:4px;margin-top:6px">
                              <button class="wp-btn primary" id="btn-anim-apply" style="flex:1;margin:0">${t("animApply")}</button>
                              <button class="wp-btn" id="btn-anim-start-now" style="flex:1;margin:0">${t("animStartNow")}</button>
                          </div>
                          <div style="display:flex;gap:4px;margin-top:4px">
                              <button class="wp-btn" id="btn-anim-export-walldev" style="flex:1;margin:0">${t("animExportOur")}</button>
                              <button class="wp-btn" id="btn-anim-export-charity" style="flex:1;margin:0">${t("animExportCharity")}</button>
                          </div>
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:6px">${t("animPublishMoved")}</div>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("scan")}${t("progress")}</div>
                      <div class="wp-hud" id="wp-progress">—</div>
                      <button class="wp-btn" id="btn-progress">${ic("scan")}${t("progress")}</button>
                      <button class="wp-btn" id="btn-progress-guide">${t("showRemaining")}</button>
                  </div>
                  <button class="wp-btn active-state" id="btn-lock">${t("unlock")}</button>
                  <button class="wp-btn" id="btn-toggle">${t("visibility")}</button>
              </div>
              <!-- SHARE (unified import / publish / export) -->
              <div class="wp-pane" data-p="sh">
                  <div class="wp-group">
                      <div class="wp-legend">${ic("dl")}${t("shareLegendImport")}</div>
                      <input type="file" id="share-import-file" accept=".json,.png,.jpg,.jpeg,.gif,.webp,.txt,application/json,image/*" class="wp-input" style="font:11px sans-serif">
                      <button class="wp-btn primary" id="btn-share-import-file" style="margin-top:4px;width:100%">${ic("dl")}${t("shareImportFileBtn")}</button>
                      <input type="text" id="share-import-url" class="wp-input" autocomplete="off" placeholder="${esc(t("shareImportUrlPlaceholder"))}" style="margin-top:6px">
                      <button class="wp-btn" id="btn-share-import-url" style="margin-top:4px;width:100%">${ic("globe")}${t("shareImportPasteBtn")}</button>
                      <div id="share-detected" style="font-size:11px;color:var(--sub);margin-top:4px"></div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("shareImportFileHint")}</div>
                  </div>

                  <div class="wp-group">
                      <div class="wp-legend">${ic("plus")}${t("sharePublishLegend")}</div>
                      <div style="font-size:11px;margin-bottom:4px">${t("shareScope")}:</div>
                      <select id="share-scope" class="wp-input" style="font:11px sans-serif">${scopeOptions()}</select>
                      <input type="text" id="share-pass" class="wp-input" autocomplete="off" placeholder="${esc(t("animSharePass"))}" style="margin-top:4px">
                      <button class="wp-btn primary" id="btn-tpl-share" style="margin-top:4px;width:100%">${ic("plus")}${t("sharePublishBtn")}</button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("sharePublishNote")}</div>
                  </div>

                  <div class="wp-group">
                      <div class="wp-legend">${ic("bolt")}${t("animPublishLegend")}</div>
                      <div style="font-size:11px;margin-bottom:4px">${t("animShareScope")}:</div>
                      <select id="anim-share-scope" class="wp-input" style="font:11px sans-serif">${scopeOptions()}</select>
                      <input type="text" id="anim-share-pass" class="wp-input" autocomplete="off" placeholder="${esc(t("animSharePass"))}" style="margin-top:4px">
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn primary" id="btn-anim-upload" style="flex:1;margin:0">${t("animUpload")}</button>
                          <button class="wp-btn" id="btn-anim-browse" style="flex:1;margin:0">${t("animBrowse")}</button>
                      </div>
                      <div id="anim-shared-list" style="margin-top:4px;font-size:11px"></div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("animPublishNote")}</div>
                      <div style="margin-top:8px;border-top:1px dashed var(--shadow);padding-top:6px">
                          <div style="font-size:11px;margin-bottom:4px">${t("animByCodeLegend")}:</div>
                          <input type="text" id="anim-shared-code" class="wp-input" autocomplete="off" placeholder="${esc(t("animByCodePlaceholder"))}">
                          <input type="text" id="anim-shared-code-pass" class="wp-input" autocomplete="off" placeholder="${esc(t("animSharePass"))}" style="margin-top:4px">
                          <button class="wp-btn" id="btn-anim-load-shared" style="margin-top:4px;width:100%">${ic("dl")}${t("animByCodeLoad")}</button>
                          <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("animByCodeNote")}</div>
                      </div>
                  </div>

                  <div class="wp-group">
                      <div class="wp-legend">${ic("send")}${t("shareLegendExport")}</div>

                      <!-- Share URLs -->
                      <button class="wp-btn primary" id="btn-share-export-url-thewall" style="width:100%"
                              title="${esc(t("shareExportNoteUrlTheWallDev"))}">
                          ${ic("globe")}${t("shareExportCopyUrlTheWallDev")}
                      </button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin:2px 0 6px">
                          ${t("shareExportNoteUrlTheWallDev")}
                      </div>

                      <button class="wp-btn" id="btn-share-export-url-charity" style="width:100%"
                              title="${esc(t("shareExportNoteUrlCharity"))}">
                          ${ic("globe")}${t("shareExportCopyUrlCharity")}
                      </button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin:2px 0 8px">
                          ${t("shareExportNoteUrlCharity")}
                      </div>

                      <!-- Share Link -->
                      <button class="wp-btn" id="btn-share-export-link" style="width:100%"
                              title="${esc(t("shareExportNoteLink"))}">
                          ${ic("bolt")}${t("shareExportCopyShareLink")}
                      </button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin:2px 0 8px">
                          ${t("shareExportNoteLink")}
                      </div>

                      <!-- Save JSON + Save Charity -->
                      <div style="display:flex;gap:4px">
                          <button class="wp-btn" id="btn-share-export-json" style="flex:1;margin:0"
                                  title="${esc(t("shareExportNoteJson"))}">
                              ${ic("disk")}${t("shareExportSaveJson")}
                          </button>
                          <button class="wp-btn" id="btn-share-export-charity" style="flex:1;margin:0"
                                  title="${esc(t("shareExportNoteCharity"))}">
                              ${ic("globe")}${t("shareExportSaveCharity")}
                          </button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin:2px 0 0">
                          ${t("shareExportNoteJson")}<br>${t("shareExportNoteCharity")}
                      </div>
                  </div>
              </div>
              <!-- TEMPLATES (catalog only — upload moved to Share tab) -->
              <div class="wp-pane" data-p="tp">
                  <div class="wp-group"><div class="wp-legend">${ic("scan")}${t("tplSearchLegend")}</div>
                      <input type="text" id="tpl-search" class="wp-input" autocomplete="off" placeholder="${esc(t("tplSearchPlaceholder"))}">
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">${t("tplSearchHint")}</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("check")}${t("publicTpl")}</div>
                      <div class="wp-list" id="pub-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-unverified" ${cfg.showUnverified ? "checked" : ""}> ${t("unverified")}</label>
                          <button class="wp-btn" id="btn-reload-pub-tpl" style="padding:2px 8px;margin:0" title="Reload public templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <label class="wp-check" style="margin-top:2px"><input type="checkbox" id="cfg-hide-anim-pub" ${cfg.hideAnimatedPub ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}${t("clanTpl")}</div>
                      <div class="wp-list" id="clan-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-unverified-clan" ${cfg.showUnverifiedClan ? "checked" : ""}> ${t("unverified")}</label>
                          <button class="wp-btn" id="btn-reload-clan-tpl" style="padding:2px 8px;margin:0" title="Reload clan templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <label class="wp-check" style="margin-top:2px"><input type="checkbox" id="cfg-hide-anim-clan" ${cfg.hideAnimatedClan ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("myTpl")}</div>
                      <div class="wp-list" id="my-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-hide-anim-mine" ${cfg.hideAnimatedMine ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                          <button class="wp-btn" id="btn-reload-my-tpl" style="padding:2px 8px;margin:0" title="Reload my templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("myTplHint")}</div>
                  </div>
              </div>
              <!-- PROTECT -->
              <div class="wp-pane" data-p="pt">
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}${t("protectLegend")}</div>
                      <div class="wp-row">
                          <div>${t("protectTolerance")}<input type="number" id="protect-tolerance" class="wp-input" min="0" max="100" step="0.5" value="0"></div>
                          <div>${t("protectScopeLbl")}<select id="protect-scope" class="wp-input" style="font:11px sans-serif">${scopeOptions({ local: true })}</select></div>
                      </div>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn primary" id="btn-protect-template" style="flex:1;margin:0">${t("protectFixTemplate")}</button>
                          <button class="wp-btn" id="btn-protect-zone" style="flex:1;margin:0">${t("protectFixZone")}</button>
                      </div>
                      <label class="wp-check" style="margin-top:4px"><input type="checkbox" id="protect-watch"> ${t("protectWatch")}</label>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-protect-verify" style="flex:1;margin:0">${t("protectVerifyAll")}</button>
                          <button class="wp-btn" id="btn-protect-refresh" style="flex:1;margin:0">${t("protectList")}</button>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("globe")}${t("protectGlobalList")}</div>
                      <div class="wp-list" id="protect-list-global"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}${t("protectClanList")}</div>
                      <div class="wp-list" id="protect-list-clan"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("disk")}${t("protectLocalList")}</div>
                      <div class="wp-list" id="protect-list-local"><div style="padding:6px;color:var(--sub)">—</div></div>
                  </div>
              </div>
              <!-- MAIL -->
              <div class="wp-pane" data-p="ma">
                  <div class="wp-group">
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
                  </div>
              </div>
              <!-- SOCIAL -->
              <div class="wp-pane" data-p="so">
                  <div class="wp-group"><div class="wp-legend">Snackers HQ</div>
                      <a class="wp-btn primary" target="_blank" rel="noopener" href="https://discord.gg/filian">${ic("discord")}Snackers HQ — Discord</a>
                      <a class="wp-btn primary" target="_blank" rel="noopener" href="https://discord.gg/snackersru">${ic("discord")}Snackers RU — Discord</a>
                      <a class="wp-btn" target="_blank" rel="noopener" href="https://x.com/THE_W4LL_">${ic("xcom")}The Wall — X</a>
                      <a class="wp-btn" target="_blank" rel="noopener" href="https://www.reddit.com/r/THE_WALL_/">${ic("reddit")}r/THE_WALL_</a>
                  </div>
                  <div class="wp-group"><div class="wp-legend">VAI_PROG</div>
                      <a class="wp-btn" target="_blank" href="https://github.com/Vadim-Khristenko">${ic("github")}GitHub — VAI_PROG</a>
                      <a class="wp-btn" target="_blank" href="https://x.com/VAI_PROG">${ic("xcom")}x.com/VAI_PROG</a>
                  </div>
                  <div class="wp-group"><div class="wp-legend">Cloud</div>
                      <div style="font-size:11px;margin-bottom:4px">Quality / Качество:</div>
                      <select id="snapshot-quality" class="wp-input" style="font:11px sans-serif">
                          <option value="low">Low — 1500×1050 · ~30 tiles · fastest</option>
                          <option value="medium">Medium — 3000×2100 · ~108 tiles</option>
                          <option value="high" selected>High — 6000×4200 · ~408 tiles · best</option>
                      </select>
                      <button class="wp-btn" id="btn-snapshot">${ic("dl")}${t("snapshot")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">My Discord guilds</div>
                      <div class="wp-list" id="social-guilds"><div style="padding:6px">${t("syncing")}</div></div>
                  </div>
              </div>
              <!-- PROFILE -->
              <div class="wp-pane" data-p="pr">
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("tabProfile")}</div>
                      <div id="profile-card"><div style="padding:6px">${t("syncing")}</div></div></div>
                  <div class="wp-group"><div class="wp-legend">${ic("bolt")}${t("profilePaintHeading")}</div>
                      <div style="font-size:11px;line-height:1.55">
                          <div><b>${t("paintCurrentHeading")}:</b> <span id="profile-paint">${t("paintCurrentNone")}</span></div>
                          <div style="margin-top:2px"><b>${t("profileCoinsHeading")}:</b> <span id="profile-coins">${t("profileCoinsUnknown")}</span></div>
                      </div>
                      <button class="wp-btn" id="btn-profile-refresh-balance" style="margin-top:6px;width:100%">${ic("scan", 10)}${t("profileRefreshBalance")}</button>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn" id="btn-profile-sell-some" style="flex:1;padding:2px 6px;margin:0" title="${esc(t("sellAllNote"))}">${ic("bolt", 10)}${t("sellSomeBtn")}</button>
                          <button class="wp-btn" id="btn-profile-sell-all" style="flex:1;padding:2px 6px;margin:0" title="${esc(t("sellAllNote"))}">${ic("bolt", 10)}${t("sellAllBtn")}</button>
                      </div>
                      <button class="wp-btn primary" id="btn-profile-shop" style="margin-top:4px;width:100%" title="${esc(t("profileShopHint"))}">${ic("user", 10)}${t("profileOpenShop")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}Bio</div>
                      <textarea id="profile-bio" name="profile_bio" class="wp-input" rows="3" autocomplete="off" placeholder="A short bio (markdown supported)"></textarea>
                      <div class="wp-note" style="color:var(--sub);margin-top:2px">Supports **bold**, *italic*, [link](url), :emote:</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("globe")}Social Links</div>
                      <div id="profile-social-list" class="wp-social-list"></div>
                      <button class="wp-btn" id="btn-social-add" style="margin-top:6px;width:100%">${ic("plus")}Add a link</button>
                  </div>
                  <div class="wp-group" style="background:transparent;border:none;padding:0;margin-top:8px">
                      <button class="wp-btn primary" id="btn-profile-save" style="width:100%">${ic("disk")}Save profile</button>
                      <div class="wp-note" style="color:var(--sub);text-align:center;margin-top:4px">Bio &amp; links are public on your profile page.</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("pin")}Pinned templates</div>
                      <div id="profile-pinned" style="display:flex;gap:6px;flex-wrap:wrap;min-height:60px">
                          <div style="color:var(--sub);padding:6px">No pinned templates yet — pin from Templates tab.</div>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("customAvatar")}</div>
                      <input type="file" id="avatar-upload" accept="image/*" class="wp-input" style="font:11px sans-serif">
                      <button class="wp-btn" id="btn-avatar-reset">${ic("xcom")}Reset to Discord avatar</button>
                      <button class="wp-btn" id="btn-avatar-refresh-discord">${ic("discord")}Refresh Discord avatar cache</button>
                      <div class="wp-note" style="color:var(--sub)">${t("avatarNote")}</div>
                  </div>
              </div>
              <!-- ACHIEVEMENTS -->
              <div class="wp-pane" data-p="ah">
                  <div class="wp-group"><div class="wp-legend">${ic("star")}${t("achTabTitle")}</div>
                      <div id="ach-summary" style="padding:4px 0;font-size:10px;color:var(--sub)"></div>
                      <div id="ach-list" class="wp-list" style="max-height:520px;overflow-y:auto"><div style="padding:6px;color:var(--sub)">${t("syncing")}</div></div>
                  </div>
              </div>
              <!-- CLAN -->
              <div class="wp-pane" data-p="cl">
                  <div class="wp-group" id="clan-announce-group" style="display:none">
                      <div class="wp-legend">${ic("bell")}Send Announcement</div>
                      <input type="text" id="announce-title" name="announce_title" autocomplete="off" class="wp-input" placeholder="Title">
                      <textarea id="announce-body" name="announce_body" class="wp-input" rows="2" autocomplete="off" placeholder="Body (markdown)"></textarea>
                      <button class="wp-btn primary" id="btn-announce-send">${ic("bolt")}Send</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}${t("tabClan")}</div>
                      <div id="clan-card"><div style="padding:6px">${t("syncing")}</div></div></div>
                  <div class="wp-group"><div class="wp-legend">${ic("chat")}${t("clanChat")} <span class="wp-note" style="color:var(--led);margin:0 0 0 4px">${t("via")}</span></div>
                      <div class="wp-chat" id="clan-chat"><div style="color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div class="wp-chat-input-row">
                          <textarea class="wp-input wp-chat-input" id="clan-chat-input" name="clan_chat_input" autocomplete="off" placeholder="markdown: **bold** *italic* \`code\` :emote: @user"></textarea>
                          <button class="wp-btn wp-emoji-btn" id="btn-emoji" title="Emotes" aria-label="Emotes">${ic("emote")}</button>
                      </div>
                      <button class="wp-btn primary" id="btn-clan-send">${ic("send")}${t("sendLong")}</button>
                      <div id="mention-suggest" class="wp-mention-suggest"></div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("roster")}</div>
                      <div class="wp-list" id="clan-roster"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}moderation</div>
                      <button class="wp-btn" id="btn-mod-apply">${ic("shield")}${t("applyMod")}</button>
                  </div>
              </div>
              <!-- SETTINGS -->
              <div class="wp-pane" data-p="se">
                  <div class="wp-section-hdr">${ic("user", 10)} Display</div>
                  <div class="wp-group"><div class="wp-legend">${ic("moon")}${t("theme")}</div>
                      <select id="cfg-theme" class="wp-input" style="font:11px sans-serif">
                          <option value="auto" ${cfg.theme === "auto" ? "selected" : ""}>${t("themeAuto")}</option>
                          <option value="light" ${cfg.theme === "light" ? "selected" : ""}>${t("themeLight")}</option>
                          <option value="dark" ${cfg.theme === "dark" ? "selected" : ""}>${t("themeDark")}</option>
                      </select>
                      <div class="wp-legend" style="position:static;margin-top:8px">${t("uiScale")}: <span id="uiscale-val">${Math.round(cfg.uiScale * 100)}%</span></div>
                      <input type="range" id="cfg-uiscale" min="0.8" max="1.6" step="0.1" value="${cfg.uiScale}" style="width:100%">
                      <label class="wp-check"><input type="checkbox" id="cfg-cozy" ${cfg.cozy ? "checked" : ""}> ${t("cozy")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${t("lang")}</div>
                      <select id="lang-select" class="wp-input" style="font:11px sans-serif">
                          <option value="en" ${localStorage.getItem("wall_overlay_lang") !== "ru" ? "selected" : ""}>English</option>
                          <option value="ru" ${localStorage.getItem("wall_overlay_lang") === "ru" ? "selected" : ""}>Русский</option>
                      </select>
                      <label class="wp-check"><input type="checkbox" id="cfg-remote-i18n" ${cfg.remoteI18n ? "checked" : ""}> remote translations (backend)</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("cursor")}${t("cursors")}</div>
                      <select id="cfg-cursors" class="wp-input" style="font:11px sans-serif">
                          <option value="off" ${cfg.cursorMode === "off" ? "selected" : ""}>${t("cursorsOff")}</option>
                          <option value="clan" ${cfg.cursorMode === "clan" ? "selected" : ""}>${t("cursorsClan")}</option>
                      </select>
                  </div>
                  <div class="wp-section-hdr">${ic("plug", 10)} Connectivity</div>
                  <div class="wp-group"><div class="wp-legend">${t("backend")}</div>
                      <input type="text" id="cfg-backend-url" name="cfg_backend_url" autocomplete="off" class="wp-input" placeholder="https://the-wall.vai-rice.space/api" value="${esc(cfg.backendUrl)}">
                      <button class="wp-btn" id="btn-backend-connect">${cfg.backendToken ? t("disconnect") : t("connect")}</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("globe")}${t("linksLegend")}</div>
                      <div id="links-rows" style="font-size:11px"><div style="color:var(--sub)">${t("syncing")}</div></div>
                      <div class="wp-links-actions">
                          <button class="wp-btn" id="btn-links-manage" title="${esc(t("linksManageTip"))}">${t("linksManage")}</button>
                          <button class="wp-btn" id="btn-links-refresh" title="${esc(t("linksRefreshTip"))}">↻ ${t("linksRefresh")}</button>
                      </div>
                      <label class="wp-check" style="margin-top:6px"><input type="checkbox" id="cfg-paint-reminder-remote" ${cfg.paintReminderRemote ? "checked" : ""}> ${t("paintReminderRemote")}</label>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("linksHint")}</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${t("advanced")}</div>
                      <label class="wp-check"><input type="checkbox" id="cfg-intercept" ${cfg.interceptEvents ? "checked" : ""}> intercept site events (chat/paint)</label>
                      <label class="wp-check"><input type="checkbox" id="cfg-wstap" ${cfg.wsTap ? "checked" : ""}> mirror WebSocket (read-only stats)</label>
                      <div style="margin-top:6px">cursor selector<input type="text" id="cfg-cursor-sel" name="cfg_cursor_sel" autocomplete="off" class="wp-input" value="${esc(cfg.cursorSelector)}"></div>
                      <div class="wp-note" style="color:var(--sub)">${t("advancedNote")}</div>
                  </div>
                  <div class="wp-section-hdr">${ic("emote", 10)} Tools</div>
                  <div class="wp-group"><div class="wp-legend">${ic("emote")}7TV Emote Channels</div>
                      <div class="wp-note" style="color:var(--sub);margin-bottom:4px">Global + filian are always loaded. Add streamer channels by their Twitch user ID.</div>
                      <div id="cfg-emote-channels" class="wp-channels-list" style="min-height:24px;margin-bottom:4px"></div>
                      <div class="wp-channel-add">
                          <input type="text" id="cfg-emote-name" name="cfg_emote_name" autocomplete="off" class="wp-input" placeholder="display name (e.g. xqc)" style="flex:1">
                          <input type="text" id="cfg-emote-tid" name="cfg_emote_tid" autocomplete="off" class="wp-input" placeholder="Twitch user ID (numeric)" style="flex:1.2">
                          <button class="wp-btn primary" id="btn-emote-add" style="flex:none;width:auto;padding:3px 10px;margin:0;white-space:nowrap">${ic("plus")}Add</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);margin-top:6px;line-height:1.45">
                          Find a Twitch user ID at <a href="https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/" target="_blank" rel="noopener" style="color:var(--accent);word-break:break-all">streamweasels.com</a>.
                      </div>
                      <button class="wp-btn" id="btn-emote-reload" style="margin-top:4px;width:100%">↻ Reload emotes</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("bolt")}${t("paintGroup")}</div>
                      <label class="wp-check"><input type="checkbox" id="cfg-notify-paint" ${cfg.notifyOnPaintRefill ? "checked" : ""}> ${t("paintNotifRefill")}</label>
                      <div class="wp-note" style="color:var(--sub);font-size:10px">${t("paintNotifRefillNote")}</div>
                      <label class="wp-check" style="margin-top:6px"><input type="checkbox" id="cfg-sound-paint" ${cfg.paintRefillSound ? "checked" : ""}> ${t("paintSoundRefill")}</label>
                      <div class="wp-note" style="color:var(--sub);font-size:10px">${t("paintSoundRefillNote")}</div>
                      <div style="margin-top:4px">
                          <div style="display:flex;align-items:center;gap:6px;font-size:11px">
                              <span style="flex:none">${t("paintSoundVolume")}:</span>
                              <input type="range" id="cfg-sound-vol" min="0" max="100" step="5" value="${Math.round(cfg.paintRefillVolume * 100)}" style="flex:1;min-width:0">
                              <span id="paint-vol-val" style="flex:none;min-width:34px;text-align:right">${Math.round(cfg.paintRefillVolume * 100)}%</span>
                          </div>
                          <button class="wp-btn" id="btn-sound-test" style="margin-top:4px;width:100%">${ic("bell", 10)}${t("paintSoundTest")}</button>
                      </div>
                      <div class="wp-legend" style="position:static;margin-top:8px">${t("paintCurrentHeading")}</div>
                      <div id="paint-current" style="font-size:11px;color:var(--text);padding:4px 6px;background:var(--field);color:var(--fieldtext);border:1px inset var(--shadow);margin-bottom:4px">${t("paintCurrentNone")}</div>
                      <div style="display:flex;gap:4px">
                          <button class="wp-btn" id="btn-sell-some" style="flex:1;margin:0" title="${esc(t("sellAllNote"))}">${ic("bolt")}${t("sellSomeBtn")}</button>
                          <button class="wp-btn" id="btn-sell-all" style="flex:1;margin:0" title="${esc(t("sellAllNote"))}">${ic("bolt")}${t("sellAllBtn")}</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px">${t("sellAllNote")}</div>
                  </div>
                  <div class="wp-section-hdr">${ic("bell", 10)} System</div>
                  <div class="wp-group"><div class="wp-legend">${ic("dl")}Updates &amp; meta</div>
                      <div id="update-status" style="font-size:11px;color:var(--sub);margin-bottom:4px">current: v${VERSION}</div>
                      <div id="server-meta" style="font-size:10px;color:var(--sub);line-height:1.4;border:1px inset var(--shadow);padding:4px;background:var(--field);color:var(--fieldtext);white-space:pre-wrap">backend meta: (not loaded)</div>
                      <button class="wp-btn" id="btn-check-update">${ic("dl")}Check for update</button>
                      <button class="wp-btn" id="btn-load-meta">refresh backend meta</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("trash")}Account</div>
                      <button class="wp-btn" id="btn-delete-account" style="color:#c33">${ic("trash")}Delete my account</button>
                      <div class="wp-note">Permanently removes your profile, avatars, messages and templates.</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">about</div>
                      <div style="font-size:10px;line-height:1.5">The Wall Dev v${VERSION}<br>by VAI_PROG · vai on wall<br>contact: <a href="mailto:vadim+the_wall@vai-rice.space" style="color:var(--link)">vadim+the_wall@vai-rice.space</a></div>
                      <button class="wp-btn" id="btn-reset">${t("resetCfg")}</button>
                  </div>
              </div>
              <!-- ADMIN (hidden unless role=admin/owner) -->
              <div class="wp-pane" data-p="ad">
                  <div class="wp-group"><div class="wp-legend">${ic("user")}Users</div>
                      <div class="wp-list" id="admin-users" style="max-height:240px"><div style="padding:6px;color:var(--sub)">loading…</div></div>
                      <button class="wp-btn" id="btn-admin-reload">reload all</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}Moderation requests</div>
                      <div class="wp-list" id="admin-modapps"><div style="padding:6px;color:var(--sub)">loading…</div></div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("disk")}All templates</div>
                      <div class="wp-list" id="admin-templates" style="max-height:200px"><div style="padding:6px;color:var(--sub)">loading…</div></div>
                      <button class="wp-btn" id="btn-backfill-previews" style="margin-top:6px;width:100%">${ic("scan")}Backfill missing previews</button>
                      <div class="wp-note" style="color:var(--sub);font-size:10px">Generates 64/128/256 thumbnails for every template that doesn't have one yet. Heavy on large catalogs.</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("bell")}Notifications</div>
                      <div class="wp-list" id="admin-notifs" style="max-height:200px"><div style="padding:6px;color:var(--sub)">loading…</div></div>
                      <button class="wp-btn primary" id="btn-broadcast">${ic("bell")}Send broadcast to all users</button>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("achAdminGrantTitle")}</div>
                      <input id="admin-ach-uid" name="admin_ach_uid" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminUserId")}">
                      <select id="admin-ach-id" name="admin_ach_id" class="wp-input" style="font:11px sans-serif">
                          <option value="" disabled selected>${t("achAdminPickAch")}</option>
                      </select>
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <button class="wp-btn primary" id="btn-admin-ach-grant" style="flex:1">${ic("plus")}${t("achAdminGrant")}</button>
                          <button class="wp-btn" id="btn-admin-ach-revoke" style="flex:1">${ic("trash")}${t("achAdminRevoke")}</button>
                      </div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("plus")}${t("achAdminCreateTitle")}</div>
                      <input id="admin-ach-new-id" name="admin_ach_new_id" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateId")}">
                      <input id="admin-ach-new-name" name="admin_ach_new_name" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateName")}">
                      <input id="admin-ach-new-desc" name="admin_ach_new_desc" autocomplete="off" type="text" class="wp-input" placeholder="${t("achAdminCreateDesc")}">
                      <div style="display:flex;gap:4px;margin-top:4px">
                          <select id="admin-ach-new-icon" name="admin_ach_new_icon" class="wp-input" style="font:11px sans-serif;flex:1">
                              <option value="medal">medal</option>
                              <option value="crown">crown</option>
                              <option value="trophy">trophy</option>
                              <option value="palette">palette</option>
                              <option value="spark">spark</option>
                              <option value="sparkle">sparkle</option>
                              <option value="shield">shield</option>
                              <option value="plug">plug</option>
                              <option value="user">user</option>
                              <option value="globe">globe</option>
                              <option value="discord">discord</option>
                              <option value="telegram">telegram</option>
                              <option value="moon">moon</option>
                              <option value="check">check</option>
                              <option value="bell">bell</option>
                              <option value="bolt">bolt</option>
                              <option value="pin">pin</option>
                              <option value="grid">grid</option>
                              <option value="scan">scan</option>
                              <option value="star">star</option>
                          </select>
                          <select id="admin-ach-new-cat" name="admin_ach_new_cat" class="wp-input" style="font:11px sans-serif;flex:1">
                              <option value="general">${t("achCategoryGeneral")}</option>
                              <option value="pixels">${t("achCategoryPixels")}</option>
                              <option value="templates">${t("achCategoryTemplates")}</option>
                              <option value="clan">${t("achCategoryClan")}</option>
                              <option value="social">${t("achCategorySocial")}</option>
                              <option value="tools">${t("achCategoryTools")}</option>
                              <option value="time">${t("achCategoryTime")}</option>
                              <option value="easter">${t("achCategoryEaster")}</option>
                          </select>
                      </div>
                      <div style="display:flex;gap:4px;margin-top:4px;align-items:center">
                          <label style="flex:1;font-size:11px">${t("achAdminCreatePoints")} <input id="admin-ach-new-pts" name="admin_ach_new_pts" type="number" class="wp-input" value="10" min="0" max="1000" style="width:60px;display:inline"></label>
                          <label class="wp-check" style="flex:1.4"><input type="checkbox" id="admin-ach-new-secret"> ${t("achAdminCreateSecret")}</label>
                      </div>
                      <button class="wp-btn primary" id="btn-admin-ach-create" style="margin-top:4px;width:100%">${ic("plus")}${t("achAdminCreate")}</button>
                  </div>
                  <div class="wp-note" style="color:var(--sub)">Admin actions are server-validated. You see this tab because your backend role is admin/owner.</div>
              </div>
          </div>
      </div>`;
  // Resize grip lives outside the body grid so it overlays the bottom-right
  // corner without shifting layout. The wireUI() pass binds the drag.
  const grip = document.createElement("div");
  grip.className = "wp-resize-handle";
  grip.id = "wp-resize-handle";
  grip.title = "Resize";
  win.appendChild(grip);
  document.body.appendChild(win);
  // Restore last saved size BEFORE applyUiScale runs so the zoom transform
  // composes with the right base dimensions.
  if (cfg.windowWidth && cfg.windowHeight) {
    win.style.width = cfg.windowWidth + "px";
    (
      win.querySelector(".wp-content") as HTMLElement | null
    )?.style?.setProperty("max-height", cfg.windowHeight - 60 + "px");
  }
  applyTheme();
  applyUiScale();
  applyCozy();
  watchSiteTheme();
  wireUI(win);
  syncProfile();
  loadGuilds();
  refreshNotifications();
  applyOverlayScale();
  updateLockBtn();
}
