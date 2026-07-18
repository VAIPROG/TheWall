export { wireAdmin } from "./admin";
export { wireOverlay, applyScalePct } from "./overlay-tab";
export { wireProfile } from "./profile-tab";
export { wireSettings } from "./settings-tab";
export { wireTemplates } from "./templates/shell";
export { wireCommunity } from "./community/shell";
export * from "./paint";
export { wireWindowChrome } from "./window-chrome";
export { loadAchievementList } from "./achievements-tab";

import { wireAnimAndProtect } from "../anim-protect-wire";
import { wireLinks } from "../links-wire";
import { wireWindowChrome } from "./window-chrome";
import { wireOverlay } from "./overlay-tab";
import { wireTemplates } from "./templates/shell";
import { wireCommunity } from "./community/shell";
import { wireProfile } from "./profile-tab";
import { wireSettings } from "./settings-tab";
import { wireAdmin } from "./admin";
import { wireMailUI } from "../mail";
import { setActiveColor } from "../palette";
import { downloadWallSnapshot } from "../snapshot";
import { $ } from "../helpers";

export function wireExtensionUI(win: HTMLElement): void {
  // Animation + region-protection groups live in their own wiring module.
  wireAnimAndProtect();
  wireLinks();

  // Window chrome: tab switching, drag, resize grip, min/close, mail-tab listener
  wireWindowChrome(win);

  // overlay tab (incl. the Share/Publish hand-off button)
  wireOverlay(win);

  // draw tab
  win.querySelectorAll(".wp-sw button").forEach((b) =>
    b.addEventListener("click", () => {
      setActiveColor((b as HTMLElement).dataset.hex || "");
      win
        .querySelectorAll(".wp-sw button")
        .forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
    }),
  );

  // templates tab
  wireTemplates(win);

  // community tab
  wireCommunity(win);

  // Wall snapshot — fetch every tile from ws.filianislost.com/tiles, stitch
  // onto a brick-background canvas, downscale to chosen quality, download PNG.
  // The control now lives in the Overlay pane (its old Social home was retired);
  // wire it null-safe so a missing button never aborts the rest of wiring.
  $("btn-snapshot")?.addEventListener("click", () => {
    const sel = $("snapshot-quality") as HTMLSelectElement | null;
    const q = (sel?.value || "high") as "low" | "medium" | "high";
    downloadWallSnapshot(q);
  });

  // profile tab
  wireProfile(win);

  // mail tab
  wireMailUI();

  // settings tab
  wireSettings(win);

  wireAdmin(win);
}
