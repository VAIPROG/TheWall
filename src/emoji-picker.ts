/**
 * Reusable Win95-styled 7TV emote picker.
 *
 * The picker is a single body-level element shared across all callers; opening
 * it from a new anchor simply re-targets it. This keeps the markup small,
 * preserves last-drag position, and avoids duplicated state.
 *
 * Public API:
 *   ensureEmojiPicker()                              — build the popup once
 *   openEmojiPicker(target, anchor, { theme? })      — show + retarget
 *   closeEmojiPicker()                               — hide
 */
import { initEmotes, getEmoteMap, getEmotesGrouped } from "./emoji";
import { isWalldevDark } from "./theme";

export type EmojiTarget = HTMLInputElement | HTMLTextAreaElement;

let picker: HTMLElement | null = null;
let currentTarget: EmojiTarget | null = null;
let bodyEl: HTMLElement | null = null;

function injectCss(): void {
  if (document.getElementById("wd-emoji-picker-css")) return;
  const style = document.createElement("style");
  style.id = "wd-emoji-picker-css";
  style.textContent = `
  /* Body-level so it's safe to live outside #walldev-tool's CSS scope. */
  .wd-emoji-picker {
    position:fixed; z-index:1000001; display:none;
    width:300px;
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    background:#c0c0c0; color:#000;
    border:2px solid; border-color:#fff #404040 #404040 #fff;
    box-shadow:
      inset -1px -1px 0 #808080,
      inset  1px  1px 0 #dfdfdf,
      4px 4px 0 rgba(0,0,0,.55);
    user-select:none;
  }
  .wd-emoji-picker.open { display:flex; flex-direction:column; }
  .wd-emoji-picker.wd-dark {
    background:#2c2c2c; color:#fff;
    border-color:#5a5a5a #000 #000 #5a5a5a;
    box-shadow:
      inset -1px -1px 0 #141414,
      inset  1px  1px 0 #3a3a3a,
      4px 4px 0 rgba(0,0,0,.7);
  }
  .wd-emoji-picker .wd-emoji-tb {
    background:linear-gradient(90deg,#000080,#1084d0);
    color:#fff; font-weight:bold; font-size:12px;
    padding:3px 4px 3px 6px;
    display:flex; align-items:center; justify-content:space-between;
    height:20px; line-height:14px;
    cursor:move;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-tb {
    background:linear-gradient(90deg,#3838aa,#1084d0);
  }
  .wd-emoji-picker .wd-emoji-tb-title { display:flex; gap:6px; align-items:center }
  .wd-emoji-picker .wd-emoji-tb-led {
    width:8px; height:8px; border-radius:50%;
    background:#3f6; box-shadow:0 0 4px #3f6, inset 0 0 1px rgba(255,255,255,.5);
  }
  .wd-emoji-picker .wd-emoji-x {
    width:18px; height:16px;
    display:flex; align-items:center; justify-content:center;
    background:#c0c0c0; color:#000;
    border:1px solid; border-color:#fff #404040 #404040 #fff;
    box-shadow:inset 1px 1px 0 #dfdfdf, inset -1px -1px 0 #808080;
    font:bold 10px Verdana, sans-serif; cursor:pointer; padding:0;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-x {
    background:#3a3a3a; color:#fff;
    border-color:#5a5a5a #000 #000 #5a5a5a;
  }
  .wd-emoji-picker .wd-emoji-x:active {
    border-color:#404040 #fff #fff #404040;
    box-shadow:inset -1px -1px 0 #dfdfdf, inset 1px 1px 0 #808080;
    padding:1px 0 0 1px;
  }

  /* Search row */
  .wd-emoji-picker .wd-emoji-search {
    padding:4px 4px 3px;
    background:#c0c0c0;
    border-bottom:1px solid #808080;
    box-shadow:inset 0 -1px 0 #fff;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-search {
    background:#2c2c2c;
    border-bottom-color:#141414;
    box-shadow:inset 0 -1px 0 #3a3a3a;
  }
  .wd-emoji-picker .wd-emoji-search input {
    width:100%; box-sizing:border-box; padding:3px 6px;
    background:#fff; color:#000;
    border:2px solid; border-color:#404040 #fff #fff #404040;
    box-shadow:inset 1px 1px 0 #808080, inset -1px -1px 0 #dfdfdf;
    font:11px "MS Sans Serif",Tahoma,sans-serif;
    outline:none;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-search input {
    background:#0f0f0f; color:#fff;
    border-color:#000 #5a5a5a #5a5a5a #000;
    box-shadow:inset 1px 1px 0 #141414, inset -1px -1px 0 #3a3a3a;
  }

  /* Body */
  .wd-emoji-picker .wd-emoji-body {
    display:flex; flex-direction:column;
    background:#dfdfdf;
    padding:4px;
    max-height:260px; overflow-y:auto;
    border:2px solid; border-color:#404040 #fff #fff #404040;
    margin:4px;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-body {
    background:#1a1a1a;
    border-color:#000 #5a5a5a #5a5a5a #000;
  }
  /* 7TV-style section header — horizontal rule wrapping a chip-label */
  .wd-emoji-picker .wd-emoji-grp {
    display:flex; align-items:center; gap:6px;
    font-weight:bold; font-size:10px; color:#404040;
    letter-spacing:1px; text-transform:uppercase;
    margin:8px 0 4px;
  }
  .wd-emoji-picker .wd-emoji-grp:first-child { margin-top:0 }
  .wd-emoji-picker .wd-emoji-grp::before,
  .wd-emoji-picker .wd-emoji-grp::after {
    content:""; flex:1; height:0;
    border-top:1px solid #808080;
    box-shadow:0 1px 0 #fff;
  }
  .wd-emoji-picker .wd-emoji-grp .wd-emoji-grp-chip {
    display:inline-flex; align-items:center; gap:4px;
    background:#c0c0c0; color:#000;
    border:1px solid; border-color:#fff #404040 #404040 #fff;
    padding:2px 8px; font-size:10px; font-weight:bold;
    box-shadow:inset 1px 1px 0 #dfdfdf, 0 1px 0 #fff;
    letter-spacing:.5px;
  }
  .wd-emoji-picker .wd-emoji-grp .wd-emoji-grp-dot {
    width:6px; height:6px; border-radius:50%; background:#08c;
    box-shadow:0 0 3px #08c;
  }
  .wd-emoji-picker .wd-emoji-grp .wd-emoji-grp-count {
    color:#666; font-weight:normal;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-grp { color:#aaa }
  .wd-emoji-picker.wd-dark .wd-emoji-grp::before,
  .wd-emoji-picker.wd-dark .wd-emoji-grp::after {
    border-top-color:#3a3a3a; box-shadow:0 1px 0 #141414;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-grp .wd-emoji-grp-chip {
    background:#2c2c2c; color:#fff;
    border-color:#5a5a5a #000 #000 #5a5a5a;
    box-shadow:inset 1px 1px 0 #3a3a3a, 0 1px 0 #141414;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-grp .wd-emoji-grp-count { color:#888 }

  /* Grid of emote tiles */
  .wd-emoji-picker .wd-emoji-grid {
    display:grid;
    grid-template-columns:repeat(8, 32px);
    gap:2px;
    padding:0;
    justify-content:start;
  }
  .wd-emoji-picker .wd-emoji-grid img {
    width:32px; height:32px; cursor:pointer;
    image-rendering:pixelated;
    border:1px solid transparent;
    padding:1px;
    background:transparent;
    transition:none;
  }
  .wd-emoji-picker .wd-emoji-grid img:hover {
    background:#000080; border-color:#fff;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-grid img:hover {
    background:#3838aa; border-color:#3838aa;
  }

  /* Status bar */
  .wd-emoji-picker .wd-emoji-status {
    border-top:1px solid #808080;
    box-shadow:inset 0 1px 0 #fff;
    padding:2px 8px;
    background:#c0c0c0;
    color:#404040;
    font:10px "MS Sans Serif",sans-serif;
    display:flex; justify-content:space-between;
  }
  .wd-emoji-picker.wd-dark .wd-emoji-status {
    background:#2c2c2c; color:#aaa;
    border-top-color:#141414; box-shadow:inset 0 1px 0 #3a3a3a;
  }

  /* .wd-site-emoji-btn CSS lives in site-chat-emotes.ts so it loads
     BEFORE the button itself is created. Don't re-inject it here. */
  `;
  document.head.appendChild(style);
}

