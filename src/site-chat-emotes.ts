/**
 * Render 7TV emotes inside filianislost's native chat (both Local and Global).
 *
 * Live DOM shape on the site:
 *   <div class="chat-log">
 *     <div class="list">
 *       <p class="box" data-uid="…"><b>name</b><span>:EZ:</span></p>
 *       ...
 *     </div>
 *   </div>
 *
 * We only walk the trailing text/<span> nodes inside each <p>, skipping the
 * <b> username so we never touch the site's identity rendering.
 *
 * No site code is modified — we only read/mutate the DOM produced by the site,
 * the same way any browser extension would.
 */
import { cfg } from "./config";
import { getEmoteMap, getEmotesGrouped, initEmotes } from "./emoji";
import { openEmojiPicker } from "./emoji-picker";
import { isWalldevDark } from "./theme";
import { log } from "./log";

/** Custom SVG icon for the emoji button — Win95-styled smiley with a 7TV mark. */
const EMOJI_ICON_SVG = `<svg class="wd-emote-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="wdSmileyBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd84a"/>
      <stop offset="1" stop-color="#e8a000"/>
    </linearGradient>
  </defs>
  <!-- outer ring -->
  <circle cx="12" cy="12" r="10" fill="url(#wdSmileyBg)" stroke="#000" stroke-width="1.5"/>
  <!-- inner highlight -->
  <circle cx="9" cy="9" r="2.4" fill="#fff8c8" opacity=".7"/>
  <!-- eyes -->
  <ellipse cx="8.6" cy="10" rx="1.2" ry="1.6" fill="#000"/>
  <ellipse cx="15.4" cy="10" rx="1.2" ry="1.6" fill="#000"/>
  <!-- smile -->
  <path d="M7.5 13.5 Q12 18.5 16.5 13.5" stroke="#000" stroke-width="1.8" fill="none" stroke-linecap="round"/>
  <!-- 7TV badge bottom-right -->
  <rect x="15" y="15" width="9" height="6" rx="1" fill="#29d" stroke="#fff" stroke-width=".8"/>
  <text x="19.5" y="19.6" text-anchor="middle" fill="#fff" font-family="Verdana,sans-serif" font-size="4.5" font-weight="bold">7TV</text>
</svg>`;

/**
 * Inject the button's CSS up-front, *before* the button is created. This used
 * to live inside the emoji picker's `injectCss()` which only ran on the first
 * click — so a freshly reloaded page in dark mode would render the button as
 * a bright Win95-default rectangle until the user clicked it. We now own the
 * style ourselves and call this from `ensureSiteEmojiButton()`.
 */
function injectButtonCss(): void {
  if (document.getElementById("wd-site-emoji-btn-css")) return;
  const style = document.createElement("style");
  style.id = "wd-site-emoji-btn-css";
  style.textContent = `
  .wd-site-emoji-btn {
    display:inline-flex; align-items:center; justify-content:center;
    width:34px; height:34px;
    padding:0; margin:0 4px; cursor:pointer;
    background:#c0c0c0;
    border:2px solid; border-color:#fff #404040 #404040 #fff;
    box-shadow:inset 1px 1px 0 #dfdfdf, inset -1px -1px 0 #808080;
    font:bold 14px sans-serif;
    color:#000;
    transition:none;
  }
  .wd-site-emoji-btn.wd-dark {
    background:#2c2c2c; color:#fff;
    border-color:#5a5a5a #000 #000 #5a5a5a;
    box-shadow:inset 1px 1px 0 #3a3a3a, inset -1px -1px 0 #141414;
  }
  .wd-site-emoji-btn:hover { filter:brightness(1.04) }
  .wd-site-emoji-btn:active {
    border-color:#404040 #fff #fff #404040;
    box-shadow:inset -1px -1px 0 #dfdfdf, inset 1px 1px 0 #808080;
  }
  .wd-site-emoji-btn.wd-dark:active {
    border-color:#000 #5a5a5a #5a5a5a #000;
    box-shadow:inset -1px -1px 0 #3a3a3a, inset 1px 1px 0 #141414;
  }
  .wd-site-emoji-btn .wd-emote-icon {
    width:22px; height:22px; display:block; pointer-events:none;
  }
  /* Site chat 7TV emote inline image */
  .wd-emote {
    height:1.6em; vertical-align:middle; margin:0 1px;
  }
  .wd-emote-clickable {
    cursor:pointer;
    border-radius:2px;
    transition:filter .12s;
  }
  .wd-emote-clickable:hover {
    filter:drop-shadow(0 0 3px rgba(122,62,176,.7)) brightness(1.05);
  }
  `;
  document.head.appendChild(style);
}

