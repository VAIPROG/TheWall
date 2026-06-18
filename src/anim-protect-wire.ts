/**
 * UI wiring for the Animation and Region-protection groups (Overlay pane).
 * Kept out of ui-wire.ts so the two features stay self-contained: this file
 * owns every handler behind the `anim-*` / `protect-*` element ids that
 * ui-build.ts renders.
 */
import { $, errMsg, noteBox, listRow, growLabel, miniBtn } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { t } from "./i18n";
import { cfg, saveCfg } from "./config";
import { promptDlg, errorDlg, infoDlg } from "./dialog";
import {
  overlayData,
  getOverlayAnimation,
  getOverlayAnimRuntime,
  setOverlayAnimation,
} from "./overlay";
import { autoSplitSheet } from "./animated-template";
import {
  WALL_ANIM_FORMAT,
  fromCharity,
  type GridOrder,
  type ScalingMode,
  type SheetLayoutKind,
  type WallAnimConfig,
} from "./wall-anim";
import { exportToWallDevJson, applyWallDevExport } from "./walldev-config";
import { exportToCharityConfig } from "./charity-import";
import { Backend } from "./backend";
import { importShare } from "./share";
import {
  loadTemplates,
  loadPublicTemplates,
  loadMyTemplates,
  setAnimRowsAppender,
} from "./data";
import {
  captureRegion,
  captureTemplateRegion,
  listProtectedRegions,
  removeProtectedRegion,
  verifyAllRegions,
  startProtectionWatch,
  stopProtectionWatch,
} from "./protect";

const num = (id: string): number => {
  const el = $(id) as HTMLInputElement | null;
  const v = el ? parseFloat(el.value) : NaN;
  return Number.isFinite(v) ? v : 0;
};
const sel = (id: string): string => ($(id) as HTMLSelectElement | null)?.value ?? "";

async function copyToClipboard(label: string, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, "copied to clipboard");
  } catch {
    await infoDlg(label, text);
  }
}

/** First active clan id of the current user, for clan-scoped publishing. */
async function myClanId(): Promise<string | null> {
  try {
    const clans: any[] = await Backend.req("GET", "/v2/clans/mine");
    return clans?.[0]?.id ?? null;
  } catch {
    return null;
  }
}

/* ----------------------------- animation -------------------------------- */

function updateAnimStatus(): void {
  const elStatus = $("anim-status");
  if (!elStatus) return;
  const rt = getOverlayAnimRuntime();
  if (!rt) {
    elStatus.textContent = t("animStatusOff");
    return;
  }
  const frame = rt.frameAt(Date.now());
  elStatus.textContent =
    `${rt.name} · ${rt.kind} · frame ${frame + 1}/${rt.frameCount} ` +
    `(${rt.frameWidth}×${rt.frameHeight})`;
}

/** Fill the advanced fields from the active animation (or sheet defaults). */
function syncAnimFields(): void {
  const src = getOverlayAnimation();
  const cfgA = src
    ? src.kind === "wall-anim"
      ? src.config
      : fromCharity(src.template)
    : null;
  const set = (id: string, v: string | number) => {
    const el = $(id) as HTMLInputElement | null;
    if (el) el.value = String(v);
  };
  if (cfgA) {
    set("anim-frame-w", cfgA.sheet.frameWidth);
    set("anim-frame-h", cfgA.sheet.frameHeight);
    set("anim-frame-count", cfgA.sheet.frameCount);
    set("anim-frame-ms", cfgA.timing.defaultFrameMs);
    ($("anim-layout") as HTMLSelectElement).value = cfgA.sheet.layout;
    ($("anim-order") as HTMLSelectElement).value = cfgA.sheet.order;
    ($("anim-scaling") as HTMLSelectElement).value = cfgA.scaling.mode;
    ($("anim-looping") as HTMLInputElement).checked = cfgA.timing.looping;
  } else if (overlayData.origW && overlayData.origH) {
    set("anim-frame-w", overlayData.origW);
    set("anim-frame-h", overlayData.origH);
    set("anim-frame-count", 1);
  }
}

