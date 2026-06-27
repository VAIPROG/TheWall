import { $, esc, errMsg } from "../helpers";
import { ic } from "../icons";
import { t } from "../i18n";
import { cfg, saveCfg } from "../config";
import { applyTheme, applyUiScale, applyCozy } from "../theme";
import { applyCursorMode } from "../cursors";
import { loadRemoteI18n, backendConnect } from "../data";
import { reloadEmotes } from "../emoji";
import { confirmDlg, errorDlg, infoDlg, promptDlg } from "../dialog";
import { toast } from "../notify";
import { WallEvents } from "../events";
import { Backend } from "../backend";
import { manualCheck, skipVersion, cmpVersion } from "../update-check";
import { VERSION } from "../constants";
import { playPaintRefillSound } from "../paint-sound";
import { updatePaintCurrent, updateProfileBalance, wireSellButton } from "./paint";

export function wireSettings(_win: HTMLElement): void {
  // Appearance / locale
  $("cfg-theme")!.addEventListener("change", (e: Event) => {
    cfg.theme = (e.target as HTMLSelectElement).value as any;
    saveCfg();
    applyTheme();
  });
  $("cfg-uiscale")!.addEventListener("input", (e: Event) => {
    cfg.uiScale = parseFloat((e.target as HTMLInputElement).value);
    saveCfg();
    $("uiscale-val")!.textContent = Math.round(cfg.uiScale * 100) + "%";
    applyUiScale();
  });
  $("cfg-cozy")!.addEventListener("change", (e: Event) => {
    cfg.cozy = (e.target as HTMLInputElement).checked;
    saveCfg();
    applyCozy();
  });
  $("lang-select")!.addEventListener("change", (e: Event) => {
    localStorage.setItem(
      "wall_overlay_lang",
      (e.target as HTMLSelectElement).value,
    );
    location.reload();
  });
  $("cfg-remote-i18n")!.addEventListener("change", (e: Event) => {
    cfg.remoteI18n = (e.target as HTMLInputElement).checked;
    saveCfg();
    if (cfg.remoteI18n) loadRemoteI18n();
  });
  $("cfg-cursors")!.addEventListener("change", (e: Event) => {
    cfg.cursorMode = (e.target as HTMLSelectElement).value as any;
    saveCfg();
    applyCursorMode();
  });
  $("cfg-cursor-sel")!.addEventListener("change", (e: Event) => {
    cfg.cursorSelector =
      (e.target as HTMLInputElement).value.trim() || '[class*="cursor"]';
    saveCfg();
    applyCursorMode();
  });

  // ----------- 7TV emote channel manager -----------
  type EmoteChannelCfg = string | { id: string; name: string };
  function normChannel(
    c: EmoteChannelCfg,
  ): { id: string; name: string } | null {
    if (typeof c === "string") {
      const v = c.trim();
      if (!v) return null;
      if (/^\d+$/.test(v)) return { id: v, name: v };
      return null;
    }
    if (c?.id && c?.name) return { id: String(c.id), name: String(c.name) };
    return null;
  }
  function renderEmoteChannels(): void {
    const box = $("cfg-emote-channels");
    if (!box) return;
    const list = (cfg.emoteChannels || []) as EmoteChannelCfg[];
    const norms = list.map(normChannel).filter(Boolean) as Array<{
      id: string;
      name: string;
    }>;
    // Always-loaded built-ins shown first as informational chips.
    const builtin = [
      `<div class="wp-channel-item builtin"><div class="grow">
         <span class="badge">global</span>
         <span class="nm">7TV global</span>
         <span class="tid">always loaded</span>
       </div></div>`,
    ];
    const items = norms.map((ch, i) => {
      const isFilianDefault =
        ch.name.toLowerCase() === "filian" && ch.id === "198633200";
      return `<div class="wp-channel-item" data-i="${i}">
        <div class="grow">
          ${isFilianDefault ? `<span class="badge">default</span>` : ""}
          <span class="nm">#${esc(ch.name)}</span>
          <span class="tid">id: ${esc(ch.id)}</span>
        </div>
        <span class="rm" data-rm-channel="${i}" title="Remove">×</span>
      </div>`;
    });
    box.innerHTML =
      [...builtin, ...items].join("") ||
      `<div style="padding:4px;color:var(--sub);font-style:italic">No extra channels yet.</div>`;

    box.querySelectorAll<HTMLElement>("[data-rm-channel]").forEach((el) => {
      el.addEventListener("click", async () => {
        const i = parseInt(el.dataset.rmChannel || "-1", 10);
        if (i < 0) return;
        const ch = norms[i];
        if (
          !(await confirmDlg(
            `Remove channel ${ch.name} from your emote list?`,
            "Remove channel",
          ))
        )
          return;
        cfg.emoteChannels = cfg.emoteChannels.filter((_x, idx) => idx !== i);
        saveCfg();
        renderEmoteChannels();
        reloadEmotes().catch(() => {});
        toast("7TV", "channel removed");
      });
    });
  }
  $("btn-emote-add")?.addEventListener("click", async () => {
    const nameInput = $("cfg-emote-name") as HTMLInputElement;
    const idInput = $("cfg-emote-tid") as HTMLInputElement;
    const name = (nameInput?.value || "").trim().replace(/^#/, "");
    const id = (idInput?.value || "").trim();
    if (!name || !id) {
      await errorDlg("Both display name and Twitch user ID are required.");
      return;
    }
    if (!/^\d+$/.test(id)) {
      await errorDlg("Twitch user ID must be numeric (e.g. 198633200).");
      return;
    }
    const existing = (cfg.emoteChannels || [])
      .map(normChannel)
      .filter(Boolean) as Array<{ id: string; name: string }>;
    if (existing.some((ch) => ch.id === id)) {
      await errorDlg("That channel is already in your list.");
      return;
    }
    cfg.emoteChannels = [...(cfg.emoteChannels || []), { id, name }];
    saveCfg();
    nameInput.value = "";
    idInput.value = "";
    renderEmoteChannels();
    toast("7TV", `loading ${name}…`);
    try {
      await reloadEmotes();
      toast("7TV", "loaded");
    } catch (e: any) {
      await errorDlg("Failed to load: " + errMsg(e));
    }
  });
  $("btn-emote-reload")?.addEventListener("click", async () => {
    toast("7TV", "reloading…");
    try {
      await reloadEmotes();
      toast("7TV", "reloaded");
    } catch (e: any) {
      await errorDlg("Reload failed: " + errMsg(e));
    }
  });
  renderEmoteChannels();

  // Backend URL + connect
  $("cfg-backend-url")!.addEventListener("change", (e: Event) => {
    cfg.backendUrl = (e.target as HTMLInputElement).value.trim();
    saveCfg();
  });
  $("btn-backend-connect")!.addEventListener("click", backendConnect);

  // Toggles
  $("cfg-intercept")!.addEventListener("change", (e: Event) => {
    cfg.interceptEvents = (e.target as HTMLInputElement).checked;
    saveCfg();
    if (cfg.interceptEvents) WallEvents.startDom();
  });
  $("cfg-wstap")!.addEventListener("change", (e: Event) => {
    cfg.wsTap = (e.target as HTMLInputElement).checked;
    saveCfg();
    toast("WS tap", "reload page to (de)activate");
  });
  $("cfg-charity-no-identity")?.addEventListener("change", (e: Event) => {
    cfg.charityNoIdentity = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  // Update checker
  $("btn-check-update")!.addEventListener("click", async () => {
    const status = $("update-status");
    if (status) status.textContent = "checking…";
    const sig = await manualCheck();
    if (!sig) {
      if (status) status.textContent = "could not reach update server";
      return;
    }
    const diff = cmpVersion(sig.version, VERSION);
    if (diff === 0) {
      if (status) status.textContent = `up to date: v${VERSION}`;
      return;
    }
    if (diff < 0) {
      // Server reports an OLDER version than the one already installed —
      // common during local development or right after publishing. Show a
      // friendly note instead of "update available".
      if (status) {
        status.innerHTML = `you are ahead of release: <b>v${VERSION}</b> (server: v${sig.version})`;
      }
      return;
    }
    if (status) {
      const base = "https://the-wall.vai-rice.space";
      const d = sig.downloads as any;

      status.innerHTML =
        `update available: <b>v${sig.version}</b> (you have v${VERSION})<br>` +
        `<a href="${base}${d.userscript}" target="_blank" style="color:var(--link)">userscript</a> · ` +
        `<a href="${base}${d.chrome_zip}" target="_blank" style="color:var(--link)">chrome</a> · ` +
        `<a href="${base}${d.firefox_zip}" target="_blank" style="color:var(--link)">firefox</a> · ` +
        `<a href="${base}${d.safari_zip}" target="_blank" style="color:var(--link)">safari</a> · ` +
        `<a href="#" id="skip-ver" style="color:var(--sub)">skip</a>`;
      $("skip-ver")?.addEventListener("click", (e) => {
        e.preventDefault();
        skipVersion(sig.version);
        toast("Update", "version skipped");
      });
    }
  });

  // ------- Paint helpers: refill toggle, current paint display, sell-all -------
  document.addEventListener("wd:paint-changed", updatePaintCurrent);
  setTimeout(updatePaintCurrent, 1500);

  $("cfg-notify-paint")?.addEventListener("change", (e) => {
    cfg.notifyOnPaintRefill = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  $("cfg-sound-paint")?.addEventListener("change", (e) => {
    cfg.paintRefillSound = (e.target as HTMLInputElement).checked;
    saveCfg();
  });

  $("cfg-sound-vol")?.addEventListener("input", (e) => {
    const pct = Number((e.target as HTMLInputElement).value);
    cfg.paintRefillVolume = Math.max(0, Math.min(1, pct / 100));
    saveCfg();
    const lbl = $("paint-vol-val");
    if (lbl) lbl.textContent = `${pct}%`;
  });

  $("btn-sound-test")?.addEventListener("click", () => {
    // Force-play regardless of the toggle so the user can preview the chime
    // before flipping it on.
    const prev = cfg.paintRefillSound;
    cfg.paintRefillSound = true;
    playPaintRefillSound();
    cfg.paintRefillSound = prev;
  });

  // ----- Settings: paint sell buttons -----
  const settingsRefresh = () => {
    updatePaintCurrent();
    updateProfileBalance().catch(() => {});
  };
  wireSellButton("btn-sell-all", "all", settingsRefresh);
  wireSellButton("btn-sell-some", "prompt", settingsRefresh);

  // Backend meta
  const loadMeta = async () => {
    const el = $("server-meta");
    if (!el) return;
    el.textContent = "loading…";
    try {
      const r = await fetch(`${cfg.backendUrl}/meta`, { cache: "no-store" });
      const m = await r.json();
      el.textContent =
        `version:     v${m.version}\n` +
        `started:     ${m.started_at}\n` +
        `uptime:      ${Math.round(m.uptime_secs / 60)} min\n` +
        (m.deployed_at ? `deployed:    ${m.deployed_at}\n` : "") +
        (m.built_at ? `built:       ${m.built_at}\n` : "");
    } catch (e: any) {
      el.textContent = "could not reach backend: " + errMsg(e);
    }
  };
  $("btn-load-meta")?.addEventListener("click", loadMeta);
  setTimeout(loadMeta, 1500); // auto on open

  // Account deletion
  $("btn-delete-account")?.addEventListener("click", async () => {
    if (!Backend.on) {
      await errorDlg("Connect to backend first");
      return;
    }
    const ok = await confirmDlg(
      "This permanently deletes your profile, avatars, messages and templates. Continue?",
      "DELETE ACCOUNT?",
    );
    if (!ok) return;
    const reason = await promptDlg("Reason (optional):", "", "Reason");
    try {
      await Backend.req("POST", "/me/delete", { confirm: true, reason });
      cfg.backendToken = "";
      cfg.refreshToken = "";
      saveCfg();
      await infoDlg("Account deleted. Reloading…", "Done");
      setTimeout(() => location.reload(), 1500);
    } catch (e: any) {
      await errorDlg("Delete failed: " + errMsg(e));
    }
  });
}

export function buildSettingsPane(): string {
  return `<div class="wp-pane" data-p="se">
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
              </div>`;
}