const PROCESSED_ATTR = "wd-emoted";
const CHAT_LIST_SEL = ".chat-log .list";
const MESSAGE_SEL = ":scope > p, :scope > div, :scope > li";

let observer: MutationObserver | null = null;
let nestedObserver: MutationObserver | null = null;
let bubbleObserver: MutationObserver | null = null;

const channelEmoteSyntax = /:([a-zA-Z0-9_]+):([a-zA-Z0-9_]+):/g;
const plainEmoteSyntax = /:([a-zA-Z0-9_]+):/g;

function lookup(token: string, channel?: string): string | undefined {
  if (channel) {
    return getEmotesGrouped().get(`#${channel}`)?.get(token);
  }
  return getEmoteMap().get(token);
}

function makeImg(id: string, name: string): HTMLImageElement {
  const img = document.createElement("img");
  img.src = `https://cdn.7tv.app/emote/${id}/1x.webp`;
  img.alt = `:${name}:`;
  img.title = `:${name}: — click to reuse`;
  img.className = "wd-emote wd-emote-clickable";
  img.loading = "lazy";
  // Mirror the site's f4() behavior: clicking a username inserts it into the
  // chat input. We do the same for 7TV emotes so a viewer can "quote" an
  // emote with one click instead of typing :name: by hand.
  img.dataset.emoteName = name;
  return img;
}

