/**
 * The-wall-dev native config format (`the-wall-dev/1`).
 *
 * Our own self-contained export envelope: inline PNG data URL, position,
 * scale, optional author/note metadata, and — for sprite-sheet templates —
 * a `template.animation` block (WallAnim: grid traversal, per-frame timing,
 * scaling policy). This file owns the format; Charity interop lives apart in
 * charity-import.ts. Detection of "is this ours or Charity's?" is
 * format-detect.ts#detectPayload — never sniff ad-hoc at call sites.
 *
 * Public API:
 *   exportToWallDevJson(opts)  — envelope from the current overlay state
 *   applyWallDevExport(json)   — apply an envelope (incl. animation)
 */
import { log } from "./log";
import {
  setOverlaySrc,
  setOverlayPos,
  setOverlayAnimation,
  getOverlayAnimation,
  overlayData,
} from "./overlay";
import { cfg, saveCfg } from "./config";
import { VERSION } from "./constants";
import {
  animationBlockOf,
  configFromEnvelope,
  fromCharity,
  type AnimationBlock,
} from "./wall-anim";

/** Our internal export wrapper. Includes a small version stamp so a future
 *  schema change can be detected without sniffing fields.
 *
 *  Optional fields (`author`, `note`) carry social context the importer can
 *  surface. Both are skipped on import when missing, so older exports
 *  without them continue to load. */
export interface WallDevExport {
  format: "the-wall-dev/1";
  version: string;
  exported_at: string;
  /** Optional author block. Either the username is included verbatim, or
   *  the entire block is omitted at export time — anonymity is "leave the
   *  whole field out" so a stripped JSON can't even hint at the creator. */
  author?: {
    username: string;
    /** Display name of the user's primary clan. Omitted when the author
     *  asked us not to share clan info, or when they have no clan. */
    clan_name?: string;
    /** Clan role inside that clan, when present. */
    clan_role?: string;
  };
  /** Free-form note shown to the importer in a modal before the overlay
   *  applies. Markdown is NOT rendered — plain text only, to keep the
   *  importer safe against accidental HTML in pasted notes. */
  note?: string;
  template: {
    name?: string;
    /** Inline data URL (PNG). Self-contained — works without the original
     *  hosting URL. */
    image_data_url: string;
    /** Top-left position on the wall, in canvas px. */
    x: number;
    y: number;
    /** Render scale (1.0 = native). */
    scale: number;
    width: number;
    height: number;
    /** Optional sprite-sheet animation (WallAnim block: sheet grid + timing
     *  + scaling policy). Absent for static templates; older importers
     *  ignore the field, so the format string stays "the-wall-dev/1". */
    animation?: AnimationBlock;
  };
}

/** Per-call options controlling what we put into the WallDevExport payload.
 *  All flags default to "off" so the most private export is the easiest:
 *  just call `exportToWallDevJson()` with no args. */
export interface WallDevExportOptions {
  /** Embed the author block (username). When false, the field is omitted. */
  includeAuthor?: boolean;
  /** When `includeAuthor` is true, this controls whether the clan_name +
   *  clan_role pair travels with the export. */
  showClan?: boolean;
  /** Optional username override (e.g. user types something other than their
   *  real handle, or provides "anonymous"). When unset, we read from the
   *  active backend session. */
  usernameOverride?: string;
  /** Optional pre-resolved clan info. When unset and `showClan` is true,
   *  the caller is expected to have fetched it ahead of the call. */
  clanName?: string;
  clanRole?: string;
  /** Plain-text note for the importer. Empty / undefined → no note. */
  note?: string;
  /** Optional template name. */
  templateName?: string;
}

/**
 * Build a self-contained, lossless JSON of the current overlay. Unlike the
 * Charity export this *does* embed the image inline (data URL) so the
 * document is fully portable — drop it on any user with our extension and
 * they get the exact same overlay, no hosting required.
 *
 * Privacy stance: with no options at all the export is fully anonymous —
 * no author block, no clan, no note. Opt-in fields surface only when the
 * caller asks for them, so the most common "share this overlay" flow can't
 * leak identity by accident.
 */
export function exportToWallDevJson(
  opts: WallDevExportOptions = {},
): WallDevExport {
  const out: WallDevExport = {
    format: "the-wall-dev/1",
    version: VERSION,
    exported_at: new Date().toISOString(),
    template: {
      name: opts.templateName || undefined,
      image_data_url: overlayData.srcOrig || overlayData.src || "",
      x: overlayData.x,
      y: overlayData.y,
      scale: cfg.overlayScale || 1,
      width: overlayData.origW || overlayData.w,
      height: overlayData.origH || overlayData.h,
    },
  };
  // Active sprite-sheet animation rides along in the envelope. Charity-style
  // sources normalise through the WallAnim block so one field carries both.
  const anim = getOverlayAnimation();
  if (anim) {
    const animCfg = anim.kind === "wall-anim" ? anim.config : fromCharity(anim.template);
    out.template.animation = animationBlockOf(animCfg);
    if (animCfg.scaling.mode === "native") out.template.scale = 1;
  }
  if (opts.includeAuthor) {
    const username = (opts.usernameOverride || "").trim();
    if (username) {
      const author: NonNullable<WallDevExport["author"]> = { username };
      if (opts.showClan) {
        if (opts.clanName) author.clan_name = opts.clanName;
        if (opts.clanRole) author.clan_role = opts.clanRole;
      }
      out.author = author;
    }
  }
  const note = (opts.note || "").trim();
  if (note) out.note = note;
  return out;
}

/** Apply a WallDevExport blob directly. Useful when an autoload URL hands
 *  us a JSON of our own format. The optional `onMeta` hook lets the caller
 *  surface the embedded note / author block in the UI before the overlay
 *  becomes visible — the autoload pipeline uses this to show a small
 *  "Imported from …" modal. */
export async function applyWallDevExport(
  payload: WallDevExport,
  onMeta?: (meta: { author?: WallDevExport["author"]; note?: string }) => void,
): Promise<void> {
  const t = payload.template;
  if (!t?.image_data_url) throw new Error("export missing image_data_url");
  const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error("decode failed"));
    img.src = t.image_data_url;
  });
  cfg.overlayScale = t.scale || 1;
  saveCfg();
  setOverlaySrc(t.image_data_url, dims.w, dims.h);
  setOverlayPos(t.x, t.y);
  if (t.animation) {
    const animCfg = configFromEnvelope({
      name: t.name,
      image_data_url: t.image_data_url,
      x: t.x,
      y: t.y,
      scale: t.scale,
      animation: t.animation,
    });
    if (animCfg && animCfg.sheet.frameCount > 1) {
      setOverlayAnimation({ kind: "wall-anim", config: animCfg });
    } else {
      log.warn("WALLDEV", "export carried a malformed animation block — loaded static");
    }
  }
  if (onMeta && (payload.author || payload.note)) {
    onMeta({ author: payload.author, note: payload.note });
  }
  log.ok(
    "WALLDEV",
    `wall-dev export applied @ (${t.x},${t.y})` +
      (payload.author ? ` from ${payload.author.username}` : "") +
      (t.animation ? ` [animated ${t.animation.sheet.frameCount}f]` : ""),
  );
}
