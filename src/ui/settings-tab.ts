import { $, esc, errMsg } from "../helpers";
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
