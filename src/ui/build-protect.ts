import { ic } from "../icons";
import { t } from "../i18n";
import { scopeOptions } from "./build-shared";

export function buildProtectPane(): string {
  return `<div class="wp-pane" data-p="pt">
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
              </div>`;
}