function insertEmoteIntoChat(name: string): void {
  const input = document.querySelector<HTMLInputElement>("#chat-input-field");
  if (!input) return;
  const cur = input.value || "";
  const sep = cur && !/\s$/.test(cur) ? " " : "";
  const next = `${cur}${sep}:${name}: `;
  // Respect maxLength if the site set one.
  const max = (input as HTMLInputElement).maxLength;
  input.value = max > 0 ? next.slice(0, max) : next;
  input.focus();
  // Fire `input` so any keystroke-driven cooldown / character counter the
  // site might watch updates.
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function processTextNode(node: Text): void {
  const text = node.nodeValue || "";
  if (!text.includes(":")) return;

  const frag = document.createDocumentFragment();
  let last = 0;
  let mutated = false;

  // Walk through combined matches. We replay both regexes by scanning
  // character-by-character logic equivalent: try channel-syntax first at each
  // colon position, fall back to plain.
  let i = 0;
  while (i < text.length) {
    if (text[i] !== ":") { i++; continue; }

    // Try :channel:emote: starting at i
    channelEmoteSyntax.lastIndex = i;
    const m2 = channelEmoteSyntax.exec(text);
    if (m2 && m2.index === i) {
      const id = lookup(m2[2], m2[1]);
      if (id) {
        if (last < i) frag.appendChild(document.createTextNode(text.slice(last, i)));
        frag.appendChild(makeImg(id, `${m2[1]}:${m2[2]}`));
        i = m2.index + m2[0].length;
        last = i;
        mutated = true;
        continue;
      }
    }

    // Try :emote: starting at i
    plainEmoteSyntax.lastIndex = i;
    const m1 = plainEmoteSyntax.exec(text);
    if (m1 && m1.index === i) {
      const id = lookup(m1[1]);
      if (id) {
        if (last < i) frag.appendChild(document.createTextNode(text.slice(last, i)));
        frag.appendChild(makeImg(id, m1[1]));
        i = m1.index + m1[0].length;
        last = i;
        mutated = true;
        continue;
      }
    }
    i++;
  }
  if (!mutated) return;
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  node.parentNode?.replaceChild(frag, node);
}

function walkTextNodes(root: Element): void {
  const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const todo: Text[] = [];
  let n: Node | null;
  while ((n = it.nextNode())) {
    const p = (n as Text).parentElement;
    if (!p) continue;
    // Skip the username <b>, code-like nodes, our own emote img alts.
    if (p.closest("script,style,code,pre,b")) continue;
    if (p.classList.contains("wd-emote")) continue;
    todo.push(n as Text);
  }
  for (const t of todo) processTextNode(t);
}

function processMessage(el: Element): void {
  if (el.getAttribute(`data-${PROCESSED_ATTR}`) === "1") return;
  el.setAttribute(`data-${PROCESSED_ATTR}`, "1");
  walkTextNodes(el);
}

function processList(list: Element): void {
  list.querySelectorAll(":scope > p, :scope > div, :scope > li").forEach(processMessage);
}

/**
 * Process chat-bubbles. The site's `t2($, Q)` appends a `<p>` with the
 * message text to `.chat-bubble`; the bubble itself is parented to the
 * cursor's element which can live anywhere in the DOM. To catch them with
 * one observer we watch the whole document subtree and, on each mutation,
 * process any newly-added `<p>` whose parent is a `.chat-bubble`.
 *
 * We deliberately skip the bubble's own `<span>` (it holds username + clan
 * tag) and only walk `<p>` children — that's where chat text lives.
 */
function processBubble(bubble: Element): void {
  bubble.querySelectorAll<HTMLElement>(":scope > p").forEach((p) => {
    if (p.dataset.wdBubbleEmoted === "1") return;
    p.dataset.wdBubbleEmoted = "1";
    walkTextNodes(p);
  });
}

function attachBubbleObserver(): void {
  if (bubbleObserver) return;
  bubbleObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      mu.addedNodes.forEach((n) => {
        if (!(n instanceof Element)) return;
        // Direct chat-bubble addition (cursor element re-created).
        if (n.classList?.contains("chat-bubble")) {
          processBubble(n);
        } else {
          // <p> appended inside an existing bubble.
          if (n.tagName === "P" && (n.parentElement?.classList.contains("chat-bubble") ?? false)) {
            walkTextNodes(n);
          }
          // Sub-tree changes that may contain new bubbles.
          n.querySelectorAll?.(".chat-bubble").forEach((b) => processBubble(b));
        }
      });
    }
  });
  bubbleObserver.observe(document.body, { childList: true, subtree: true });
  // Initial sweep over anything already on screen.
  document.querySelectorAll(".chat-bubble").forEach((b) => processBubble(b));
}

function attachNestedObserver(list: Element): void {
  if (nestedObserver) { nestedObserver.disconnect(); nestedObserver = null; }
  nestedObserver = new MutationObserver((muts) => {
    for (const mu of muts) {
      mu.addedNodes.forEach((n) => {
        if (n instanceof Element && n.matches?.(MESSAGE_SEL.replace(/:scope > /g, ""))) {
          processMessage(n);
        }
      });
    }
  });
  nestedObserver.observe(list, { childList: true });
  // Initial sweep.
  processList(list);
}

let boundList: Element | null = null;

function ensureListWatched(): void {
  const list = document.querySelector(CHAT_LIST_SEL);
  if (!list) return;
  // Site source: `var s6 = G("div.list"), e8 = G("div.list")` — Local and
  // Global modes own different .list nodes that get swapped via
  // `e8.replaceWith(s6)` when the user toggles tabs. The old `dataset` flag
  // only checks whether the node has *ever* been bound, so after a toggle
  // we'd hold an observer on a detached node and the visible list would not
  // get its emotes rendered. Track the actual observed reference instead.
  if (list === boundList && list.isConnected) return;
  attachNestedObserver(list);
  boundList = list;
  log("SITE_EMOTES", "OK", "chat-log list bound");
}