/** Build a WallAnimConfig from the advanced fields + current overlay. */
function configFromFields(startTime?: number): WallAnimConfig | null {
  if (!overlayData.srcOrig) {
    void errorDlg("load a template image first");
    return null;
  }
  const prev = getOverlayAnimation();
  const prevCfg =
    prev?.kind === "wall-anim" ? prev.config : prev ? fromCharity(prev.template) : null;
  return {
    format: WALL_ANIM_FORMAT,
    name: prevCfg?.name ?? "Untitled",
    sources: [overlayData.srcOrig],
    x: overlayData.x,
    y: overlayData.y,
    sheet: {
      frameWidth: Math.max(1, Math.round(num("anim-frame-w"))),
      frameHeight: Math.max(1, Math.round(num("anim-frame-h"))),
      frameCount: Math.max(1, Math.round(num("anim-frame-count"))),
      layout: (sel("anim-layout") as SheetLayoutKind) || "grid",
      order: (sel("anim-order") as GridOrder) || "row",
    },
    timing: {
      startTime: startTime ?? prevCfg?.timing.startTime ?? 0,
      defaultFrameMs: Math.max(50, num("anim-frame-ms") || 1000),
      looping: ($("anim-looping") as HTMLInputElement)?.checked ?? true,
      frames: prevCfg?.timing.frames,
    },
    scaling: {
      mode: (sel("anim-scaling") as ScalingMode) || "native",
      scale: cfg.overlayScale || 1,
    },
  };
}

function applyFromFields(startTime?: number): void {
  const c = configFromFields(startTime);
  if (!c) return;
  setOverlayAnimation(c.sheet.frameCount > 1 ? { kind: "wall-anim", config: c } : null);
  updateAnimStatus();
}

async function uploadAnimConfig(): Promise<void> {
  const env = exportToWallDevJson({});
  if (!env.template.animation) {
    await errorDlg("no active animation — apply one first");
    return;
  }
  const scope = sel("anim-share-scope") || "private";
  const pass = (($("anim-share-pass") as HTMLInputElement)?.value ?? "").trim();
  const body: any = {
    name: env.template.name || "Untitled animation",
    config: env,
    scope,
  };
  if (scope === "clan") {
    body.clan_id = await myClanId();
    if (!body.clan_id) {
      await errorDlg("no active clan membership");
      return;
    }
  }
  if (pass) body.access_password = pass;
  try {
    const row: any = await Backend.createAnimTemplate(body);
    toast(t("animLegend"), `uploaded "${row.name}" (${row.scope})`);
    // Password-shared config → hand the user a ready-to-send access code.
    // Recipient pastes it (plus the password) into "Load by code" on their
    // Share tab; the password alone unlocks even private scope.
    if (pass && row?.id) {
      await copyToClipboard(t("animByCodeLegend"), String(row.id));
      await infoDlg(
        `${t("animShareCodeReady")}\n\nID: ${row.id}\n${t("animSharePass")}: ${pass}`,
        t("animPublishLegend"),
      );
    }
    if (scope === "clan") void loadTemplates(true);
    else if (scope === "private") void loadMyTemplates(true);
    else void loadPublicTemplates(true);
  } catch (e: any) {
    await errorDlg("upload failed: " + errMsg(e));
  }
}

async function browseAnimConfigs(): Promise<void> {
  const list = $("anim-shared-list");
  if (!list) return;
  list.innerHTML = noteBox(t("syncing"));
  let rows: any[] = [];
  try {
    rows = await Backend.listAnimTemplates();
  } catch (e) {
    list.innerHTML = noteBox("load failed: " + errMsg(e), "err");
    return;
  }
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = noteBox("(nothing shared yet)");
    return;
  }
  for (const r of rows.slice(0, 30)) {
    const row = listRow();
    row.append(
      growLabel(`${r.name} · ${r.scope}`),
      miniBtn(t("load"), () => {
        applyWallDevExport(r.config)
          .then(() => updateAnimStatus())
          .catch((e) => errorDlg("apply failed: " + errMsg(e)));
      }),
    );
    list.appendChild(row);
  }
}

/* ------------------------------ protection ------------------------------- */

function regionStateLabel(r: any): string {
  if (r.status === "pending") return "🕓 pending";
  if (r.status === "rejected") return "🚫 rejected";
  return r.last_ok ? "🟢 ok" : `🔴 ${Number(r.last_broken_pct).toFixed(1)}%`;
}

function protectRow(
  label: string,
  state: string,
  actions: Array<{ text: string; title?: string; onClick: () => void }>,
): HTMLElement {
  const row = listRow();
  const st = document.createElement("span");
  st.style.cssText = "white-space:nowrap";
  st.textContent = state;
  row.append(growLabel(label), st);
  for (const a of actions) row.appendChild(miniBtn(a.text, a.onClick, a.title));
  return row;
}

