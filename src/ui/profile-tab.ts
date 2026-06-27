import { $, errMsg } from "../helpers";
import { t } from "../i18n";
import { ic } from "../icons";
import { toast } from "../notify";
import { confirmDlg, errorDlg } from "../dialog";
import { log } from "../log";
import { cfg } from "../config";
import { Backend, getMe } from "../backend";
import { markAllRead, syncProfile, resetAvatar } from "../data";
import { importShare } from "../share";
import { openCursorShop } from "../open-cursor-shop";
import {
  updatePaintCurrent,
  updateProfilePaintLine,
  updateProfileBalance,
  wireSellButton,
} from "./paint";

export function wireProfile(_win: HTMLElement): void {
  // Legacy site-notification mark-read button — moved off the Profile pane
  // in favour of the mailbox-level mark-all-read on the Mail tab. Kept
  // null-safe so older builds with the button still wire up cleanly.
  $("btn-markread")?.addEventListener("click", markAllRead);

  // ----------- Profile: bio + social links (inline-editable cards) -----------

  type SocialLink = { label: string; url: string };

  function guessIcon(url: string): string {
    const u = url.toLowerCase();
    if (u.includes("twitter.com") || u.includes("x.com")) return "🐦";
    if (u.includes("github.com")) return "🐙";
    if (u.includes("discord.")) return "💬";
    if (u.includes("twitch.tv")) return "🎮";
    if (u.includes("youtube.com") || u.includes("youtu.be")) return "▶️";
    if (u.includes("t.me") || u.includes("telegram.")) return "✈️";
    if (u.includes("instagram.")) return "📷";
    if (u.includes("mailto:") || u.startsWith("mail")) return "✉️";
    return "🔗";
  }

  function normaliseUrl(raw: string): string {
    const v = raw.trim();
    if (!v) return v;
    if (/^[a-z]+:/i.test(v)) return v;
    if (v.includes("@") && !v.includes("/")) return "mailto:" + v;
    return "https://" + v;
  }

  function isUrlValid(raw: string): boolean {
    if (!raw) return false;
    try {
      new URL(normaliseUrl(raw));
      return true;
    } catch {
      return false;
    }
  }

  function getLinks(): SocialLink[] {
    return ((window as any).__wallSocialLinks || []) as SocialLink[];
  }
  function setLinks(v: SocialLink[]): void {
    (window as any).__wallSocialLinks = v;
  }

  function refreshSocial(links?: any[]): void {
    const list = $("profile-social-list");
    if (!list) {
      log("SOCIAL", "WARN", "refresh: list not in DOM");
      return;
    }

    // Don't wipe an in-progress editor. wd:profile-loaded races with user
    // interaction; if we innerHTML="" here the editor disappears right after
    // the user clicks "Add a link".
    if (list.querySelector(".wp-social-editor")) {
      log("SOCIAL", "INFO", "refresh skipped — editor in progress");
      return;
    }

    const arr = (links || getLinks()) as SocialLink[];
    log("SOCIAL", "INFO", `refresh: ${arr.length} link(s)`);
    if (!arr.length) {
      list.innerHTML = `<div class="wp-empty" style="padding:8px;color:var(--sub);font-style:italic;text-align:center">No social links yet — click "Add a link" below.</div>`;
      return;
    }
    list.innerHTML = arr
      .map((l, i) => {
        const icon = guessIcon(l.url || "");
        const safeLabel = (l.label || l.url || "").replace(/[<>"]/g, "");
        const safeUrl = (l.url || "").replace(/"/g, "&quot;");
        return `<div class="wp-social-item" data-i="${i}" draggable="true">
        <span class="wp-social-grip" title="Drag to reorder">⋮⋮</span>
        <span class="wp-social-icon">${icon}</span>
        <div class="wp-social-text">
          <div class="wp-social-label">${safeLabel}</div>
          <a class="wp-social-url" href="${safeUrl}" target="_blank" rel="noopener">${safeUrl}</a>
        </div>
        <button class="wp-social-edit"  data-edit-social="${i}" title="Edit">✎</button>
        <button class="wp-social-del"   data-rm-social="${i}"  title="Remove">×</button>
      </div>`;
      })
      .join("");

    list.querySelectorAll<HTMLElement>("[data-rm-social]").forEach((b) => {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const i = parseInt(b.dataset.rmSocial || "0", 10);
        const link = getLinks()[i];
        if (!link) return;
        // Shift-click to skip confirm for quick cleanup.
        if (!(ev as MouseEvent).shiftKey) {
          const ok = await confirmDlg(
            `Remove "${link.label || link.url}"?`,
            "Remove link",
          );
          if (!ok) return;
        }
        setLinks(getLinks().filter((_x, idx) => idx !== i));
        refreshSocial();
      });
    });

    list.querySelectorAll<HTMLElement>("[data-edit-social]").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const i = parseInt(b.dataset.editSocial || "0", 10);
        openSocialEditor(i);
      });
    });

    // Drag-to-reorder
    let dragIdx = -1;
    list.querySelectorAll<HTMLElement>(".wp-social-item").forEach((item) => {
      item.addEventListener("dragstart", () => {
        dragIdx = parseInt(item.dataset.i || "-1", 10);
        item.classList.add("dragging");
      });
      item.addEventListener("dragover", (e) => {
        e.preventDefault();
        item.classList.add("dropping");
      });
      item.addEventListener("dragleave", () =>
        item.classList.remove("dropping"),
      );
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        item.classList.remove("dropping");
        const toIdx = parseInt(item.dataset.i || "-1", 10);
        if (dragIdx < 0 || toIdx < 0 || dragIdx === toIdx) return;
        const arr2 = getLinks().slice();
        const [moved] = arr2.splice(dragIdx, 1);
        arr2.splice(toIdx, 0, moved);
        setLinks(arr2);
        refreshSocial();
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
    });
  }

  /** Inline editor — adds a card with two inputs + Save/Cancel right in the list. */
  function openSocialEditor(editIdx: number | null): void {
    log(
      "SOCIAL",
      "INFO",
      `openSocialEditor(${editIdx == null ? "NEW" : `edit #${editIdx}`})`,
    );
    const list = $("profile-social-list");
    if (!list) {
      log("SOCIAL", "ERR", "profile-social-list not in DOM");
      return;
    }

    // Clear empty placeholder (it's not a child of arr but lives in `list`).
    const empty = list.querySelector(".wp-empty");
    if (empty) {
      log("SOCIAL", "DBG", "removing empty placeholder");
      empty.remove();
    }
    // Cancel any existing draft.
    const oldEditor = list.querySelector(".wp-social-editor");
    if (oldEditor) {
      log("SOCIAL", "DBG", "removing old editor");
      oldEditor.remove();
    }

    const existing = editIdx == null ? null : getLinks()[editIdx];
    const editor = document.createElement("div");
    editor.className = "wp-social-editor";
    editor.innerHTML = `
      <div class="wp-social-editor-icon">${guessIcon(existing?.url || "")}</div>
      <div class="wp-social-editor-fields">
        <input type="text" class="wp-input wd-ed-label" placeholder="Label (e.g. Twitter)" value="${(existing?.label || "").replace(/"/g, "&quot;")}">
        <input type="text" class="wp-input wd-ed-url"   placeholder="https://… or user@example.com" value="${(existing?.url || "").replace(/"/g, "&quot;")}">
        <div class="wd-ed-hint" style="color:var(--sub);font-size:10px;margin-top:2px">Tip: paste a URL — we'll auto-add https:// if missing.</div>
      </div>
      <div class="wp-social-editor-actions">
        <button class="wp-btn primary wd-ed-save" title="Save (Enter)">${ic("disk")}</button>
        <button class="wp-btn wd-ed-cancel"      title="Cancel (Esc)">×</button>
      </div>`;

    // Insert mode: append new editor. Edit mode: replace the existing card.
    if (editIdx == null) {
      list.appendChild(editor);
    } else {
      const cards = list.querySelectorAll(".wp-social-item");
      const card = cards[editIdx];
      if (card) card.replaceWith(editor);
      else list.appendChild(editor);
    }

    const labelInput = editor.querySelector<HTMLInputElement>(".wd-ed-label")!;
    const urlInput = editor.querySelector<HTMLInputElement>(".wd-ed-url")!;
    const iconBox = editor.querySelector<HTMLElement>(
      ".wp-social-editor-icon",
    )!;

    urlInput.addEventListener("input", () => {
      iconBox.textContent = guessIcon(urlInput.value);
      urlInput.style.borderColor =
        isUrlValid(urlInput.value) || !urlInput.value ? "" : "#c33";
    });

    const commit = async () => {
      const label = labelInput.value.trim();
      const rawUrl = urlInput.value.trim();
      if (!rawUrl) {
        await errorDlg("URL is required.");
        urlInput.focus();
        return;
      }
      if (!isUrlValid(rawUrl)) {
        await errorDlg("That doesn't look like a valid URL.");
        urlInput.focus();
        return;
      }
      const link: SocialLink = {
        label: label || rawUrl,
        url: normaliseUrl(rawUrl),
      };
      const arr2 = getLinks().slice();
      if (editIdx == null) arr2.push(link);
      else arr2[editIdx] = link;
      setLinks(arr2);
      refreshSocial();
    };
    const cancel = () => refreshSocial();

    editor.querySelector(".wd-ed-save")?.addEventListener("click", (e) => {
      e.stopPropagation();
      commit();
    });
    editor.querySelector(".wd-ed-cancel")?.addEventListener("click", (e) => {
      e.stopPropagation();
      cancel();
    });
    [labelInput, urlInput].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
    });

    (existing ? urlInput : labelInput).focus();
    editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
    log(
      "SOCIAL",
      "OK",
      "editor mounted, focus on " + (existing ? "url" : "label"),
    );
  }

  const addBtn = $("btn-social-add");
  if (!addBtn) {
    log("SOCIAL", "ERR", "btn-social-add not in DOM at wire time");
  } else {
    addBtn.addEventListener("click", (e) => {
      log("SOCIAL", "INFO", "Add-link clicked");
      e.preventDefault();
      e.stopPropagation();
      openSocialEditor(null);
    });
  }
  $("btn-profile-save")?.addEventListener("click", async () => {
    const bio = ($("profile-bio") as HTMLTextAreaElement)?.value || "";
    const social_links = (window as any).__wallSocialLinks || [];
    try {
      await Backend.req("PUT", "/v2/me/profile", { bio, social_links });
      toast("Profile", "saved");
      syncProfile();
    } catch (e: any) {
      await errorDlg("Save failed: " + errMsg(e));
    }
  });
  // Hook up initial values whenever profile syncs
  document.addEventListener("wd:profile-loaded", (e: any) => {
    const p = e.detail || {};
    const bioEl = $("profile-bio") as HTMLTextAreaElement | null;
    if (bioEl && document.activeElement !== bioEl) bioEl.value = p.bio || "";
    (window as any).__wallSocialLinks = p.social_links || [];
    refreshSocial((window as any).__wallSocialLinks);
    // Render pinned templates
    const pinBox = $("profile-pinned");
    if (pinBox) {
      const pins = p.pinned_templates || [];
      if (!pins.length) {
        pinBox.innerHTML = `<div style="color:var(--sub);padding:6px">No pinned templates yet — pin from Templates tab.</div>`;
      } else {
        pinBox.innerHTML = pins
          .map(
            (tp: any) =>
              `<div style="text-align:center"><img src="${Backend.base}/v2/templates/${encodeURIComponent(tp.id)}/preview?size=64" style="width:48px;height:48px;border:1px solid #888;cursor:pointer;image-rendering:pixelated" data-load-tpl="${(tp.share || "").replace(/"/g, "&quot;")}" data-unpin="${tp.id}" title="${(tp.name || "").replace(/[<>"]/g, "")}"><br><span class="sub" style="font-size:10px">${(tp.name || "").slice(0, 12)}</span></div>`,
          )
          .join("");
        pinBox.querySelectorAll("[data-load-tpl]").forEach((b) => {
          b.addEventListener("click", (ev) => {
            if ((ev as MouseEvent).shiftKey) {
              const id = (b as HTMLElement).dataset.unpin;
              if (id) {
                confirmDlg("Unpin this template?", "Confirm").then((ok) => {
                  if (ok)
                    Backend.req("DELETE", `/v2/templates/${id}/pin`)
                      .then(() => syncProfile())
                      .catch(() => {});
                });
              }
            } else {
              importShare((b as HTMLElement).dataset.loadTpl || "");
            }
          });
        });
      }
    }
  });

  // Avatar
  $("avatar-upload")!.addEventListener("change", (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    if (!Backend.on) {
      errorDlg("Connect to VAI-PROG backend first (Settings)");
      (e.target as HTMLInputElement).value = "";
      return;
    }
    const rd = new FileReader();
    rd.onload = async (ev) => {
      try {
        await Backend.setAvatar((ev.target as FileReader).result as string);
        toast(t("customAvatar"), "uploaded");
        syncProfile();
      } catch (err: any) {
        await errorDlg("Avatar upload failed: " + err.message);
      }
    };
    rd.readAsDataURL(f);
  });
  $("btn-avatar-reset")!.addEventListener("click", () => resetAvatar());
  $("btn-avatar-refresh-discord")?.addEventListener("click", async () => {
    const me = getMe();
    if (!me || !me.discord_id) {
      await errorDlg("No Discord ID linked");
      return;
    }
    try {
      await fetch(
        `${cfg.backendUrl}/discord/avatar/cache?userId=${encodeURIComponent(me.discord_id)}`,
        { method: "DELETE" },
      );
      toast("Discord", "cache cleared");
      // Bust browser cache of any visible discord-avatar images by updating
      // the `ts` query param WITHOUT dropping `userId` (that's why the old
      // .split("?")[0] approach produced /api/discord/avatar?ts=… with no id).
      document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
        try {
          if (!img.src.includes("/discord/avatar")) return;
          const u = new URL(img.src, location.origin);
          u.searchParams.set("ts", String(Date.now()));
          img.src = u.toString();
        } catch (e) {
          log("AVATAR", "WARN", "URL update failed: " + e);
        }
      });
      syncProfile();
    } catch (e: any) {
      await errorDlg("Failed: " + errMsg(e));
    }
  });

  // Profile economy section
  document.addEventListener("wd:paint-changed", updateProfilePaintLine);
  setTimeout(updateProfilePaintLine, 1500);

  $("btn-profile-refresh-balance")?.addEventListener("click", () => {
    updateProfileBalance().catch(() => {});
  });

  const profileRefresh = () => {
    updatePaintCurrent();
    updateProfilePaintLine();
    updateProfileBalance().catch(() => {});
  };
  wireSellButton("btn-profile-sell-all", "all", profileRefresh);
  wireSellButton("btn-profile-sell-some", "prompt", profileRefresh);

  $("btn-profile-shop")?.addEventListener("click", () => {
    if (!openCursorShop()) {
      toast("Cursor shop", t("profileShopMissed"));
    }
  });

  // Lazy-refresh balance once when the user opens the Profile tab. We do not
  // poll — coin balance only changes after explicit user actions (selling
  // cans, claiming a cursor), and any of those is followed by a refresh
  // here too.
  document.addEventListener("wd:tab-open-pr", () => {
    updateProfileBalance().catch(() => {});
  });
  // Also pull it once on boot so the first open of the tab paints with data.
  setTimeout(() => updateProfileBalance().catch(() => {}), 3000);
}
