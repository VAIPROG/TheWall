import { cfg, saveCfg, loadCfg, resetCfg } from "./config";
import {
  WS_HOST,
  WINDOW_MIN_WIDTH_PX,
  WINDOW_MIN_HEIGHT_PX,
  WINDOW_MAX_WIDTH_PX,
  WINDOW_MAX_HEIGHT_PX,
} from "./constants";
import { $, esc, errMsg } from "./helpers";
import { ic, achIcon as achIconHelper } from "./icons";
import { t } from "./i18n";
import { toast } from "./notify";
import { setActiveColor } from "./palette";
import { importShare } from "./share";
import { applyTheme, applyUiScale, applyCozy } from "./theme";
import { applyCursorMode } from "./cursors";
import { WallEvents } from "./events";
import { Backend, getMe, setMe } from "./backend";
import { downloadWallSnapshot } from "./snapshot";
import { mountReopener } from "./reopen";
import {
  initEmotes,
  getEmoteMap,
  getEmotesGrouped,
  reloadEmotes,
} from "./emoji";
import { wireMailUI, loadMail } from "./mail";
import {
  loadTemplates,
  loadPublicTemplates,
  loadRoster,
  shareCurrentTemplate,
  markAllRead,
  loadClanChat,
  loadAnnouncements,
  loadRemoteI18n,
  syncProfile,
  refreshNotifications,
  backendConnect,
  resetAvatar,
} from "./data";
import {
  loadAdminUsers,
  loadModApps,
  loadAdminTemplates,
  loadAdminNotifs,
} from "./admin-ui";
import { manualCheck, skipVersion, cmpVersion } from "./update-check";
import { VERSION } from "./constants";
import { promptDlg, confirmDlg, errorDlg, infoDlg, openDialog } from "./dialog";
import { log } from "./log";
import {
  recheckMine,
  listMine,
} from "./achievements";
import { runSellAll, runSellPrompt } from "./sell-all";
import { getPaintInfo } from "./paint-state";
import { playPaintRefillSound } from "./paint-sound";
import { fetchCoinBalance } from "./site-api";
import { openCursorShop } from "./open-cursor-shop";
import { wireAnimAndProtect } from "./anim-protect-wire";
import { wireLinks } from "./links-wire";
import { pluralize } from "./i18n";
import { wireAdmin, wireChats, wireOverlay, wireShare } from "./ui";