/**
 * Three separate lists, Templates-tab style:
 *   global — backend scope 'public'
 *   clan   — backend scope 'clan'
 *   local  — device-local captures (protect.ts) + backend scope 'private'
 */
async function renderProtectLists(): Promise<void> {
  const elGlobal = $("protect-list-global");
  const elClan = $("protect-list-clan");
  const elLocal = $("protect-list-local");
  if (!elGlobal || !elClan || !elLocal) return;
  elGlobal.innerHTML = "";
  elClan.innerHTML = "";
  elLocal.innerHTML = "";

  const empty = (el: HTMLElement, msg: string) => {
    if (!el.childElementCount) {
      el.innerHTML = `<div style="padding:6px;color:var(--sub)">${msg}</div>`;
    }
  };

  // Device-local captures first — they work offline.
  for (const r of listProtectedRegions()) {
    elLocal.appendChild(
      protectRow(`💾 ${r.name}`, `tol ${r.tolerancePct}%`, [
        {
          text: "✕",
          title: "remove local capture",
          onClick: () => {
            removeProtectedRegion(r.id);
            void renderProtectLists();
          },
        },
      ]),
    );
  }

  if (Backend.on) {
    try {
      const rows: any[] = await Backend.listRegions();
      for (const r of rows) {
        const actions: Array<{ text: string; title?: string; onClick: () => void }> = [];
        if (r.status === "pending") {
          // Server enforces approver rights; the button just offers the action.
          actions.push({
            text: "✓",
            title: "approve (clan mods / global admins)",
            onClick: () => {
              Backend.approveRegion(r.id)
                .then(() => renderProtectLists())
                .catch((e: any) => errorDlg("approve failed: " + errMsg(e)));
            },
          });
        }
        actions.push({
          text: "✕",
          title: "delete (owner / clan admin)",
          onClick: () => {
            Backend.deleteRegion(r.id)
              .then(() => renderProtectLists())
              .catch((e: any) => errorDlg("delete failed: " + errMsg(e)));
          },
        });
        const row = protectRow(r.name, regionStateLabel(r), actions);
        if (r.scope === "public") elGlobal.appendChild(row);
        else if (r.scope === "clan") elClan.appendChild(row);
        else elLocal.appendChild(row); // private
      }
    } catch (e) {
      const err = noteBox("backend: " + errMsg(e), "err");
      elGlobal.innerHTML = err;
      elClan.innerHTML = err;
    }
  } else {
    empty(elGlobal, "backend offline");
    empty(elClan, "backend offline");
  }
  empty(elGlobal, "(no global regions)");
  empty(elClan, "(no clan regions)");
  empty(elLocal, "(nothing captured yet)");
}

async function fixRegion(zone: boolean): Promise<void> {
  const tolerancePct = Math.max(0, Math.min(100, num("protect-tolerance")));
  const scope = sel("protect-scope") || "local";

  let region;
  if (zone) {
    const ask = async (label: string): Promise<number | null> => {
      const v = await promptDlg(`${t("protectFixZone")} — ${label}`, "");
      if (v === null) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    };
    const x = await ask("X");
    if (x === null) return;
    const y = await ask("Y");
    if (y === null) return;
    const w = await ask("W");
    if (w === null || w <= 0) return;
    const h = await ask("H");
    if (h === null || h <= 0) return;
    region = await captureRegion(x, y, w, h, { tolerancePct });
  } else {
    region = await captureTemplateRegion({ tolerancePct });
  }
  if (!region) return;

  // Non-local scopes also publish to the backend so the server-side guard
  // watches the region around the clock (approval per scope applies).
  if (scope !== "local" && Backend.on) {
    const body: any = {
      name: region.name,
      x: region.x,
      y: region.y,
      w: region.w,
      h: region.h,
      tolerance_pct: region.tolerancePct,
      ref_png: region.refPng,
      scope,
    };
    if (scope === "clan") {
      body.clan_id = await myClanId();
      if (!body.clan_id) {
        await errorDlg("no active clan membership — kept local only");
        await renderProtectLists();
        return;
      }
    }
    try {
      const row: any = await Backend.createRegion(body);
      toast(
        t("protectLegend"),
        row.status === "pending" ? "uploaded — awaiting approval" : "uploaded & guarded",
      );
    } catch (e: any) {
      await errorDlg("backend upload failed (kept local): " + errMsg(e));
    }
  }
  await renderProtectLists();
}

