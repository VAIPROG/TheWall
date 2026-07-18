import { $ } from "./helpers";
import { ic } from "./icons";
import { t } from "./i18n";
import { cfg } from "./config";
import { VERSION } from "./constants";
import { injectStyle } from "./styles";
import { applyTheme, applyUiScale, applyCozy, applyPixelIcons, watchSiteTheme } from "./theme";
import { injectIconFilter } from "./ui/kit/icons";
import { renderOverlay, updateLockBtn } from "./overlay";
import { initGuide } from "./guide";
import { wireUI } from "./ui-wire";
import { syncProfile, refreshNotifications } from "./data";
import { buildOverlayPane } from "./ui/overlay-tab";
import { buildTemplatesPane } from "./ui/templates/shell";
import { buildCommunityPane } from "./ui/community/shell";
import { buildProfilePane } from "./ui/profile-tab";
import { buildSettingsPane } from "./ui/settings-tab";
import { buildAdminPane } from "./ui/admin";

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
              <div class="wp-tab" data-p="tp">${ic("disk")}${t("tabTpl")}</div>
              <div class="wp-tab" data-p="co">${ic("chat")}${t("tabCommunity")}</div>
              <div class="wp-tab" data-p="pr">${ic("user")}${t("tabProfile")}</div>
              <div class="wp-tab" data-p="se">${ic("gear")}${t("tabSettings")}</div>
              <div class="wp-tab" data-p="ad" id="tab-admin" style="display:none">${ic("shield")}Admin</div>
          </div>
          <div class="wp-content">
              <!-- OVERLAY -->
              ${buildOverlayPane()}
              <!-- TEMPLATES (V3 super-tab: browse / detail / publish / share) -->
              ${buildTemplatesPane()}
              <!-- COMMUNITY -->
              ${buildCommunityPane()}
              <!-- PROFILE (super-tab: Profile / Mail / Achievements sub-nav) -->
              ${buildProfilePane()}
              <!-- SETTINGS -->
              ${buildSettingsPane()}
              <!-- ADMIN (hidden unless role=admin/owner) -->
              ${buildAdminPane()}
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
  injectIconFilter(document);
  applyPixelIcons();
  watchSiteTheme();
  wireUI(win);
  syncProfile();
  refreshNotifications();
  renderOverlay();
  updateLockBtn();
  // Layers now exist — restore the saved guide layer + apply its style.
  initGuide();
}
