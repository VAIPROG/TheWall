/**
 * Win95-styled modal dialogs used by the overlay JSON share / import flow.
 *
 * Two purposes:
 *
 *   1. `openExportOptionsDialog()` — collects author / clan / note settings
 *      from the user before we write a WallDevExport. Returns null when the
 *      user cancels.
 *   2. `showImportMetaDialog()` — surfaces the author + free-form note
 *      embedded in an incoming WallDevExport so the receiver knows where
 *      the template came from BEFORE they start drawing.
 *
 * Both dialogs follow the same skin as `pickCharityTemplate` in ui-wire.ts
 * (light bezel, gradient title bar, theme-aware). Kept separate from the
 * core `dialog.ts` because they need multi-field layouts that the standard
 * info/prompt helpers don't compose well.
 */
import { esc } from "./helpers";
import { t } from "./i18n";
import { isWalldevDark } from "./theme";
import { WallDevExport } from "./walldev-config";

export interface ExportOptionsResult {
  templateName: string;
  includeAuthor: boolean;
  anonymise: boolean;
  showClan: boolean;
  note: string;
}

export interface ExportOptionsDefaults {
  username: string;
  clanName: string | null;
  clanRole: string | null;
}

/** Theme tokens shared by both dialogs. Read once per open so the colours
 *  follow whatever theme is active right now (the user could be flipping
 *  the toggle in another window). */
function themeColors() {
  const dark = isWalldevDark();
  return {
    dark,
    bg: dark ? "#2c2c2c" : "#c0c0c0",
    field: dark ? "#0f0f0f" : "#fff",
    text: dark ? "#fff" : "#000",
    sub: dark ? "#aaa" : "#555",
    accent: dark ? "#2889ff" : "#000080",
  };
}

/**
 * Open the export-options dialog and resolve with the chosen settings, or
 * `null` when the user dismissed it. Defaults are pre-filled from the
 * active session so the user usually only has to click OK.
 */
export function openExportOptionsDialog(
  defaults: ExportOptionsDefaults,
): Promise<ExportOptionsResult | null> {
  return new Promise((resolve) => {
    const c = themeColors();
    const wrap = document.createElement("div");
    wrap.id = "wd-export-opts";
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:1000005;background:rgba(0,0,0,.55);" +
      "display:flex;align-items:center;justify-content:center;" +
      "font:12px W95FA,\"MS Sans Serif\",Tahoma,sans-serif";

    const clanHint =
      defaults.clanName && defaults.clanRole
        ? `${esc(defaults.clanName)} (${esc(defaults.clanRole)})`
        : defaults.clanName
          ? esc(defaults.clanName)
          : "—";

    wrap.innerHTML = `
      <div style="background:${c.bg};color:${c.text};width:440px;max-width:94vw;
                  border:2px solid;border-color:#fff #404040 #404040 #fff;
                  box-shadow:4px 4px 0 rgba(0,0,0,.5)">
        <div style="background:linear-gradient(90deg,${c.accent},#1084d0);
                    color:#fff;font-weight:bold;padding:4px 8px">
          ${esc(t("exportOptsTitle"))}
        </div>
        <div style="padding:14px 16px">
          <div style="margin-bottom:8px">
            <label style="display:block;margin-bottom:2px">
              ${esc(t("exportOptsName"))}
            </label>
            <input id="wd-eo-name" type="text" style="width:100%;box-sizing:border-box;
              padding:4px 6px;background:${c.field};color:${c.text};
              border:2px inset #808080">
          </div>

          <label class="wd-eo-row" style="display:flex;align-items:center;gap:6px;margin-top:8px">
            <input id="wd-eo-include" type="checkbox">
            <span>${esc(t("exportOptsIncludeAuthor"))} (${esc(defaults.username || "?")})</span>
          </label>
          <label class="wd-eo-row" style="display:flex;align-items:center;gap:6px;margin-top:4px;padding-left:18px">
            <input id="wd-eo-clan" type="checkbox" disabled>
            <span>${esc(t("exportOptsShowClan"))}: ${clanHint}</span>
          </label>
          <label class="wd-eo-row" style="display:flex;align-items:center;gap:6px;margin-top:4px;padding-left:18px">
            <input id="wd-eo-anon" type="checkbox" disabled>
            <span>${esc(t("exportOptsAnonymise"))}</span>
          </label>

          <div style="margin-top:12px">
            <label style="display:block;margin-bottom:2px">
              ${esc(t("exportOptsNote"))}
            </label>
            <textarea id="wd-eo-note" rows="3" style="width:100%;box-sizing:border-box;
              padding:4px 6px;background:${c.field};color:${c.text};
              border:2px inset #808080;font:12px W95FA,monospace;
              resize:vertical"></textarea>
          </div>
        </div>
        <div style="padding:8px 14px 12px;display:flex;gap:6px;justify-content:flex-end">
          <button id="wd-eo-cancel" class="wd-eo-btn">${esc(t("exportOptsCancel"))}</button>
          <button id="wd-eo-ok" class="wd-eo-btn wd-eo-primary">${esc(t("exportOptsConfirm"))}</button>
        </div>
      </div>`;

    // Buttons styled inline because we're outside the main panel's CSS scope.
    const style = document.createElement("style");
    style.textContent = `
      #wd-export-opts .wd-eo-btn {
        min-width: 92px; padding: 4px 12px;
        background: ${c.bg}; color: ${c.text};
        border: 2px solid; border-color: #fff #404040 #404040 #fff;
        font: 12px W95FA, sans-serif; cursor: pointer;
      }
      #wd-export-opts .wd-eo-btn:active {
        border-color: #404040 #fff #fff #404040;
      }
      #wd-export-opts .wd-eo-primary { font-weight: bold; }
    `;
    wrap.appendChild(style);
    document.body.appendChild(wrap);

    const includeEl = wrap.querySelector<HTMLInputElement>("#wd-eo-include")!;
    const clanEl = wrap.querySelector<HTMLInputElement>("#wd-eo-clan")!;
    const anonEl = wrap.querySelector<HTMLInputElement>("#wd-eo-anon")!;
    const nameEl = wrap.querySelector<HTMLInputElement>("#wd-eo-name")!;
    const noteEl = wrap.querySelector<HTMLTextAreaElement>("#wd-eo-note")!;

    // The clan / anonymise toggles are only meaningful when author info is
    // being included. Disable them until the parent checkbox is on.
    includeEl.addEventListener("change", () => {
      clanEl.disabled = !includeEl.checked;
      anonEl.disabled = !includeEl.checked;
      if (!includeEl.checked) {
        clanEl.checked = false;
        anonEl.checked = false;
      }
    });

    const finish = (val: ExportOptionsResult | null) => {
      wrap.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve(val);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
    };
    window.addEventListener("keydown", onKey, true);

    wrap.querySelector("#wd-eo-cancel")?.addEventListener("click", () => finish(null));
    wrap.querySelector("#wd-eo-ok")?.addEventListener("click", () => {
      finish({
        templateName: nameEl.value.trim(),
        includeAuthor: includeEl.checked,
        anonymise: anonEl.checked,
        showClan: clanEl.checked,
        note: noteEl.value.trim(),
      });
    });
  });
}