function syncTheme(): void {
  if (!picker) return;
  picker.classList.toggle("wd-dark", isWalldevDark());
}

export function ensureEmojiPicker(): HTMLElement {
  if (picker) return picker;
  injectCss();
  picker = document.createElement("div");
  picker.className = "wd-emoji-picker";
  const titleIcon = `<svg width="16" height="16" viewBox="0 0 24 24" style="vertical-align:-3px">
    <circle cx="12" cy="12" r="10" fill="#ffd84a" stroke="#000" stroke-width="1.5"/>
    <ellipse cx="9" cy="10" rx="1.3" ry="1.7" fill="#000"/>
    <ellipse cx="15" cy="10" rx="1.3" ry="1.7" fill="#000"/>
    <path d="M7.5 13.5 Q12 18.5 16.5 13.5" stroke="#000" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  </svg>`;
  picker.innerHTML = `
    <div class="wd-emoji-tb">
      <span class="wd-emoji-tb-title">
        <span class="wd-emoji-tb-led"></span>
        ${titleIcon}
        <span>7TV Emotes</span>
      </span>
      <span class="wd-emoji-x" role="button" title="Close">✕</span>
    </div>
    <div class="wd-emoji-search"><input id="wd-emoji-search" name="wd_emoji_search" type="text" placeholder="🔍 Search emotes…" autocomplete="off"></div>
    <div class="wd-emoji-body"></div>
    <div class="wd-emoji-status"><span class="left">Ready</span><span class="right">7TV · The Wall Dev</span></div>`;
  document.body.appendChild(picker);
  bodyEl = picker.querySelector(".wd-emoji-body") as HTMLElement;

  // Close button + outside click
  picker.querySelector(".wd-emoji-x")?.addEventListener("click", closeEmojiPicker);
  document.addEventListener("mousedown", (e) => {
    if (!picker || !picker.classList.contains("open")) return;
    const t = e.target as Node;
    if (picker.contains(t)) return;
    if ((e.target as HTMLElement).closest?.("[data-wd-emoji-anchor]")) return;
    closeEmojiPicker();
  });

  // Drag from titlebar
  const tb = picker.querySelector<HTMLElement>(".wd-emoji-tb")!;
  let dragging = false, dx = 0, dy = 0;
  tb.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).classList.contains("wd-emoji-x")) return;
    dragging = true;
    const r = picker!.getBoundingClientRect();
    dx = e.clientX - r.left; dy = e.clientY - r.top;
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging || !picker) return;
    picker.style.left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - dx)) + "px";
    picker.style.top  = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy)) + "px";
  });
  document.addEventListener("mouseup", () => { dragging = false; });

  // Search filter
  const search = picker.querySelector<HTMLInputElement>(".wd-emoji-search input")!;
  search.addEventListener("input", () => renderBody(search.value.trim().toLowerCase()));

  // React to live theme changes.
  document.addEventListener("wd:theme-changed", syncTheme);

  return picker;
}