export function wireUI(win: HTMLElement): void {
  // Animation + region-protection groups live in their own wiring module.
  wireAnimAndProtect();
  wireLinks();
  // tab switching
  win.querySelectorAll(".wp-tab").forEach((tab) =>
    tab.addEventListener("click", () => {
      win
        .querySelectorAll(".wp-tab")
        .forEach((x) => x.classList.remove("active"));
      win
        .querySelectorAll(".wp-pane")
        .forEach((x) => x.classList.remove("active"));
      tab.classList.add("active");
      win
        .querySelector(`.wp-pane[data-p="${(tab as HTMLElement).dataset.p}"]`)
        ?.classList.add("active");
      if ((tab as HTMLElement).dataset.p === "tp") {
        loadTemplates().catch(() => {});
        loadPublicTemplates().catch(() => {});
      }
      if ((tab as HTMLElement).dataset.p === "cl") {
        loadRoster().catch(() => {});
        loadClanChat().catch(() => {});
      }
      if ((tab as HTMLElement).dataset.p === "ad") {
        loadAdminUsers().catch(() => {});
        loadModApps().catch(() => {});
        loadAdminTemplates().catch(() => {});
        loadAdminNotifs().catch(() => {});
      }
      if ((tab as HTMLElement).dataset.p === "pr") {
        syncProfile().catch(() => {});
        refreshNotifications().catch(() => {});
        document.dispatchEvent(new CustomEvent("wd:tab-open-pr"));
      }
      if ((tab as HTMLElement).dataset.p === "ah") {
        // Achievements now live in their own tab so the Profile pane stays
        // focused on identity / coins / paint actions.
        loadAchievementList().catch(() => {});
      }
    }),
  );

  // draggable titlebar — accounts for CSS zoom on the window
  const bar = $("wp-drag")!;
  let dx = 0,
    dy = 0,
    drag = false;
  bar.addEventListener("mousedown", (e: Event) => {
    const me = e as MouseEvent;
    if ((me.target as HTMLElement).classList.contains("wp-tbtn")) return;
    drag = true;
    const zoom = parseFloat((win.style as any).zoom) || 1;
    const r = win.getBoundingClientRect();
    dx = (me.clientX - r.left) / zoom;
    dy = (me.clientY - r.top) / zoom;
    win.style.right = "auto";
    win.style.left = r.left / zoom + "px";
    win.style.top = r.top / zoom + "px";
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!drag) return;
    const zoom = parseFloat((win.style as any).zoom) || 1;
    win.style.left = e.clientX / zoom - dx + "px";
    win.style.top = e.clientY / zoom - dy + "px";
  });
  document.addEventListener("mouseup", () => (drag = false));

  // ----- Resize grip (bottom-right corner) ---------------------------------
  // Lets the user adjust the panel size between MIN and MAX limits defined in
  // constants.ts. The new size is persisted to cfg so it survives reloads.
  //
  // Careful: applyUiScale() sets `win.style.zoom`, which multiplies layout
  // sizes. `offsetWidth` returns the POST-zoom value, so naively saving
  // offsetWidth and reapplying via `style.width` on the next boot would
  // multiply the saved size by zoom each cycle (cumulative growth). We track
  // the un-zoomed values we just set in the move handler and save those
  // directly.
  const grip = $("wp-resize-handle");
  if (grip) {
    let rx = 0;
    let ry = 0;
    let rwBase = 0;
    let rhBase = 0;
    let currentW = 0;
    let currentH = 0;
    let rdrag = false;
    grip.addEventListener("mousedown", (e: Event) => {
      const me = e as MouseEvent;
      me.preventDefault();
      me.stopPropagation();
      rdrag = true;
      rx = me.clientX;
      ry = me.clientY;
      const zoom = parseFloat((win.style as any).zoom) || 1;
      // `offsetWidth` is post-zoom — bring it back to base pixels so our
      // deltas compose correctly.
      rwBase = win.offsetWidth / zoom;
      rhBase = win.offsetHeight / zoom;
      currentW = rwBase;
      currentH = rhBase;
    });
    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!rdrag) return;
      const zoom = parseFloat((win.style as any).zoom) || 1;
      const dw = (e.clientX - rx) / zoom;
      const dh = (e.clientY - ry) / zoom;
      currentW = Math.max(
        WINDOW_MIN_WIDTH_PX,
        Math.min(WINDOW_MAX_WIDTH_PX, rwBase + dw),
      );
      currentH = Math.max(
        WINDOW_MIN_HEIGHT_PX,
        Math.min(WINDOW_MAX_HEIGHT_PX, rhBase + dh),
      );
      win.style.width = currentW + "px";
      const content = win.querySelector(".wp-content") as HTMLElement | null;
      if (content) content.style.maxHeight = currentH - 60 + "px";
    });
    document.addEventListener("mouseup", () => {
      if (!rdrag) return;
      rdrag = false;
      cfg.windowWidth = Math.round(currentW);
      cfg.windowHeight = Math.round(currentH);
      saveCfg();
      log.ok(
        "UI",
        `resized to ${cfg.windowWidth}×${cfg.windowHeight} (base px)`,
      );
    });
  } else {
    log.warn("UI", "resize grip element not found");
  }

  // minimize / close
  $("wp-min")!.addEventListener("click", () =>
    win.classList.toggle("collapsed"),
  );
  $("wp-close")!.addEventListener("click", () => {
    win.style.display = "none";
    mountReopener();
  });

  // overlay tab
  wireOverlay(win);
  // share tab (import / export wiring)
  wireShare(win);

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
  $("cfg-unverified")!.addEventListener("change", async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.checked && !(await confirmDlg(t("unverifiedWarn")))) {
      target.checked = false;
      return;
    }
    cfg.showUnverified = target.checked;
    saveCfg();
    loadPublicTemplates();
  });
  $("cfg-unverified-clan")?.addEventListener("change", async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.checked && !(await confirmDlg(t("unverifiedWarn")))) {
      target.checked = false;
      return;
    }
    cfg.showUnverifiedClan = target.checked;
    saveCfg();
    loadTemplates();
  });
  $("btn-tpl-share")!.addEventListener("click", shareCurrentTemplate);

  // Manual reload buttons — bypass the 5-min cache, force a network round-trip.
  $("btn-reload-pub-tpl")?.addEventListener("click", () => {
    loadPublicTemplates(true).catch(() => {});
  });
  $("btn-reload-clan-tpl")?.addEventListener("click", () => {
    loadTemplates(true).catch(() => {});
  });

  /**
   * Live template-catalog search with a small structured DSL.
   *
   * Tokens (separated by whitespace, AND-combined — every token must match):
   *
   *   x:5569          coordinate exactly equals 5569
   *   x:100-500       coordinate in the inclusive range [100, 500]
   *   y:440           same, for y
   *   y:0-1000        same, for y range
   *   author:vai      substring match against the row's author field
   *   anything else   substring match against the row's name field
   *
   * Examples:
   *   `swarm`                     → name contains "swarm"
   *   `x:5569`                    → templates anchored at x=5569
   *   `x:5000-6000 y:0-500 vai`   → name~vai AND x∈[5000..6000] AND y∈[0..500]
   *   `author:vai swarm activity` → author~vai AND (name~swarm OR name~activity)*
   *
   *   *Plain-text terms are joined with AND too — every word must appear
   *    somewhere in the name. Use `name:multi word` if you need a literal
   *    multi-word match (not implemented yet, single-word terms cover the
   *    common case).
   *
   * The show-unverified checkboxes apply independently — the server
   * decides whether unverified rows even reach the DOM. The search just
   * filters whatever rows are currently visible.
   */
  type SearchToken =
    | { kind: "name"; q: string }
    | { kind: "author"; q: string }
    | { kind: "x" | "y"; min: number; max: number };

  const parseRange = (val: string): { min: number; max: number } | null => {
    const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(val);
    if (!m) return null;
    const a = Number(m[1]);
    if (m[2] === undefined) return { min: a, max: a };
    const b = Number(m[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  };

  const parseSearchQuery = (raw: string): SearchToken[] => {
    const out: SearchToken[] = [];
    // Split on whitespace; the DSL doesn't (yet) support quoted multi-word
    // values, so simple whitespace tokenisation is fine.
    for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
      const lower = tok.toLowerCase();
      if (lower.startsWith("x:") || lower.startsWith("y:")) {
        const axis = lower[0] as "x" | "y";
        const r = parseRange(lower.slice(2));
        if (r) {
          out.push({ kind: axis, min: r.min, max: r.max });
          continue;
        }
        // Malformed coord token — fall through and treat as a name match
        // so the user at least sees *something* (rather than empty list).
      }
      if (lower.startsWith("author:")) {
        const q = lower.slice("author:".length);
        if (q) out.push({ kind: "author", q });
        continue;
      }
      out.push({ kind: "name", q: lower });
    }
    return out;
  };

  /** Check one row against the parsed tokens (AND). */
  const rowMatchesTokens = (
    row: HTMLElement,
    tokens: SearchToken[],
  ): boolean => {
    if (tokens.length === 0) return true;
    const name = (row.dataset.tplName || "").toLowerCase();
    const author = (row.dataset.tplAuthor || "").toLowerCase();
    const x = Number(row.dataset.tplX || 0);
    const y = Number(row.dataset.tplY || 0);
    for (const tok of tokens) {
      switch (tok.kind) {
        case "name":
          if (!name.includes(tok.q)) return false;
          break;
        case "author":
          if (!author.includes(tok.q)) return false;
          break;
        case "x":
          if (x < tok.min || x > tok.max) return false;
          break;
        case "y":
          if (y < tok.min || y > tok.max) return false;
          break;
      }
    }
    return true;
  };

  const applyTplSearch = (): void => {
    const inp = $("tpl-search") as HTMLInputElement | null;
    const raw = inp?.value || "";
    const tokens = parseSearchQuery(raw);
    let shown = 0;
    let hidden = 0;
    for (const listId of ["pub-templates", "clan-templates"]) {
      const box = $(listId);
      if (!box) continue;
      box.querySelectorAll<HTMLElement>(".wp-li").forEach((row) => {
        if (rowMatchesTokens(row, tokens)) {
          row.style.display = "";
          shown += 1;
        } else {
          row.style.display = "none";
          hidden += 1;
        }
      });
    }
    log(
      "TPL_SEARCH",
      "INFO",
      `q="${raw}" tokens=${tokens.length} shown=${shown} hidden=${hidden}`,
    );
  };
  $("tpl-search")?.addEventListener("input", applyTplSearch);
  // Re-apply after re-renders too (reload buttons + initial loads). The
  // refresh handlers call loadTemplates/loadPublicTemplates which replace
  // the list HTML, so any stale display:none gets reset along with it.
  // Defer with a microtask so we run after the list innerHTML is in place.
  const tplObserver = new MutationObserver(() => {
    queueMicrotask(applyTplSearch);
  });
  const pubList = $("pub-templates");
  const clanList = $("clan-templates");
  if (pubList) tplObserver.observe(pubList, { childList: true });
  if (clanList) tplObserver.observe(clanList, { childList: true });

  // social tab
  // Wall snapshot — fetch every tile from ws.filianislost.com/tiles, stitch
  // onto a brick-background canvas, downscale to chosen quality, download PNG.
  $("btn-snapshot")!.addEventListener("click", () => {
    const sel = $("snapshot-quality") as HTMLSelectElement | null;
    const q = (sel?.value || "high") as "low" | "medium" | "high";
    downloadWallSnapshot(q);
  });

  // profile tab
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

  // mail tab
  wireMailUI();
  wireChats(win);
  // Load mail when user clicks the mail tab
  document.querySelectorAll('.wp-tab[data-p="ma"]').forEach((b) => {
    b.addEventListener("click", () => loadMail());
  });

  // settings tab
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
  $("cfg-backend-url")!.addEventListener("change", (e: Event) => {
    cfg.backendUrl = (e.target as HTMLInputElement).value.trim();
    saveCfg();
  });
  $("btn-backend-connect")!.addEventListener("click", backendConnect);
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

  // update checker
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

  wireAdmin(win);

  // ------- Paint helpers: refill toggle, current paint display, sell-all -------
  const updatePaintCurrent = (): void => {
    const el = $("paint-current");
    if (!el) return;
    const info = getPaintInfo();
    if (info.px <= 0) {
      el.textContent = t("paintCurrentNone");
      return;
    }
    // Canonical can count from paint-state (Math.ceil(px / PAINT_PER_CAN)).
    // Using info.totalCans guarantees this matches what the sell dialog
    // computes — they used to diverge when window.player was exposed.
    const cans = info.totalCans;
    const cansLabel = pluralize(cans, "paintCan");
    el.textContent = t("paintCurrentLine", { px: info.px, cans, cansLabel });
  };
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
  const wireSellButton = (id: string, mode: "all" | "prompt"): void => {
    $(id)?.addEventListener("click", async () => {
      const btn = $(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      try {
        if (mode === "all") await runSellAll();
        else await runSellPrompt();
        updatePaintCurrent();
        updateProfileBalance().catch(() => {});
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  };
  wireSellButton("btn-sell-all", "all");
  wireSellButton("btn-sell-some", "prompt");

  // -------- Profile pane: paint + coin balance + sell-all -------------------
  const updateProfilePaintLine = (): void => {
    const el = $("profile-paint");
    if (!el) return;
    const info = getPaintInfo();
    if (info.px <= 0) {
      el.textContent = t("profilePaintEmpty");
      return;
    }
    // Canonical can count from paint-state (Math.ceil(px / PAINT_PER_CAN)).
    // Using info.totalCans guarantees this matches what the sell dialog
    // computes — they used to diverge when window.player was exposed.
    const cans = info.totalCans;
    const cansLabel = pluralize(cans, "paintCan");
    el.textContent = t("profilePaintAmount", { px: info.px, cans, cansLabel });
  };
  document.addEventListener("wd:paint-changed", updateProfilePaintLine);
  setTimeout(updateProfilePaintLine, 1500);

  const updateProfileBalance = async (): Promise<void> => {
    const el = $("profile-coins");
    if (!el) return;
    const coins = await fetchCoinBalance();
    if (coins === null) {
      el.textContent = t("profileCoinsUnknown");
      return;
    }
    el.textContent = t("profileCoinsAmount", { coins: Math.floor(coins) });
  };

  $("btn-profile-refresh-balance")?.addEventListener("click", () => {
    updateProfileBalance().catch(() => {});
  });

  const wireProfileSellBtn = (id: string, mode: "all" | "prompt"): void => {
    $(id)?.addEventListener("click", async () => {
      const btn = $(id) as HTMLButtonElement | null;
      if (btn) btn.disabled = true;
      try {
        if (mode === "all") await runSellAll();
        else await runSellPrompt();
        updatePaintCurrent();
        updateProfilePaintLine();
        updateProfileBalance().catch(() => {});
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  };
  wireProfileSellBtn("btn-profile-sell-all", "all");
  wireProfileSellBtn("btn-profile-sell-some", "prompt");

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

  // backend meta
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

  // account deletion
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

// ---------------------------------------------------------------------------
// Achievement list (Profile pane)
// ---------------------------------------------------------------------------

const ACH_CATEGORY_KEYS: Record<string, string> = {
  general: "achCategoryGeneral",
  pixels: "achCategoryPixels",
  templates: "achCategoryTemplates",
  clan: "achCategoryClan",
  social: "achCategorySocial",
  tools: "achCategoryTools",
  time: "achCategoryTime",
  easter: "achCategoryEaster",
};

// Render a small SVG medallion (24px) from icons.ts for each row. The
// previous emoji-based map has been replaced — see achIcon() in icons.ts.
function renderAchIcon(name: string): string {
  return achIconHelper(name, 24);
}

async function loadAchievementList(): Promise<void> {
  const list = $("ach-list");
  const summary = $("ach-summary");
  if (!list) return;

  const all = await listMine();
  if (!all.length) {
    list.innerHTML = `<div style="padding:6px;color:var(--sub)">${esc(t("achLocked"))}</div>`;
    if (summary) summary.textContent = "";
    return;
  }

  const unlocked = all.filter((a) => a.unlocked_at);
  const totalPts = unlocked.reduce((s, a) => s + a.points, 0);
  if (summary) {
    summary.textContent =
      t("achUnlockedCount", {
        got: String(unlocked.length),
        all: String(all.length),
      }) +
      " · " +
      t("achTotalPoints", { n: String(totalPts), label: t("achPoints") });
  }

  // Group by category
  const byCat = new Map<string, typeof all>();
  for (const a of all) {
    const arr = byCat.get(a.category) || [];
    arr.push(a);
    byCat.set(a.category, arr);
  }

  let html = "";
  for (const [cat, items] of byCat) {
    const catLabel = t(ACH_CATEGORY_KEYS[cat] || "achCategoryGeneral");
    html += `<div style="font-weight:bold;font-size:10px;color:var(--sub);margin:6px 0 2px;text-transform:uppercase;letter-spacing:.5px">${esc(catLabel)}</div>`;
    for (const a of items) {
      const got = !!a.unlocked_at;
      const icon = renderAchIcon(a.icon);
      const opacity = got ? "1" : "0.35";
      const name = got
        ? esc(a.name)
        : a.secret
          ? esc(t("achSecret"))
          : esc(a.name);
      const desc = got
        ? esc(a.description)
        : a.secret
          ? "???"
          : esc(a.description);
      const pts = `<span style="margin-left:auto;font-size:9px;color:var(--sub)">${a.points} ${esc(t("achPoints"))}</span>`;
      const dateStr = a.unlocked_at
        ? `<span style="font-size:9px;color:var(--sub);margin-left:6px">${new Date(a.unlocked_at).toLocaleDateString()}</span>`
        : "";
      html += `<div style="display:flex;align-items:center;gap:8px;padding:4px 6px;opacity:${opacity};border-bottom:1px solid rgba(128,128,128,.15)">
        <span style="flex:none;width:24px;height:24px;display:flex;align-items:center;justify-content:center">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:bold;font-size:11px">${name}${dateStr}</div>
          <div style="font-size:10px;color:var(--sub);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${desc}</div>
        </div>
        ${pts}
      </div>`;
    }
  }
  list.innerHTML = html;
}

// pickCharityTemplate removed — generic pickLayer() in overlay-share-dialogs.ts
// now handles all multi-template selection for any WallTemplateSet.