/* --------------------- Templates tab: animated rows ----------------------- */

/**
 * Appends animated-config rows of ONE scope to a Templates-tab list box,
 * below the classic rows data.ts just rendered: preview thumbnail (first
 * frame, served by the backend), name + status, load / approve / delete.
 * Registered with data.ts via setAnimRowsAppender — the per-block "hide
 * animated" checkboxes decide whether the hook fires at all.
 */
async function appendAnimRows(
  list: HTMLElement,
  scope: "public" | "clan" | "private",
): Promise<void> {
  if (!Backend.on) return;
  let rows: any[] = [];
  try {
    rows = ((await Backend.listAnimTemplates()) || []) as any[];
  } catch {
    return; // classic rows are already on screen; a failed anim fetch stays quiet
  }
  rows = rows.filter((r) => r.scope === scope);
  const reload = () => {
    if (scope === "clan") void loadTemplates(true);
    else if (scope === "private") void loadMyTemplates(true);
    else void loadPublicTemplates(true);
  };
  for (const r of rows.slice(0, 40)) {
    const row = listRow();
    const img = document.createElement("img");
    img.src = `${Backend.base}/v2/animated/templates/${encodeURIComponent(r.id)}/preview?size=64`;
    img.style.cssText =
      "width:32px;height:32px;image-rendering:pixelated;border:1px solid var(--shadow);background:#808080;flex:0 0 32px";
    img.loading = "lazy";
    const frames = r.config?.template?.animation?.sheet?.frameCount;
    const name = growLabel(
      `🎞 ${r.pinned ? "📌 " : ""}${r.name}${frames ? ` · ${frames}f` : ""}`,
      `${r.scope} · ${r.status}`,
    );
    const badge = document.createElement("span");
    badge.style.cssText = "white-space:nowrap;font-size:10px;color:var(--sub)";
    badge.textContent = r.status === "pending" ? "🕓" : r.status === "rejected" ? "🚫" : "anim";
    row.append(img, name, badge);
    row.appendChild(
      miniBtn(t("load"), () => {
        applyWallDevExport(r.config)
          .then(() => {
            updateAnimStatus();
            toast(t("animTplList"), `"${r.name}" applied`);
          })
          .catch((e) => errorDlg("apply failed: " + errMsg(e)));
      }),
    );
    if (r.status === "pending") {
      row.appendChild(
        miniBtn(
          "✓",
          () => {
            Backend.req("POST", `/v2/animated/templates/${encodeURIComponent(r.id)}/approve`)
              .then(reload)
              .catch((e) => errorDlg("approve failed: " + errMsg(e)));
          },
          "approve (clan mods / global admins)",
        ),
      );
    }
    row.appendChild(
      miniBtn(
        "✕",
        () => {
          Backend.deleteAnimTemplate(r.id)
            .then(reload)
            .catch((e) => errorDlg("delete failed: " + errMsg(e)));
        },
        "delete (owner / clan mod)",
      ),
    );
    list.appendChild(row);
  }
}

/** Share-tab "load by code": fetch one shared template by id (+ optional
 *  password) and apply it. The id alone doesn't say whether it's a classic
 *  template or an animated config — they live in different tables — so we
 *  try classic first (cheaper payload), then animated. */
async function loadSharedByCode(): Promise<void> {
  const raw = (($("anim-shared-code") as HTMLInputElement)?.value ?? "").trim();
  const pass = (($("anim-shared-code-pass") as HTMLInputElement)?.value ?? "").trim();
  if (!raw) {
    await errorDlg(t("animByCodePlaceholder"));
    return;
  }
  // Accept a bare uuid, a `walldev-anim://id` link, or a full shared URL.
  const m = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) {
    await errorDlg("no template id found in the input");
    return;
  }
  try {
    const r: any = await Backend.sharedTemplate(m[0], pass || undefined);
    importShare(r.share);
    toast(t("sharePublishLegend"), `"${r.name}" loaded`);
    return;
  } catch {
    // Not a classic template (or not visible as one) — try animated.
  }
  try {
    const r: any = await Backend.sharedAnimTemplate(m[0], pass || undefined);
    await applyWallDevExport(r.config);
    updateAnimStatus();
    toast(t("animPublishLegend"), `"${r.name}" loaded`);
  } catch (e: any) {
    await errorDlg("load failed: " + errMsg(e));
  }
}

/* -------------------------------- wiring --------------------------------- */

