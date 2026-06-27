import { cfg } from "../config";
import { SITE } from "../constants";
import { $, errMsg } from "../helpers";
import { ic } from "../icons";
import { t } from "../i18n";
import { toast } from "../notify";
import { errorDlg, infoDlg, promptDlg, confirmDlg } from "../dialog";
import { overlayData } from "../overlay";
import { insertTemplate } from "../template-insert";
import { importShare, genShare } from "../share";
import { applyParsedJson } from "../url-autoload";
import { getMe, Backend } from "../backend";
import { fetchCharityConfig } from "../charity-import";
import { openExportOptionsDialog, pickLayer } from "../overlay-share-dialogs";
import { applyLayer } from "../formats/apply-layer";
import { encode } from "../formats/shared/format-registry";
import { exportCurrentOverlay } from "../walldev-config";
import { log } from "../log";
import { applyScalePct } from "./overlay-tab";

export function wireShare(win: HTMLElement): void {
  // Legacy share-hub controls — kept null-safe because the elements have
  // been moved into the Share tab and the corresponding Overlay-tab inputs
  // no longer exist. The current home for these flows is the Share tab
  // wiring further below.
  $("btn-import")?.addEventListener("click", () => {
    const v = ($("sharelink-input") as HTMLInputElement | null)?.value;
    if (v) importShare(v);
  });
  $("btn-share")?.addEventListener("click", () => genShare());
  // Tiny convenience button on Overlay tab → jump to Share tab without
  // making the user hunt for the new label.
  $("btn-jump-share")?.addEventListener("click", () => {
    const t = win.querySelector<HTMLElement>('.wp-tab[data-p="sh"]');
    t?.click();
  });

  // ----- Charity import (Bluemarble-style JSON config) ----------------------
  $("btn-charity-fetch")?.addEventListener("click", async () => {
    const urlInput = $("charity-url") as HTMLInputElement | null;
    const url = urlInput?.value.trim();
    if (!url) {
      await errorDlg("Paste a Charity config URL first");
      return;
    }
    const btn = $("btn-charity-fetch") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "…";
    }
    try {
      const charityCfg = await fetchCharityConfig(url);
      if (charityCfg.templates.length === 0) {
        await errorDlg(
          "Config parsed but contains no templates with image sources.",
        );
        return;
      }
      // Decode into a canonical set and use the generic layer picker.
      const { decodeCharity } = await import("../formats/charity/decode");
      const charitySet = decodeCharity(charityCfg as any);
      if (!charitySet.layers[0]) {
        await errorDlg("Config parsed but no usable templates.");
        return;
      }
      const chosenLayer = charitySet.layers.length === 1
        ? charitySet.layers[0]
        : await pickLayer(charitySet);
      if (!chosenLayer) return;
      try {
        const dims = await applyLayer(chosenLayer);
        // Charity templates carry no scale field — they're stored at native
        // canvas resolution. `applyLayer` sets scale 1; mirror that into the
        // UI controls so the slider, % input, and label all read 100%.
        applyScalePct(100, true);
        toast(
          "Charity",
          t("charityImported", {
            name: chosenLayer.name,
            x: chosenLayer.x,
            y: chosenLayer.y,
            w: dims.w,
            h: dims.h,
          }),
        );
      } catch (e: any) {
        await errorDlg(
          t("charityImageFailed", { err: e?.message || String(e) }),
        );
      }
    } catch (e: any) {
      await errorDlg(t("charityFetchFailed", { err: e?.message || String(e) }));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = ic("dl") + t("charityImportFetch");
      }
    }
  });

  /**
   * Download a Blob as a file. Tiny helper used by both export buttons; we
   * avoid a runtime dependency by composing the standard URL.createObjectURL
   * + <a download> path.
   */
  const downloadBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  /**
   * Best-effort lookup of the active user's primary clan info, used to
   * pre-populate the export dialog. We don't *force* a clan fetch — if the
   * user isn't logged in we just hand the dialog empty defaults and the
   * "show clan" checkbox will display "—".
   */
  const resolveAuthorDefaults = async (): Promise<{
    username: string;
    clanName: string | null;
    clanRole: string | null;
  }> => {
    const me = getMe();
    const username = me?.username || "";
    if (!username || !Backend.on) {
      return { username, clanName: null, clanRole: null };
    }
    try {
      // NB: the profile endpoint is /v2/users/{id} (no "/profile" suffix) —
      // the suffixed path 404'd silently and the export dialog showed the
      // clan as "—" forever even for clan members.
      const prof: any = await Backend.req(
        "GET",
        `/v2/users/${encodeURIComponent(String(me!.id))}`,
      );
      return {
        username,
        clanName:
          prof?.primary_clan_name || prof?.clans?.[0]?.clan_name || null,
        clanRole:
          prof?.primary_clan_role || prof?.clans?.[0]?.clan_role || null,
      };
    } catch {
      // Profile fetch may legitimately fail (offline, unauthed). Fall back
      // to the username-only path silently — the dialog still works.
      return { username, clanName: null, clanRole: null };
    }
  };

  $("btn-export-walldev")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("exportNoTemplate"));
      return;
    }
    const defaults = await resolveAuthorDefaults();
    const opts = await openExportOptionsDialog(defaults);
    if (!opts) return;
    try {
      // Build the canonical set from current overlay state, then encode as v2.
      const set = exportCurrentOverlay();
      // Apply author choices to the set.
      if (opts.includeAuthor) {
        const username = opts.anonymise ? "anonymous" : defaults.username;
        if (username) {
          set.author = {
            name: username,
            ...(opts.showClan && !opts.anonymise && defaults.clanName ? { clanName: defaults.clanName } : {}),
          };
        }
      }
      if (opts.note) set.notes = [opts.note];
      if (opts.templateName) set.layers[0] = { ...set.layers[0], name: opts.templateName };
      const json = encode(set, "wall-dev/2");
      const blob = new Blob([JSON.stringify(json, null, 2)], {
        type: "application/json",
      });
      downloadBlob(blob, `the-wall-dev-${Date.now()}.json`);
      toast("Export", "the-wall-dev JSON saved");
    } catch (e: any) {
      await errorDlg("Export failed: " + errMsg(e));
    }
  });

  $("btn-export-charity")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("exportNoTemplate"));
      return;
    }
    // Charity rejects data: URLs. Ask the user for a hosted image URL —
    // they're expected to upload the PNG somewhere first (or use the
    // backend's `/v2/templates/{id}/png` once they've shared the template).
    const url = await promptDlg(
      "Image URL (hosted PNG — Charity does not accept data: URLs):",
      "",
      "Charity export",
    );
    if (url == null) return;
    const faction = await promptDlg(
      "Faction:",
      "the-wall-dev export",
      "Charity export",
    );
    if (faction == null) return;
    const contact = await promptDlg("Contact:", "anonymous", "Charity export");
    if (contact == null) return;
    const name = await promptDlg(
      "Template name:",
      "Untitled",
      "Charity export",
    );
    if (name == null) return;
    try {
      const set = exportCurrentOverlay();
      set.layers[0] = { ...set.layers[0], name: String(name), image: [String(url)] };
      const charityResult = encode(set, "charity", {
        faction: String(faction),
        contact: String(contact),
        embedIdentity: !cfg.charityNoIdentity,
      }) as { config: any; report: { lostFields: string[] } };
      const { config: charityOut, report } = charityResult;
      if (report.lostFields.length) {
        const proceed = await confirmDlg(
          `Some fields cannot be represented in Charity format and will be dropped:\n• ${report.lostFields.join("\n• ")}\n\nProceed with export?`,
          "Charity export — data loss warning",
        );
        if (!proceed) return;
      }
      const blob = new Blob([JSON.stringify(charityOut, null, 2)], {
        type: "application/json",
      });
      downloadBlob(blob, `charity-${Date.now()}.json`);
      toast("Export", "Charity config saved");
    } catch (e: any) {
      await errorDlg("Export failed: " + errMsg(e));
    }
  });

  // ----- JSON import: local file -----------------------------------------
  // Reads the chosen file as text, parses, and dispatches through the same
  // pipeline the URL auto-loader uses — so all three accepted shapes
  // (the-wall-dev JSON, Charity config, share link) work identically.
  $("btn-import-json-file")?.addEventListener("click", async () => {
    const input = $("import-json-file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      await errorDlg("Pick a JSON file first.");
      return;
    }
    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(t("importJsonInvalid"));
      }
      const ok = await applyParsedJson(parsed, `file: ${file.name}`);
      if (!ok) await errorDlg(t("importJsonInvalid"));
    } catch (e: any) {
      await errorDlg(e?.message || String(e));
    }
  });

  // ----- JSON import: URL ------------------------------------------------
  $("btn-import-json-url")?.addEventListener("click", async () => {
    const u = ($("import-json-url") as HTMLInputElement | null)?.value.trim();
    if (!u) {
      await errorDlg("Paste a JSON URL first.");
      return;
    }
    const btn = $("btn-import-json-url") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const parsed = await r.json();
      const ok = await applyParsedJson(parsed, u);
      if (!ok) await errorDlg(t("importJsonInvalid"));
    } catch (e: any) {
      await errorDlg(e?.message || String(e));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ============================================================
  // Share tab — unified import + simpler export
  //
  // Everything below replaces the per-format buttons that used to live on
  // the Overlay tab. The same pipeline (format-detect → dispatch) feeds
  // both the file picker and the URL field, so the user doesn't have to
  // know whether their payload is a Charity config or our own JSON.
  // ============================================================

  /** Dispatch a `Detected` payload onto the live overlay. Returns true on
   *  success so the caller can clear the input on a successful import. */
  const applyDetected = async (
    d: import("../format-detect").Detected,
    sourceLabel: string,
  ): Promise<boolean> => {
    const detEl = $("share-detected");
    if (detEl) detEl.textContent = t("shareDetected", { kind: d.kind });
    switch (d.kind) {
      case "wall-dev-export":
      case "charity-config":
        return applyParsedJson(d.json, sourceLabel);
      case "share-link":
        importShare(d.raw);
        toast("Import", `Imported share link from ${sourceLabel}`);
        return true;
      case "data-url-image": {
        if (!d.dataUrl) return false;
        const { w, h } = await insertTemplate({
          imageDataUrl: d.dataUrl,
          x: overlayData.x,
          y: overlayData.y,
          quantize: true,
        });
        toast("Import", `Loaded image (${w}×${h}) from ${sourceLabel}`);
        return true;
      }
      default:
        if (detEl) detEl.textContent = t("shareUnknown");
        return false;
    }
  };

  $("btn-share-import-file")?.addEventListener("click", async () => {
    const input = $("share-import-file") as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      await errorDlg(t("shareUnknown"));
      return;
    }
    try {
      const { detectFile } = await import("../format-detect");
      const d = await detectFile(file);
      const ok = await applyDetected(d, `file: ${file.name}`);
      if (!ok) await errorDlg(t("shareUnknown"));
    } catch (e: any) {
      await errorDlg(e?.message || String(e));
    }
  });

  $("btn-share-import-url")?.addEventListener("click", async () => {
    const u = ($("share-import-url") as HTMLInputElement | null)?.value.trim();
    if (!u) {
      await errorDlg("Paste a URL first.");
      return;
    }
    const btn = $("btn-share-import-url") as HTMLButtonElement | null;
    if (btn) btn.disabled = true;
    try {
      const { detectPayload } = await import("../format-detect");
      // Two interpretations are possible: the URL might BE the payload (e.g.
      // a long the-wall-dev:// link) or it might point AT the payload. We
      // sniff the literal string first; if it's not directly recognisable,
      // we fetch and re-sniff the body.
      const direct = detectPayload(u);
      if (direct.kind !== "unknown") {
        const ok = await applyDetected(direct, u);
        if (!ok) await errorDlg(t("shareUnknown"));
        return;
      }
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = r.headers.get("Content-Type") || "";
      if (ct.startsWith("image/")) {
        const blob = await r.blob();
        const dataUrl = await new Promise<string>((res, rej) => {
          const reader = new FileReader();
          reader.onload = () => res(reader.result as string);
          reader.onerror = () => rej(new Error("read failed"));
          reader.readAsDataURL(blob);
        });
        const ok = await applyDetected(
          { kind: "data-url-image", raw: u, dataUrl },
          u,
        );
        if (!ok) await errorDlg(t("shareUnknown"));
      } else {
        const text = await r.text();
        const d = detectPayload(text);
        const ok = await applyDetected(d, u);
        if (!ok) await errorDlg(t("shareUnknown"));
      }
    } catch (e: any) {
      await errorDlg(e?.message || String(e));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  /** Copy a string to clipboard, with a synthetic-fallback when the async
   *  clipboard API is unavailable (older browsers, file:// origins). */
  const copyToClipboard = async (text: string): Promise<boolean> => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through to legacy path */
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Build the short share URL.
   *
   * Earlier versions inlined the full overlay JSON (image + coords) as a
   * url-safe base64 string. That kept things hosting-free but the URLs
   * routinely crossed 100 KB on real templates, and many chat clients +
   * proxies truncate or drop those mid-flight. The fix: use the backend
   * `/v2/templates/{id}/json` endpoint as the payload. The URL stays
   * predictable and short (~120 chars), and the autoloader already knows
   * to fetch `?the_wall_dev=<https-url>`.
   *
   * This means the user MUST have shared the template to the backend at
   * least once in the current session (so `__wd_last_shared_template_id`
   * is populated). When that's missing we surface a friendly error
   * suggesting either "Share to clan / public" or "Copy share link"
   * instead — the share-link path still inlines the payload and remains
   * the right choice for offline / no-backend use.
   */
  /** Build The Wall Dev share URL (points to /json) */
  const buildTheWallDevShareUrl = (): string | null => {
    const id = (window as any).__wd_last_shared_template_id as
      | string
      | undefined;
    if (!id || !Backend.on) return null;
    const base = (cfg.backendUrl || "").replace(/\/+$/, "");
    if (!base) return null;
    const jsonUrl = `${base}/v2/templates/${encodeURIComponent(id)}/json`;
    return `${SITE}/?the_wall_dev=${encodeURIComponent(jsonUrl)}`;
  };

  /** Build Charity share URL (points to /charity) */
  const buildCharityShareUrl = (): string | null => {
    const id = (window as any).__wd_last_shared_template_id as
      | string
      | undefined;
    if (!id || !Backend.on) return null;
    const base = (cfg.backendUrl || "").replace(/\/+$/, "");
    if (!base) return null;
    const charityUrl = `${base}/v2/templates/${encodeURIComponent(id)}/charity`;
    return `${SITE}/?charity=${encodeURIComponent(charityUrl)}`;
  };

  // ==================== EXPORT BUTTONS ====================

  $("btn-share-export-url-thewall")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("shareNoOverlay"));
      return;
    }
    const url = buildTheWallDevShareUrl();
    if (!url) {
      await errorDlg(t("shareUrlNeedsBackend"));
      return;
    }
    if (await copyToClipboard(url)) {
      toast("Export", t("shareExportCopied"));
    } else {
      await infoDlg(url, "Share URL (The Wall Dev)");
    }
  });

  $("btn-share-export-url-charity")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("shareNoOverlay"));
      return;
    }
    const url = buildCharityShareUrl();
    if (!url) {
      await errorDlg(t("shareUrlNeedsBackend"));
      return;
    }
    if (await copyToClipboard(url)) {
      toast("Export", t("shareExportCopied"));
    } else {
      await infoDlg(url, "Share URL (Charity)");
    }
  });

  $("btn-share-export-link")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("shareNoOverlay"));
      return;
    }
    // Reuse the existing share-link generator — same `the-wall-dev://`
    // base64 scheme the autoloader understands.
    const link = genShare(
      true /* return string instead of writing to legacy field */,
    );
    if (!link) {
      await errorDlg("Could not generate share link");
      return;
    }
    if (await copyToClipboard(link)) {
      toast("Export", t("shareExportCopied"));
    } else {
      await infoDlg(link, "Share link");
    }
  });

  $("btn-share-export-json")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("shareNoOverlay"));
      return;
    }
    const defaults = await resolveAuthorDefaults();
    const opts = await openExportOptionsDialog(defaults);
    if (!opts) return;
    const set = exportCurrentOverlay();
    if (opts.includeAuthor) {
      const username = opts.anonymise ? "anonymous" : defaults.username;
      if (username) {
        set.author = {
          name: username,
          ...(opts.showClan && !opts.anonymise && defaults.clanName ? { clanName: defaults.clanName } : {}),
        };
      }
    }
    if (opts.note) set.notes = [opts.note];
    if (opts.templateName) set.layers[0] = { ...set.layers[0], name: opts.templateName };
    const json = encode(set, "wall-dev/2");
    const blob = new Blob([JSON.stringify(json, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `the-wall-dev-${Date.now()}.json`);
    toast("Export", "JSON saved");
  });

  $("btn-share-export-charity")?.addEventListener("click", async () => {
    if (!overlayData.src) {
      await errorDlg(t("shareNoOverlay"));
      return;
    }
    const lastTplId = (window as any).__wd_last_shared_template_id as
      | string
      | undefined;

    // Best path: the user has already shared this overlay as a template AND
    // is connected to the backend. We just fetch `/v2/templates/{id}/charity`
    // — the backend renders a single-template Charity config that already
    // points at the hosted PNG and drops fields Charity doesn't have. Zero
    // prompts, perfect output.
    if (Backend.on && lastTplId) {
      try {
        const body = await Backend.req(
          "GET",
          `/v2/templates/${encodeURIComponent(lastTplId)}/charity`,
        );
        const text =
          typeof body === "string" ? body : JSON.stringify(body, null, 2);
        const blob = new Blob([text], { type: "application/json" });
        downloadBlob(blob, `charity-${lastTplId}.json`);
        toast("Export", "Charity config saved (backend-hosted PNG)");
        return;
      } catch (e: any) {
        log.warn(
          "EXPORT",
          `backend /charity failed, fallback: ${errMsg(e)}`,
        );
        // Fall through to the manual flow.
      }
    }

    // Fallback: ask the user for a hosted image URL. Charity rejects data:
    // URLs, so embedding the inline image is not an option.
    const entered = await promptDlg(
      "Image URL (hosted PNG):",
      "",
      "Charity export",
    );
    if (entered == null) return;
    const me = getMe();
    const set = exportCurrentOverlay();
    set.layers[0] = { ...set.layers[0], image: [String(entered)] };
    const shareResult = encode(set, "charity", {
      faction: me?.username ? `${me.username}'s clan` : "the-wall-dev export",
      contact: me?.username || "anonymous",
      embedIdentity: !cfg.charityNoIdentity,
    }) as { config: any; report: { lostFields: string[] } };
    const { config: charityOutFallback, report: fallbackReport } = shareResult;
    if (fallbackReport.lostFields.length) {
      const proceed = await confirmDlg(
        `Some fields cannot be represented in Charity format and will be dropped:\n• ${fallbackReport.lostFields.join("\n• ")}\n\nProceed with export?`,
        "Charity export — data loss warning",
      );
      if (!proceed) return;
    }
    const blob = new Blob([JSON.stringify(charityOutFallback, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `charity-${Date.now()}.json`);
    toast("Export", "Charity config saved");
  });
}