function setStatus(text: string): void {
  const left = picker?.querySelector<HTMLElement>(".wd-emoji-status .left");
  if (left) left.textContent = text;
}

function escHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"} as any)[c]);
}

function renderBody(filter = ""): void {
  if (!bodyEl) return;
  bodyEl.innerHTML = "";
  const grouped = getEmotesGrouped();
  let total = 0;
  let shown = 0;
  grouped.forEach((emotes, group) => {
    const isChannel = group.startsWith("#");
    const channel = isChannel ? group.slice(1) : "";
    const labelText = group === "global" ? "Global · 7TV" : `#${channel}`;

    const entries: Array<[string, string]> = [];
    emotes.forEach((id, name) => {
      total++;
      if (!filter || name.toLowerCase().includes(filter)) entries.push([name, id]);
    });
    if (!entries.length) return;

    const header = document.createElement("div");
    header.className = "wd-emoji-grp";
    header.innerHTML = `<span class="wd-emoji-grp-chip">
      <span class="wd-emoji-grp-dot"></span>
      <span>${escHtml(labelText)}</span>
      <span class="wd-emoji-grp-count">· ${entries.length}</span>
    </span>`;
    bodyEl!.appendChild(header);

    const grid = document.createElement("div");
    grid.className = "wd-emoji-grid";
    for (const [name, id] of entries) {
      const img = document.createElement("img");
      img.src = `https://cdn.7tv.app/emote/${id}/1x.webp`;
      img.alt = `:${name}:`;
      img.title = isChannel ? `:${channel}:${name}:` : `:${name}:`;
      img.loading = "lazy";
      img.addEventListener("click", () => {
        const ins = isChannel ? `:${channel}:${name}: ` : `:${name}: `;
        insertIntoTarget(ins);
      });
      grid.appendChild(img);
      shown++;
    }
    bodyEl!.appendChild(grid);
  });
  setStatus(filter ? `${shown} / ${total}` : `${total} emotes`);
}

