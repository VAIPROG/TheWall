/**
 * Win95-styled SVG icon library.
 *
 * Every icon is a single `<path>` (or small group of basic shapes) inscribed
 * in a 16×16 viewBox using `fill: currentColor` and `shape-rendering:
 * crispEdges` so they render pixel-sharp at the default 14×14 size used by
 * `ic()`. Achievement medallions use the same paths but rendered inside a
 * gold-gradient circle by `achIcon()`.
 *
 * The icons live in named CATEGORIES (system / file / navigation / etc.) for
 * readability and easier additions. At module load time we flatten the
 * categories into a single lookup map (`ICON_PATHS`) so the existing
 * `ic(name)` / `achIcon(name)` callers don't need to know which category an
 * icon belongs to.
 *
 * Adding a new icon:
 *   1. Pick the right category below (or add a new one if needed).
 *   2. Drop the path snippet (the SVG inner markup, no `<svg>` wrapper).
 *   3. Reference it by its key from `ic("name")` / `achIcon("name")`.
 *
 * Public API:
 *   ic(name, size?)           inline SVG with a class `wd-ic`
 *   achIcon(name, size?)      bigger medallion variant (gold ring + path)
 *   achIconPath(name)         raw path string (no wrapper)
 *   ICON_CATEGORIES           the structured tree, for documentation /
 *                              admin pickers
 */

/* ===========================================================================
 * Categorized library
 * ======================================================================== */

/** System chrome — window controls, status indicators. */
const SYSTEM_ICONS: Record<string, string> = {
  xcom: '<path d="M2 2l12 12M14 2L2 14" stroke="currentColor" stroke-width="2.2"/>',
  minimize: '<rect x="3" y="11" width="10" height="2"/>',
  maximize: '<rect x="2" y="2" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"/><rect x="2" y="2" width="12" height="3"/>',
  home: '<path d="M8 1L1 7h2v8h4v-5h2v5h4V7h2z"/>',
};

/** File & data — disks, downloads, plus/minus, scans. */
const FILE_ICONS: Record<string, string> = {
  disk: '<rect x="1" y="1" width="14" height="14"/><rect x="3" y="2" width="8" height="5" fill="#fff"/><rect x="9" y="3" width="2" height="3" fill="#06c"/><rect x="3" y="9" width="10" height="5" fill="#dcdcdc"/>',
  plus: '<rect x="6.5" y="2" width="3" height="12"/><rect x="2" y="6.5" width="12" height="3"/>',
  dl: '<rect x="6.5" y="1" width="3" height="8"/><path d="M3 8l5 5 5-5z"/><rect x="2" y="14" width="12" height="1.6"/>',
  trash: '<rect x="3" y="4" width="10" height="11"/><rect x="5" y="6" width="1.5" height="7" fill="#fff"/><rect x="9.5" y="6" width="1.5" height="7" fill="#fff"/><rect x="2" y="2" width="12" height="2"/><rect x="6" y="0" width="4" height="2"/>',
  scan: '<circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="11" y="11" width="5" height="2.4" transform="rotate(45 11 11)"/>',
  check: '<path d="M2 8l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2.4"/>',
  grid: '<rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1"/><path d="M6 1v14M11 1v14M1 6h14M1 11h14" stroke="currentColor" stroke-width="1"/>',
};

/** Navigation — globe, pin, cursors, send arrows. */
const NAVIGATION_ICONS: Record<string, string> = {
  globe: '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1 8h14M8 1c3 3 3 11 0 14M8 1c-3 3-3 11 0 14" fill="none" stroke="currentColor" stroke-width="1"/>',
  pin: '<path d="M8 1c3 0 5 2 5 5 0 4-5 9-5 9S3 10 3 6c0-3 2-5 5-5z"/><circle cx="8" cy="6" r="2" fill="#fff"/>',
  cursor: '<path d="M3 1l10 6-4 1 3 5-2 1-3-5-3 3z"/>',
  send: '<path d="M1 8l14-6-6 14-2-5z"/><path d="M9 7l-4 3" stroke="#fff" stroke-width="1"/>',
  flag: '<rect x="2" y="1" width="1.8" height="14"/><path d="M4 2h9l-2 3 2 3H4z"/>',
};

