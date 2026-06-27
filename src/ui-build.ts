import { $ } from "./helpers";
import { ic } from "./icons";
import { t } from "./i18n";
import { cfg } from "./config";
import { VERSION } from "./constants";
import { injectStyle } from "./styles";
import { applyTheme, applyUiScale, applyCozy, watchSiteTheme } from "./theme";
import { renderOverlay, updateLockBtn } from "./overlay";
import { wireUI } from "./ui-wire";
import { syncProfile, loadGuilds, refreshNotifications } from "./data";
import { buildOverlayPane } from "./ui/overlay-tab";
import { buildSharePane } from "./ui/share-tab";
import { buildTemplatesPane } from "./ui/templates-tab";
import { buildProtectPane } from "./ui/build-protect";
import { buildMailPane } from "./ui/build-mail";
import { buildSocialPane } from "./ui/build-social";
import { buildProfilePane } from "./ui/profile-tab";
import { buildAchievementsPane } from "./ui/achievements-tab";
import { buildClanPane } from "./ui/chats";
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
              ${buildOverlayPane()}
              <!-- SHARE (unified import / publish / export) -->
              ${buildSharePane()}
              <!-- TEMPLATES (catalog only — upload moved to Share tab) -->
              ${buildTemplatesPane()}
              <!-- PROTECT -->
              ${buildProtectPane()}
              <!-- MAIL -->
              ${buildMailPane()}
              <!-- SOCIAL -->
              ${buildSocialPane()}
              <!-- PROFILE -->
              ${buildProfilePane()}
              <!-- ACHIEVEMENTS -->
              ${buildAchievementsPane()}
              <!-- CLAN -->
              ${buildClanPane()}
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
  watchSiteTheme();
  wireUI(win);
  syncProfile();
  loadGuilds();
  refreshNotifications();
  renderOverlay();
  updateLockBtn();
}
