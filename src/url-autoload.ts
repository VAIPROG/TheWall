/**
 * URL parameter auto-loader for templates.
 *
 * Discord / Reddit / Twitter link users frequently want to give a friend a
 * one-click "open the wall and load this template" URL. To make that work
 * we look for a `?the_wall_dev=…` query parameter on every page load and,
 * if present, decode it through a small chain of strategies:
 *
 *   1. If the value is a `the-wall-dev://` share link, defer to importShare().
 *   2. If the value starts with `http(s)://`, fetch it and dispatch through
 *      decodeAny (handles charity + wall-dev v1/v2/multi-template).
 *   3. Otherwise try decodeAny on the raw value (handles base64-JSON, raw JSON,
 *      bare charity entries, etc.).
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
import { importShare } from "./share";
import { showImportMetaDialog, pickLayer } from "./overlay-share-dialogs";
import { decodeAny } from "./formats/shared/format-registry";
import { applyLayer } from "./formats/apply-layer";
import { layerCount, primaryLayer, summarize } from "./formats/shared/template-set";
import { UnknownFormatError } from "./formats/shared/parse-errors";

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

/**
 * Dispatch a parsed JSON value (or raw string) to the right importer via the
 * formats barrel. When the decoded set has exactly 1 layer it applies directly;
 * when it has >1 layers the user is shown a picker. Returns true on success.
 *
 * Exposed so the in-extension UI (file picker / URL field on the Overlay
 * tab) can reuse the same dispatching pipeline as the URL auto-loader.
 */
export async function applyParsedJson(j: any, sourceLabel: string): Promise<boolean> {
  let set;
  let id;
  try {
    // decodeAny accepts either a string or a parsed object.
    const result = decodeAny(j);
    set = result.set;
    id = result.id;
  } catch (e: any) {
    if (e instanceof UnknownFormatError) {
      log.warn("AUTOLOAD", `unrecognised JSON shape from ${sourceLabel}: ${e.message}`);
      return false;
    }
    throw e;
  }

  // Surface author / notes before applying (same UX as before).
  const sum = summarize(set);
  if (sum.author || sum.notes.length) {
    // Map back to the legacy showImportMetaDialog interface:
    // author.name → username; notes[0] → note.
    const legacyMeta: {
      author?: { username: string; clan_name?: string; clan_role?: string };
      note?: string;
    } = {};
    if (sum.author?.name) {
      legacyMeta.author = { username: sum.author.name };
      if (sum.author.clanName) legacyMeta.author.clan_name = sum.author.clanName;
    }
    if (sum.notes.length) legacyMeta.note = sum.notes.join("\n");
    await showImportMetaDialog(legacyMeta);
  }

  if (layerCount(set) === 1) {
    const layer = primaryLayer(set)!;
    const dims = await applyLayer(layer);
    const authorTag = sum.author?.name ? ` by ${sum.author.name}` : "";
    toast("Auto-load", `Imported ${layer.name}${authorTag} (${dims.w}×${dims.h}) from ${sourceLabel}`);
    return true;
  }

  // Multiple layers — open the picker.
  const chosen = await pickLayer(set);
  if (!chosen) return false;
  const dims = await applyLayer(chosen);
  toast("Auto-load", `Imported "${chosen.name}" (${dims.w}×${dims.h}) from ${sourceLabel}`);
  return true;
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

  // 3. Try raw string directly through decodeAny (handles base64-JSON + raw JSON).
  try {
    return await applyParsedJson(raw, "inline param");
  } catch (e: any) {
    log.warn("AUTOLOAD", `param decode failed: ${errMsg(e)}`);
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