function insertIntoTarget(text: string): void {
  const t = currentTarget;
  if (!t) return;
  const start = (t as any).selectionStart ?? t.value.length;
  const end = (t as any).selectionEnd ?? start;
  t.value = t.value.slice(0, start) + text + t.value.slice(end);
  const caret = start + text.length;
  t.focus();
  try { (t as any).setSelectionRange(caret, caret); } catch {}
  // Fire input event so listeners (like the site's input handler) react.
  t.dispatchEvent(new Event("input", { bubbles: true }));
}

export interface OpenOpts { theme?: "auto" | "light" | "dark" }

export async function openEmojiPicker(
  target: EmojiTarget,
  anchor: HTMLElement,
  opts: OpenOpts = {},
): Promise<void> {
  const p = ensureEmojiPicker();
  currentTarget = target;

  // Theme — apply explicit override, otherwise mirror walldev-tool.
  const dark = opts.theme === "dark" || (opts.theme !== "light" && isWalldevDark());
  p.classList.toggle("wd-dark", dark);

  // Position near the anchor (above-or-below depending on space).
  const r = anchor.getBoundingClientRect();
  const pickerW = 300;
  const pickerH = 320;
  const spaceBelow = window.innerHeight - r.bottom;
  const placeAbove = spaceBelow < pickerH + 8 && r.top > pickerH + 8;
  p.style.left = Math.max(8, Math.min(r.right - pickerW, window.innerWidth - pickerW - 8)) + "px";
  p.style.top  = (placeAbove ? r.top - pickerH - 4 : r.bottom + 4) + "px";

  // Load emotes if needed.
  if (!getEmoteMap().size) {
    setStatus("Loading…");
    p.classList.add("open");
    renderBody();
    try { await initEmotes(); } catch { setStatus("Load failed"); return; }
  } else {
    p.classList.add("open");
  }
  // Reset search and render.
  const search = p.querySelector<HTMLInputElement>(".wd-emoji-search input");
  if (search) search.value = "";
  renderBody();
  search?.focus();
}

export function closeEmojiPicker(): void {
  picker?.classList.remove("open");
}