/**
 * Show the author + note carried by an incoming WallDevExport. The dialog
 * has a single "Open" button — it's purely informational, the overlay is
 * already loaded by the time we surface it.
 */
export function showImportMetaDialog(meta: {
  author?: WallDevExport["author"];
  note?: string;
}): Promise<void> {
  return new Promise((resolve) => {
    const c = themeColors();
    const wrap = document.createElement("div");
    wrap.id = "wd-import-meta";
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:1000006;background:rgba(0,0,0,.55);" +
      "display:flex;align-items:center;justify-content:center;" +
      "font:12px W95FA,\"MS Sans Serif\",Tahoma,sans-serif";

    let authorLine = "";
    if (meta.author) {
      if (meta.author.clan_name) {
        authorLine = t("importedFromAuthorClan", {
          name: meta.author.username,
          clan: meta.author.clan_name,
          role: meta.author.clan_role || "member",
        });
      } else {
        authorLine = t("importedFromAuthor", { name: meta.author.username });
      }
    }

    const noteBlock = meta.note
      ? `<div style="margin-top:10px">
           <div style="font-weight:bold;font-size:11px;margin-bottom:2px">
             ${esc(t("importedFromNoteHeading"))}
           </div>
           <div style="padding:6px 8px;background:${c.field};color:${c.text};
                       border:2px inset #808080;white-space:pre-wrap;
                       max-height:200px;overflow:auto">${esc(meta.note)}</div>
         </div>`
      : "";

    wrap.innerHTML = `
      <div style="background:${c.bg};color:${c.text};width:420px;max-width:94vw;
                  border:2px solid;border-color:#fff #404040 #404040 #fff;
                  box-shadow:4px 4px 0 rgba(0,0,0,.5)">
        <div style="background:linear-gradient(90deg,${c.accent},#1084d0);
                    color:#fff;font-weight:bold;padding:4px 8px">
          ${esc(t("importedFromTitle"))}
        </div>
        <div style="padding:14px 16px">
          ${authorLine ? `<div style="font-weight:bold">${esc(authorLine)}</div>` : ""}
          ${noteBlock}
        </div>
        <div style="padding:8px 14px 12px;display:flex;justify-content:flex-end">
          <button id="wd-im-ok" style="min-width:92px;padding:4px 12px;
            background:${c.bg};color:${c.text};
            border:2px solid;border-color:#fff #404040 #404040 #fff;
            font:12px W95FA,sans-serif;font-weight:bold;cursor:pointer">
            ${esc(t("importedFromOpen"))}
          </button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const finish = () => {
      wrap.remove();
      window.removeEventListener("keydown", onKey, true);
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener("keydown", onKey, true);
    wrap.querySelector("#wd-im-ok")?.addEventListener("click", finish);
  });
}