/** Communication & alerts — chat, bell, shield, gear. */
const COMMUNICATION_ICONS: Record<string, string> = {
  chat: '<rect x="1" y="2" width="14" height="9"/><rect x="3" y="4" width="10" height="1.6" fill="#fff"/><rect x="3" y="7" width="7" height="1.6" fill="#fff"/><path d="M4 11l0 3 3-3z"/>',
  bell: '<path d="M8 1a4 4 0 0 1 4 4v4l2 2H2l2-2V5a4 4 0 0 1 4-4z"/><rect x="6.5" y="13" width="3" height="2" rx="1"/>',
  shield: '<path d="M8 1l6 2v5c0 4-3 6-6 7-3-1-6-3-6-7V3z"/><path d="M5 8l2 2 4-4" fill="none" stroke="#fff" stroke-width="1.6"/>',
  gear: '<path d="M8 1l1 2 2-1 1 2 2 1-1 2 1 2-2 1-1 2-2-1-1 2-1-2-2 1-1-2-2-1 1-2-1-2 2-1 1-2 2 1z"/><circle cx="8" cy="8" r="2.6" fill="#fff"/>',
  bolt: '<path d="M9 1L3 9h4l-1 6 7-9H9z"/>',
  user: '<circle cx="8" cy="5" r="3.2"/><path d="M2 15c0-4 3-6 6-6s6 2 6 6z"/>',
};

/** Drawing tools — lines, rects, brush, eyedrop. */
const DRAWING_ICONS: Record<string, string> = {
  line: '<rect x="1" y="13" width="3" height="3"/><rect x="12" y="0" width="3" height="3"/><path d="M3 13L13 3" stroke="currentColor" stroke-width="1.6"/>',
  rect: '<rect x="2" y="3" width="12" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-dasharray="2 1.5"/>',
  eraser: '<rect x="2" y="9" width="9" height="4" transform="rotate(-40 6 11)"/><rect x="9" y="3" width="5" height="4" transform="rotate(-40 11 5)" fill="#f0a"/>',
  pencil: '<path d="M11 1l4 4-8 8-4 1 1-4z"/><path d="M10 2l4 4" stroke="#fff" stroke-width="1"/>',
  brush: '<path d="M2 14c0-2 2-3 4-3 1 0 2 1 2 2s-1 2-3 2H2zM8 9l5-7 1 1-5 7z"/>',
  circle: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  eyedrop: '<path d="M11 1l4 4-3 3 1 1-2 2-1-1-6 6-3 1 1-3 6-6-1-1 2-2 1 1z"/>',
};

/** Time & weather — sun / moon for theme toggles. */
const TIME_ICONS: Record<string, string> = {
  moon: '<path d="M11 1a7 7 0 1 0 4 12A6 6 0 0 1 11 1z"/>',
  sun: '<circle cx="8" cy="8" r="3.4"/><g stroke="currentColor" stroke-width="1.4"><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13"/></g>',
};