/**
 * Inject a small Win95-styled 7TV button next to the site's send button,
 * wired to the shared emoji picker.
 */
function syncSiteBtnTheme(btn: HTMLElement): void {
  btn.classList.toggle("wd-dark", isWalldevDark());
}

function ensureSiteEmojiButton(): void {
  const sendBtn = document.querySelector<HTMLButtonElement>("#tool-send-btn");
  const input = document.querySelector<HTMLInputElement>("#chat-input-field");
  if (!sendBtn || !input) {
    // Quiet — fires constantly during boot. Only log once.
    if (!(document as any).__wallChatBtnWaited) {
      (document as any).__wallChatBtnWaited = true;
      log("SITE_EMOTES", "INFO", `waiting for #tool-send-btn=${!!sendBtn} #chat-input-field=${!!input}`);
    }
    return;
  }
  if (document.getElementById("wd-site-emoji-btn")) return;

  // Own the button CSS before constructing the element so it never renders
  // unstyled. injectButtonCss() is idempotent.
  injectButtonCss();

  const btn = document.createElement("button");
  btn.id = "wd-site-emoji-btn";
  btn.className = "wd-site-emoji-btn";
  btn.type = "button";
  btn.title = "Insert 7TV emote";
  btn.setAttribute("aria-label", "Insert 7TV emote");
  btn.setAttribute("data-wd-emoji-anchor", "1");
  btn.innerHTML = EMOJI_ICON_SVG;
  syncSiteBtnTheme(btn);

  sendBtn.parentElement?.insertBefore(btn, sendBtn);

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openEmojiPicker(input, btn);
  });
  document.addEventListener("wd:theme-changed", () => syncSiteBtnTheme(btn));

  // Belt-and-braces: re-sync the theme after a paint frame and once after
  // 1 s in case applyTheme() runs *after* we injected.
  requestAnimationFrame(() => syncSiteBtnTheme(btn));
  setTimeout(() => syncSiteBtnTheme(btn), 1000);

  log("SITE_EMOTES", "OK", `site emoji button injected (dark=${btn.classList.contains("wd-dark")})`);
}

export function startSiteChatEmotes(): void {
  if (!cfg.injectSiteEmotes) return;
  if (observer) return;

  // Make sure emotes are loaded; once they are, do an initial sweep.
  initEmotes().then(() => {
    ensureListWatched();
    ensureSiteEmojiButton();
  }).catch(() => {});

  // The chat list / input controls may be (re)created — watch body for them.
  observer = new MutationObserver(() => {
    ensureListWatched();
    ensureSiteEmojiButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  ensureListWatched();
  ensureSiteEmojiButton();
  attachBubbleObserver();

  // Delegated click: turn every 7TV emote into a "quote-back" affordance,
  // mirroring the site's own f4() username-insert behavior. Body-level so it
  // survives list swaps between Local/Global modes.
  if (!(document as any).__wdEmoteClickBound) {
    (document as any).__wdEmoteClickBound = true;
    document.addEventListener("click", (e) => {
      const t = e.target as HTMLElement | null;
      if (!t || !t.classList?.contains("wd-emote-clickable")) return;
      const name = t.dataset.emoteName;
      if (!name) return;
      e.preventDefault();
      e.stopPropagation();
      insertEmoteIntoChat(name);
    }, true);
  }
}

export function stopSiteChatEmotes(): void {
  observer?.disconnect();
  nestedObserver?.disconnect();
  bubbleObserver?.disconnect();
  observer = null;
  nestedObserver = null;
  bubbleObserver = null;
}
