/**
 * URL parameter auto-loader for templates.
 *
 * Discord / Reddit / Twitter link users frequently want to give a friend a
 * one-click "open the wall and load this template" URL. To make that work
 * we look for a `?the_wall_dev=…` query parameter on every page load and,
 * if present, decode it through a small chain of strategies:
 *
 *   1. If the value is a `the-wall-dev://` share link, defer to importShare().
 *   2. If the value starts with `http(s)://`, fetch it. Try parsing the body
 *      as a Charity config first; fall back to our own WallDevExport.
 *   3. Otherwise treat it as a base64-encoded JSON. Decode + try Charity,
 *      then WallDevExport.
 *   4. Last-ditch: try interpreting the value itself as raw JSON.
 *
 * Strategy ordering matters: a Charity config is structurally distinct
 * (`templates: []`) from our export (`format: "the-wall-dev/1"`), so a
 * single value can't be both — we never have to guess.
 *
 * We surface failures as toasts so the user knows the URL was malformed
 * rather than silently ignoring it.
 *
 * Public API:
 *   maybeAutoloadFromUrl()   — call once after the overlay layer is mounted
 */
import { log } from "./log";
import { toast } from "./notify";
import { errMsg } from "./helpers";
import { parseCharityConfig, importCharityTemplate } from "./charity-import";
import { applyWallDevExport, WallDevExport } from "./walldev-config";
import { importShare } from "./share";
import { showImportMetaDialog } from "./overlay-share-dialogs";

const PARAM = "the_wall_dev";
const CHARITY_PARAM = "charity";

/** Cleanly strip a param from the URL after consuming it, so a refresh
 *  doesn't re-import the same template forever. */
function stripParam(name: string): void {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has(name)) {
      u.searchParams.delete(name);
      window.history.replaceState({}, "", u.toString());
    }
  } catch { /* ignore — URL API not available */ }
}

/** Base64-decode with URL-safe alphabet support and tolerant padding. */
function tryBase64ToJson(s: string): any | null {
  try {
    // URL-safe → standard alphabet, restore stripped padding.
    let b = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = b.length % 4;
    if (pad) b += "=".repeat(4 - pad);
    const decoded = atob(b);
    return JSON.parse(decoded);
  } catch { return null; }
}

/** Detect whether a JSON value looks like our format (vs Charity). */
function isWallDevExport(j: any): j is WallDevExport {
  return j && typeof j === "object" && j.format === "the-wall-dev/1" && j.template;
}

/** Detect whether a JSON value looks like a Charity config. */
function looksLikeCharity(j: any): boolean {
  return j && typeof j === "object" && Array.isArray(j.templates);
}

/**
 * Dispatch a parsed JSON value to the right importer. The first template
 * in a Charity config wins automatically — power users with multi-template
 * configs are expected to use the in-extension picker anyway.
 *
 * Exposed so the in-extension UI (file picker / URL field on the Overlay
 * tab) can reuse the same dispatching pipeline as the URL auto-loader.
 */
export async function applyParsedJson(j: any, sourceLabel: string): Promise<boolean> {
  if (isWallDevExport(j)) {
    // The onMeta callback runs after the overlay is mounted but before we
    // toast — we want the author + note in front of the user before the
    // brief "Imported …" confirmation slides in.
    await applyWallDevExport(j, async (meta) => {
      if (meta.author || meta.note) {
        await showImportMetaDialog(meta);
      }
    });
    const authorTag = j.author?.username ? ` by ${j.author.username}` : "";
    toast("Auto-load", `Imported overlay${authorTag} from ${sourceLabel}`);
    return true;
  }
  if (looksLikeCharity(j)) {
    const cfg = parseCharityConfig(j);
    const first = cfg.templates[0];
    if (!first) {
      toast("Auto-load", "Charity config has no templates");
      return false;
    }
    const dims = await importCharityTemplate(first);
    toast(
      "Auto-load",
      `Imported "${first.name}" (${dims.w}×${dims.h}) from ${sourceLabel}`,
    );
    return true;
  }
  log.warn("AUTOLOAD", `unrecognised JSON shape from ${sourceLabel}`);
  return false;
}

/**
 * Try every strategy on the raw URL-param value until one succeeds.
 */
async function tryValue(raw: string): Promise<boolean> {
  // 1. Share link — delegate.
  if (raw.startsWith("the-wall-dev://")) {
    importShare(raw);
    toast("Auto-load", "Applied share link");
    return true;
  }

  // 2. URL — fetch and dispatch.
  if (/^https?:\/\//i.test(raw)) {
    try {
      log.info("AUTOLOAD", `fetching ${raw}`);
      const r = await fetch(raw, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return await applyParsedJson(j, raw);
    } catch (e: any) {
      toast("Auto-load failed", e?.message || String(e));
      log.warn("AUTOLOAD", `URL fetch failed: ${errMsg(e)}`);
      return false;
    }
  }

  // 3. Base64.
  const fromB64 = tryBase64ToJson(raw);
  if (fromB64) {
    try {
      return await applyParsedJson(fromB64, "base64 param");
    } catch (e: any) {
      log.warn("AUTOLOAD", `base64 payload failed: ${errMsg(e)}`);
    }
  }

  // 4. Raw JSON as last resort.
  try {
    const j = JSON.parse(raw);
    return await applyParsedJson(j, "inline JSON");
  } catch {
    /* not JSON — give up */
  }

  toast("Auto-load failed", `Could not decode the_wall_dev= value`);
  log.warn("AUTOLOAD", "all strategies exhausted");
  return false;
}

/**
 * Inspect the current URL and load a template from it, in priority order:
 *
 *   1. `?the_wall_dev=…` — our own share link / export (consumed + stripped).
 *   2. `?charity=<url>`  — a Charity config URL (e.g. filianislost's own
 *      `?charity=https://…/template.json`). Left in the URL so the site /
 *      Charity overlay can read it too.
 *
 * Returns true when a template was loaded, so the caller can fall back to the
 * remembered overlay only when neither param applied.
 */
export async function maybeAutoloadFromUrl(): Promise<boolean> {
  let params: URLSearchParams;
  try {
    params = new URL(window.location.href).searchParams;
  } catch {
    return false;
  }

  const tw = params.get(PARAM);
  if (tw) {
    log.info("AUTOLOAD", `the_wall_dev=${tw.slice(0, 80)}…`);
    stripParam(PARAM);
    try {
      return await tryValue(tw);
    } catch (e: any) {
      log.err("AUTOLOAD", errMsg(e));
      return false;
    }
  }

  const charity = params.get(CHARITY_PARAM);
  if (charity) {
    log.info("AUTOLOAD", `charity=${charity.slice(0, 80)}…`);
    try {
      return await tryValue(charity);
    } catch (e: any) {
      log.err("AUTOLOAD", errMsg(e));
      return false;
    }
  }

  return false;
}
