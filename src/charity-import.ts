/**
 * Charity (Bluemarble-style) template config import / export.
 *
 * Charity is a popular third-party overlay system that stores its template
 * catalogue as a single JSON document. The format we accept matches what
 * the upstream Charity userscript reads (see source-code-wall/
 * CharityOverlay.js around line 355):
 *
 *   {
 *     "faction":  "swarm (rogue template)",
 *     "contact":  "ts",
 *     "templates": [
 *       {
 *         "name":            "activities :3",
 *         "sources":         ["https://file.garden/.../foo.png"],
 *         "x":               5569,
 *         "y":               440,
 *         "frameWidth":      null,             // sprite-sheet support
 *         "frameHeight":     null,
 *         "frameCount":      1,
 *         "secondsPerFrame": Infinity,         // alt: frameRate / frameSpeed
 *         "startTimestamp":  0,                // alt: startTime
 *         "looping":         true
 *       }, ...
 *     ],
 *     "whitelist": []
 *   }
 *
 * Animated entries (frameCount > 1) get the full sprite-sheet runtime on
 * import — same wall-clock frame math as upstream Charity, so all clients
 * show the same frame at the same moment.
 *
 * This file is Charity-ONLY by design: our native `the-wall-dev/1` envelope
 * lives in walldev-config.ts, and the "which format is this?" question is
 * answered exclusively by format-detect.ts#detectPayload. Keep the two
 * formats strictly apart — they evolve independently.
 *
 * Public API:
 *   fetchCharityConfig(url)             — pull + parse the JSON
 *   parseCharityConfig(json)            — validate an in-memory document
 *   imageUrlToDataUrl(url)              — fetch one image, return data URL
 *   importCharityTemplate(item)         — apply directly as the active overlay
 *   exportToCharityConfig(faction?,...) — build a config from the current overlay
 *
 * No site code is modified. CORS errors are surfaced as plain warnings; the
 * caller can fall back to asking the user to download manually.
 *
 * @deprecated Shim — delegates to src/formats/ layer.
 *   Call sites will be rewired to the formats barrel in Task 17.
 */
import { log } from "./log";
import { getOverlayAnimation, overlayData } from "./overlay";
import { fromCharity } from "./wall-anim";
import { decodeCharity } from "./formats/charity/decode";
import { encodeCharity } from "./formats/charity/encode";
import { applyLayer } from "./formats/apply-layer";
import { primaryLayer, createSet } from "./formats/shared/template-set";
import { cfg } from "./config";

export interface CharityTemplate {
  name: string;
  sources: string[];
  x: number;
  y: number;
  /** Sprite-sheet frame width in px. NULL when source isn't sliced. */
  frameWidth?: number | null;
  frameHeight?: number | null;
  frameCount?: number;
  /** Animation cadence — Infinity = static. Some configs use the legacy
   *  field names `frameRate` or `frameSpeed`, which we normalise on read. */
  secondsPerFrame?: number;
  /** When the animation should start playing (epoch s). */
  startTimestamp?: number;
  looping?: boolean;
}

export interface CharityConfig {
  faction?: string;
  contact?: string;
  templates: CharityTemplate[];
  whitelist?: string[];
}

/**
 * Normalise a raw upstream entry into a Charity *config* template (the shape
 * stored in / exported to a Charity JSON document). Accepts the same field
 * aliases (`frameRate`, `frameSpeed`, `startTime`) as the upstream loader so
 * any sane Charity JSON loads without hand-editing.
 *
 * Sibling: `animated-template.ts#parseCharityTemplate` reads the same aliases
 * but produces an `AnimatedTemplate` *runtime* (defaults tuned for playback —
 * `secondsPerFrame: Infinity`, `startTimestamp: 0`). They are deliberately
 * separate: this one feeds config parse + export (where `undefined` means
 * "omit from JSON"); that one feeds the animation engine. Keep both in sync
 * when adding a new alias.
 */
function normaliseTemplate(t: any): CharityTemplate | null {
  if (typeof t?.x !== "number" || typeof t?.y !== "number") return null;
  const sources = Array.isArray(t.sources)
    ? t.sources.filter((s: any) => typeof s === "string")
    : [];
  if (sources.length === 0) return null;
  const secondsPerFrame =
    t.secondsPerFrame ?? t.frameRate ?? t.frameSpeed ?? undefined;
  const startTimestamp = t.startTimestamp ?? t.startTime ?? undefined;
  return {
    name: String(t.name || "(unnamed)").trim() || "(unnamed)",
    sources,
    x: Math.round(t.x),
    y: Math.round(t.y),
    frameWidth: typeof t.frameWidth === "number" ? t.frameWidth : null,
    frameHeight: typeof t.frameHeight === "number" ? t.frameHeight : null,
    frameCount: typeof t.frameCount === "number" ? t.frameCount : 1,
    secondsPerFrame,
    startTimestamp,
    looping: typeof t.looping === "boolean" ? t.looping : true,
  };
}

/** Fetch and validate a Charity config JSON from `url`. Throws on HTTP
 *  errors, malformed JSON, or a top-level shape that doesn't include the
 *  required `templates` array. */