export function wireAnimAndProtect(): void {
  // Templates tab: animated rows render inside the per-scope lists that
  // data.ts owns — register the appender + wire the per-block filters.
  setAnimRowsAppender(appendAnimRows);
  $("cfg-hide-anim-pub")?.addEventListener("change", (e: Event) => {
    cfg.hideAnimatedPub = (e.target as HTMLInputElement).checked;
    saveCfg();
    void loadPublicTemplates(true);
  });
  $("cfg-hide-anim-clan")?.addEventListener("change", (e: Event) => {
    cfg.hideAnimatedClan = (e.target as HTMLInputElement).checked;
    saveCfg();
    void loadTemplates(true);
  });
  $("cfg-hide-anim-mine")?.addEventListener("change", (e: Event) => {
    cfg.hideAnimatedMine = (e.target as HTMLInputElement).checked;
    saveCfg();
    void loadMyTemplates(true);
  });
  $("btn-reload-my-tpl")?.addEventListener("click", () => void loadMyTemplates(true));
  // Share tab: load a shared animated config by id/link + password.
  $("btn-anim-load-shared")?.addEventListener("click", () => void loadSharedByCode());
  // Animation.
  $("btn-anim-advanced")?.addEventListener("click", () => {
    const wrap = $("anim-advanced-wrap");
    if (!wrap) return;
    const open = wrap.style.display !== "none";
    wrap.style.display = open ? "none" : "";
    if (!open) syncAnimFields();
  });
  $("btn-anim-stop")?.addEventListener("click", () => {
    setOverlayAnimation(null);
    updateAnimStatus();
  });
  $("btn-anim-apply")?.addEventListener("click", () => applyFromFields());
  $("btn-anim-start-now")?.addEventListener("click", () => applyFromFields(Date.now()));
  $("btn-anim-autosplit")?.addEventListener("click", async () => {
    const w = overlayData.origW;
    const h = overlayData.origH;
    if (!w || !h) {
      await errorDlg("load a sheet image first");
      return;
    }
    const v = await promptDlg(t("animAutosplit"), String(Math.max(2, num("anim-frame-count") || 2)));
    if (v === null) return;
    const count = parseInt(v, 10);
    const layouts = autoSplitSheet(w, h, Number.isFinite(count) && count > 1 ? { frameCount: count } : {});
    if (!layouts.length) {
      await errorDlg("no clean grid found for this sheet/count");
      return;
    }
    const best = layouts[0];
    ($("anim-frame-w") as HTMLInputElement).value = String(best.frameWidth);
    ($("anim-frame-h") as HTMLInputElement).value = String(best.frameHeight);
    ($("anim-frame-count") as HTMLInputElement).value = String(best.frameCount);
    toast(t("animAutosplit"), `${best.cols}×${best.rows} of ${best.frameWidth}×${best.frameHeight} (waste ${best.waste})`);
  });
  $("btn-anim-export-walldev")?.addEventListener("click", () => {
    void copyToClipboard("the-wall-dev JSON", JSON.stringify(exportToWallDevJson({}), null, 2));
  });
  $("btn-anim-export-charity")?.addEventListener("click", () => {
    void copyToClipboard("Charity JSON", JSON.stringify(exportToCharityConfig({}), null, 4));
  });
  $("btn-anim-upload")?.addEventListener("click", () => void uploadAnimConfig());
  $("btn-anim-browse")?.addEventListener("click", () => void browseAnimConfigs());

  // Lightweight status refresher — one cheap frameAt() per second, only
  // while an animation is active.
  window.setInterval(() => {
    if (getOverlayAnimRuntime()) updateAnimStatus();
  }, 1000);
  updateAnimStatus();

  // Protection.
  $("btn-protect-template")?.addEventListener("click", () => void fixRegion(false));
  $("btn-protect-zone")?.addEventListener("click", () => void fixRegion(true));
  $("btn-protect-verify")?.addEventListener("click", async () => {
    const reports = await verifyAllRegions();
    const broken = reports.filter((r) => !r.verdict.ok).length;
    toast(t("protectLegend"), broken ? `${broken} region(s) BROKEN` : "all regions intact");
    await renderProtectLists();
  });
  $("btn-protect-refresh")?.addEventListener("click", () => void renderProtectLists());
  $("protect-watch")?.addEventListener("change", (e: Event) => {
    if ((e.target as HTMLInputElement).checked) startProtectionWatch();
    else stopProtectionWatch();
  });

  void renderProtectLists();
  log("UI", "OK", "animation + protection wired");
}