/** Brand & social — Discord, GitHub, X, Reddit. */
const SOCIAL_ICONS: Record<string, string> = {
  discord: '<path d="M5 5c2-1 4-1 6 0M5 11c2 1 4 1 6 0M3 4c-1 3-1 6 0 9l3-1M13 4c1 3 1 6 0 9l-3-1"/><circle cx="6" cy="8" r="1.3" fill="#fff"/><circle cx="10" cy="8" r="1.3" fill="#fff"/>',
  reddit: '<circle cx="8" cy="9" r="6"/><circle cx="5.5" cy="8.5" r="1" fill="#fff"/><circle cx="10.5" cy="8.5" r="1" fill="#fff"/><path d="M5.5 11c1.5 1 3.5 1 5 0" stroke="#fff" stroke-width="1" fill="none"/><circle cx="13" cy="4" r="1.6"/><path d="M9 4l4 0" stroke="currentColor"/>',
  github: '<path d="M8 1a7 7 0 0 0-2 13.7c.4 0 .5-.2.5-.4v-1.4c-2 .4-2.5-.9-2.5-.9-.3-.8-.8-1-.8-1-.6-.5 0-.5 0-.5.8 0 1.2.8 1.2.8.7 1.2 1.8.8 2.2.6 0-.5.3-.8.5-1-1.6-.2-3.3-.8-3.3-3.6 0-.8.3-1.4.7-1.9 0-.2-.3-.9.1-1.9 0 0 .6-.2 2 .7a7 7 0 0 1 3.6 0c1.4-.9 2-.7 2-.7.4 1 .1 1.7.1 1.9.5.5.7 1.1.7 1.9 0 2.8-1.7 3.4-3.3 3.6.3.2.5.7.5 1.4v2c0 .2.1.4.5.4A7 7 0 0 0 8 1z"/>',
};

/** 7TV emotes & expressions — used by the chat picker. */
const EMOTE_ICONS: Record<string, string> = {
  emote: '<circle cx="8" cy="8" r="6.5" fill="#ffd84a" stroke="#000" stroke-width="1.2"/><ellipse cx="6" cy="7" rx=".9" ry="1.2" fill="#000"/><ellipse cx="10" cy="7" rx=".9" ry="1.2" fill="#000"/><path d="M5 9.5 Q8 12.5 11 9.5" stroke="#000" stroke-width="1.2" fill="none" stroke-linecap="round"/><rect x="9.5" y="10.5" width="6.5" height="4" rx="1" fill="#29d" stroke="#fff" stroke-width=".5"/><text x="12.7" y="13.7" text-anchor="middle" fill="#fff" font-family="Verdana,sans-serif" font-size="3.2" font-weight="bold">7TV</text>',
  emote_bw: '<circle cx="8" cy="8" r="6.5" fill="#fff" stroke="currentColor" stroke-width="1.2"/><circle cx="6" cy="7" r="1" fill="currentColor"/><circle cx="10" cy="7" r="1" fill="currentColor"/><path d="M5 9.5 Q8 12.5 11 9.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/>',
};

/** Achievement medallions — fancier, used by achIcon(). */
const ACHIEVEMENT_ICONS: Record<string, string> = {
  spark:   '<path d="M8 1 L9.2 6.8 L15 8 L9.2 9.2 L8 15 L6.8 9.2 L1 8 L6.8 6.8 Z"/>',
  sparkle: '<path d="M8 1 L9 6 L14 7 L9 8 L8 13 L7 8 L2 7 L7 6 Z" opacity=".9"/><path d="M13 11 L13.5 13 L15 13.5 L13.5 14 L13 15.5 L12.5 14 L11 13.5 L12.5 13 Z"/><path d="M3 2 L3.4 3.4 L4.6 3.6 L3.4 3.8 L3 5 L2.6 3.8 L1.4 3.6 L2.6 3.4 Z"/>',
  medal:   '<path d="M5 1 L11 1 L9 6 L7 6 Z" opacity=".85"/><circle cx="8" cy="11" r="4.5" fill="#ffd84a" stroke="currentColor" stroke-width="1"/><circle cx="8" cy="11" r="2.4" fill="currentColor" opacity=".25"/><text x="8" y="12.4" text-anchor="middle" fill="currentColor" font-family="Verdana" font-size="3.2" font-weight="bold">★</text>',
  crown:   '<path d="M2 5 L4 10 L6 6 L8 10 L10 6 L12 10 L14 5 L13 12 L3 12 Z"/><rect x="3" y="12" width="10" height="1.5"/><circle cx="4" cy="5" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="8" cy="3.5" r="1.2"/>',
  trophy:  '<path d="M5 2 L11 2 L11 6 Q11 9 8 9 Q5 9 5 6 Z" fill="#ffd84a" stroke="currentColor" stroke-width="1"/><path d="M2 3 L5 3 L5 5 Q3 5 3 4 Z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M14 3 L11 3 L11 5 Q13 5 13 4 Z" fill="none" stroke="currentColor" stroke-width="1"/><rect x="6.5" y="9" width="3" height="3"/><rect x="4" y="12" width="8" height="2"/>',
  palette: '<path d="M8 1 Q14 1 14 7 Q14 10 11 10 Q10 10 10 11 Q10 13 8 14 Q1 14 1 8 Q1 1 8 1 Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5" cy="6" r="1.1" fill="#e44"/><circle cx="9" cy="4" r="1.1" fill="#2c9"/><circle cx="11" cy="7" r="1.1" fill="#fc4"/><circle cx="5" cy="10" r="1.1" fill="#39d"/>',
  plug:    '<rect x="6" y="1" width="1.5" height="4"/><rect x="8.5" y="1" width="1.5" height="4"/><rect x="4" y="5" width="8" height="4" rx="1"/><path d="M7 9 L7 13 Q7 15 9 15" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="15" r="1"/>',
  telegram:'<path d="M1 8 L15 2 L13 14 L8 11 L11 5 L6 10 Z"/>',
  star:    '<path d="M8 1 L10 6 L15 6 L11 9.5 L12.5 15 L8 12 L3.5 15 L5 9.5 L1 6 L6 6 Z"/>',
};

