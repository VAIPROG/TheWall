/**
 * Kit icon system — crisp custom line SVGs with an emoji fallback.
 *
 * `icon(name, size)` returns a themed inline `<svg>` (currentColor stroke, so it
 * follows the active theme) when the name is in the SVG registry; otherwise it
 * falls back to the emoji registry, then to a raw emoji passthrough, then to a
 * neutral glyph. This module is pure (no DOM) so it can also be rendered by the
 * preview generator (scripts/gen-icons-preview.ts).
 */

// Inner markup for each icon on a 0 0 24 24 canvas. Stroke-based, so they read
// cleanly at small sizes and inherit the theme colour.
const SVG: Record<string, string> = {
  // navigation / sections
  overlay: `<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>`,
  templates: `<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>`,
  community: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
  settings: `<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>`,
  shield: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
  shieldCheck: `<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/>`,
  bell: `<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,

  // actions
  send: `<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>`,
  pin: `<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>`,
  scale: `<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>`,
  film: `<rect x="2" y="2" width="20" height="20" rx="2"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>`,
  progress: `<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>`,
  lock: `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
  unlock: `<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>`,
  eye: `<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/>`,
  eyeOff: `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`,
  trash: `<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`,
  plus: `<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
  edit: `<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>`,
  check: `<polyline points="20 6 9 17 4 12"/>`,
  x: `<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
  chevronRight: `<polyline points="9 18 15 12 9 6"/>`,
  chevronLeft: `<polyline points="15 18 9 12 15 6"/>`,

  // content
  image: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>`,
  file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>`,
  user: `<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
  star: `<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>`,
  award: `<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>`,
  chat: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>`,
  clanChat: `<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M12 5.5l3.5 1.3v2.8c0 2.7-2.1 4-3.5 4.5-1.4-.5-3.5-1.8-3.5-4.5V6.8z"/>`,
  clan: `<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>`,
  link: `<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,

  // system / status
  theme: `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`,
  download: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
  upload: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`,
  refresh: `<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`,
  volume: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>`,
  mute: `<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>`,
  ban: `<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>`,
  warning: `<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>`,
  info: `<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>`,
  search: `<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>`,
  bolt: `<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>`,
  clock: `<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`,
  emote: `<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>`,
};

// Emoji fallback per icon name (used if the SVG registry is stripped or a name
// is requested that has no SVG yet).
const EMOJI: Record<string, string> = {
  overlay: "▦", templates: "💾", community: "🌐", settings: "⚙", shield: "🛡",
  shieldCheck: "🛡", bell: "🔔", send: "➤", pin: "📍", scale: "⛶", film: "🎞",
  progress: "📊", lock: "🔒", unlock: "🔓", eye: "👁", eyeOff: "🙈", trash: "🗑",
  plus: "＋", edit: "✎", check: "✓", x: "✕", chevronRight: "›", chevronLeft: "‹",
  image: "🖼", file: "📄", user: "👤", star: "★", award: "🏅", chat: "💬",
  clanChat: "💬", clan: "🚩", link: "🔗", theme: "🌙", download: "⬇", upload: "⬆", refresh: "↻",
  volume: "🔊", mute: "🔇", ban: "⛔", warning: "⚠", info: "ℹ", search: "🔍",
  bolt: "⚡", clock: "🕓", emote: "😀",
};

const FALLBACK_GLYPH = "▢";

/** All registered SVG icon names (for the preview gallery / tooling). */
export const ICON_NAMES: string[] = Object.keys(SVG);

export function hasIcon(name: string): boolean {
  return name in SVG;
}

/** The emoji fallback for a name (or the neutral glyph). For tooling/preview. */
export function emojiFor(name: string): string {
  return EMOJI[name] ?? FALLBACK_GLYPH;
}

function svgWrap(inner: string, size: number): string {
  return (
    `<svg class="wd-ico" width="${size}" height="${size}" viewBox="0 0 24 24" ` +
    `fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" ` +
    `stroke-linejoin="round" aria-hidden="true">${inner}</svg>`
  );
}

function emojiWrap(ch: string, size: number): string {
  return `<span class="wd-ico wd-ico-emoji" style="font-size:${Math.round(size * 0.85)}px" aria-hidden="true">${ch}</span>`;
}

/**
 * Optional pixelation. Rather than a separate pixel-art icon set, we run the
 * line SVGs through an SVG mosaic filter and let a root class toggle it — one
 * filter pixelates every icon at once. `injectIconFilter()` adds the filter def
 * to the DOM once; the `.wd-pixel-icons` class (see kit styles) applies it.
 */
export const PIXELATE_FILTER_ID = "wd-pixelate";

/** The hidden `<svg>` holding the pixelation filter definition (pure string). */
export function pixelateFilterMarkup(): string {
  // Classic SVG mosaic: sample one point per NxN tile, tile it, keep the
  // graphic only at those points, then dilate each into a block → pixel grid.
  return (
    `<svg width="0" height="0" focusable="false" aria-hidden="true" style="position:absolute">` +
    `<defs><filter id="${PIXELATE_FILTER_ID}" x="0" y="0">` +
    `<feFlood x="0.5" y="0.5" height="1" width="1"/>` +
    `<feComposite width="2" height="2"/>` +
    `<feTile result="a"/>` +
    `<feComposite in="SourceGraphic" in2="a" operator="in"/>` +
    `<feMorphology operator="dilate" radius="1"/>` +
    `</filter></defs></svg>`
  );
}

/** Add the pixelation filter def to the document once. Safe to call repeatedly. */
export function injectIconFilter(doc: Document): void {
  if (doc.getElementById("wd-icon-filter-defs")) return;
  const wrap = doc.createElement("div");
  wrap.id = "wd-icon-filter-defs";
  wrap.setAttribute("aria-hidden", "true");
  wrap.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  wrap.innerHTML = pixelateFilterMarkup();
  doc.body.appendChild(wrap);
}

/**
 * Render an icon. SVG when available, else the emoji fallback, else a raw
 * emoji/char passthrough, else a neutral glyph.
 */
export function icon(name: string, size = 16): string {
  const svg = SVG[name];
  if (svg) return svgWrap(svg, size);
  const emoji = EMOJI[name];
  if (emoji) return emojiWrap(emoji, size);
  // A raw emoji/character (anything that isn't a plain slug) passes through.
  if (name && !/^[a-z0-9_-]+$/i.test(name)) return emojiWrap(name, size);
  return emojiWrap(FALLBACK_GLYPH, size);
}