export async function fetchCharityConfig(url: string): Promise<CharityConfig> {
  log.info("CHARITY", `fetching ${url}`);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  return parseCharityConfig(j);
}

/** Parse a JSON value that we already have in memory (e.g. decoded from a
 *  base64 URL param). Same validation rules as `fetchCharityConfig`. */
export function parseCharityConfig(j: any): CharityConfig {
  if (!Array.isArray(j?.templates)) {
    throw new Error("not a Charity config (missing templates[])");
  }
  const templates = j.templates
    .map(normaliseTemplate)
    .filter((t: CharityTemplate | null): t is CharityTemplate => t !== null);
  log.ok("CHARITY", `parsed ${templates.length} template(s)`);
  return {
    faction: typeof j.faction === "string" ? j.faction : undefined,
    contact: typeof j.contact === "string" ? j.contact : undefined,
    templates,
    whitelist: Array.isArray(j.whitelist) ? j.whitelist : [],
  };
}

/**
 * Fetch a remote image and inline it as a base64 data URL.
 *
 *   1. Our overlay engine quantises the source to the site palette and
 *      stores the *uploaded* version inside the share string. Sharing a
 *      Charity overlay should be self-contained — no `file.garden` URL.
 *   2. The site canvas requires a `crossOrigin = "anonymous"` image element
 *      to be drawable into our quantising canvas. Inlining sidesteps the
 *      CORS taint problem entirely.
 */
export async function imageUrlToDataUrl(url: string): Promise<string> {
  log.info("CHARITY", `fetching image ${url}`);
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`image HTTP ${r.status}`);
  const ct = r.headers.get("Content-Type") || "";
  if (!ct.startsWith("image/")) {
    throw new Error(`unexpected content-type: ${ct || "(none)"}`);
  }
  const blob = await r.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Apply one Charity template entry as the active overlay. Returns the
 * width/height of the loaded image so the UI can show a confirmation toast.
 * Forces scale to 1 — Charity templates are stored at native canvas
 * resolution.
 *
 * Delegates to decodeCharity + applyLayer from the formats layer.
 */
export async function importCharityTemplate(
  item: CharityTemplate,
): Promise<{ w: number; h: number; note?: string }> {
  log.info("CHARITY", `import "${item.name}" @ (${item.x},${item.y})`);

  // Wrap the single entry in a config object so decodeCharity can parse it,
  // then apply the primary layer through the new formats layer.
  const set = decodeCharity({ templates: [item as any] });
  const layer = primaryLayer(set);
  if (!layer) throw new Error("decodeCharity produced no layers");

  const result = await applyLayer(layer);
  log.ok("CHARITY", `"${item.name}" applied (${result.w}×${result.h})`);
  return result;
}

/**
 * Build a Charity-compatible JSON for the currently loaded overlay. The
 * caller is responsible for providing a hosted URL for the image — we can
 * insert a placeholder data URL when none is given, but upstream Charity
 * rejects data URLs, so the operator usually uploads the PNG somewhere
 * first (see `/v2/templates/{id}/png` on the backend).
 *
 * Delegates to encodeCharity from the formats layer.
 */
export function exportToCharityConfig(opts: {
  faction?: string;
  contact?: string;
  templateName?: string;
  imageUrl?: string;
}): CharityConfig {
  const url = opts.imageUrl || overlayData.srcOrig || overlayData.src || "";

  // Build a minimal WallTemplateSet from the current overlay state.
  const layer: import("./formats/shared/template-model").TemplateLayer = {
    name: opts.templateName || "Untitled",
    image: url ? [url] : [],
    x: overlayData.x,
    y: overlayData.y,
    scale: 1,
    width: overlayData.origW || overlayData.w,
    height: overlayData.origH || overlayData.h,
  };

  // Attach animation when the overlay is animated.
  const anim = getOverlayAnimation();
  if (anim) {
    const animCfg = anim.kind === "wall-anim" ? anim.config : fromCharity(anim.template);
    layer.animation = {
      sheet: {
        frameWidth: animCfg.sheet.frameWidth,
        frameHeight: animCfg.sheet.frameHeight,
        frameCount: animCfg.sheet.frameCount,
        layout: animCfg.sheet.layout,
        order: animCfg.sheet.order,
      },
      timing: {
        startTime: animCfg.timing.startTime,
        defaultFrameMs: animCfg.timing.defaultFrameMs,
        looping: animCfg.timing.looping,
      },
      scaleMode: animCfg.scaling.mode,
    };
  }

  const set = createSet({ layers: [layer] });
  const { config } = encodeCharity(set, {
    faction: opts.faction,
    contact: opts.contact,
    embedIdentity: false,
  });

  // Project from CharityEntry[] to legacy CharityTemplate[] shape.
  // The structures are compatible for all fields; assert as the legacy type.
  return {
    faction: config.faction,
    contact: config.contact,
    templates: config.templates as unknown as CharityTemplate[],
    whitelist: config.whitelist ?? [],
  };
}