/* ===========================================================================
 * Public structured map (for admin pickers, docs)
 * ======================================================================== */

export const ICON_CATEGORIES: Record<string, Record<string, string>> = {
  system: SYSTEM_ICONS,
  file: FILE_ICONS,
  navigation: NAVIGATION_ICONS,
  communication: COMMUNICATION_ICONS,
  drawing: DRAWING_ICONS,
  time: TIME_ICONS,
  social: SOCIAL_ICONS,
  emote: EMOTE_ICONS,
  achievement: ACHIEVEMENT_ICONS,
};

/* ===========================================================================
 * Flat lookup — assembled once at module load
 * ======================================================================== */

const ICON_PATHS: Record<string, string> = {};
for (const group of Object.values(ICON_CATEGORIES)) {
  for (const [name, path] of Object.entries(group)) {
    ICON_PATHS[name] = path;
  }
}

/* ===========================================================================
 * Renderers
 * ======================================================================== */

/** Inline 16×16 SVG icon. The default 14px size matches the legacy callers;
 *  pass a larger value when the icon is used as a standalone glyph. */
export function ic(name: string, size?: number): string {
  const s = size || 14;
  return `<svg class="wd-ic" width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">${ICON_PATHS[name] || ""}</svg>`;
}

/**
 * Larger achievement medallion icon — renders the requested path inside a
 * gold gradient circle. Falls back to the star path when the key is unknown
 * so a typo never produces a broken-image block.
 */
export function achIcon(name: string, size = 40): string {
  const path = ICON_PATHS[name] || ICON_PATHS["star"];
  return `<svg class="wd-ach-svg" width="${size}" height="${size}" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="wdAchBg-${name}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ffd84a"/>
        <stop offset="1" stop-color="#e89500"/>
      </linearGradient>
    </defs>
    <circle cx="8" cy="8" r="7.4" fill="url(#wdAchBg-${name})" stroke="#2a1a00" stroke-width="0.8"/>
    <circle cx="6" cy="5" r="2" fill="#fff8c8" opacity=".55"/>
    <g fill="#2a1a00" stroke="none" transform="translate(2 2) scale(0.75)">
      ${path}
    </g>
  </svg>`;
}

/** Returns just the inner-path snippet — for cases where the caller already
 *  provides a wrapper svg (e.g. profile list compact rendering). */
export function achIconPath(name: string): string {
  return ICON_PATHS[name] || ICON_PATHS["star"];
}
