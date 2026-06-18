import { cfg, saveCfg } from "./config";
import { SEL } from "./constants";
import { $ } from "./helpers";
import { log } from "./log";
import { Backend, getMe } from "./backend";

let clanNames = new Set<string>();

export function injectCursorStyle(): void {
  let s = $("wd-cursor-style") as HTMLStyleElement | null;
  if (!s) {
    s = document.createElement("style");
    s.id = "wd-cursor-style";
    document.head.appendChild(s);
  }
  if (cfg.cursorMode === "clan") {
    const sel = cfg.cursorSelector || '[class*="cursor"]';
    s.textContent = `${sel}:not(.wd-mate):not(.wd-self){opacity:0 !important;pointer-events:none !important}`;
  } else s.textContent = "";
}

export function tagCursors(): void {
  if (cfg.cursorMode !== "clan") return;
  const sel = cfg.cursorSelector || '[class*="cursor"]';
  document.querySelectorAll(sel).forEach((n) => {
    const label = (
      n.textContent ||
      n.getAttribute("data-name") ||
      n.getAttribute("title") ||
      ""
    ).trim().toLowerCase();
    if (label && clanNames.has(label)) n.classList.add("wd-mate");
  });
}

let cursorObs: MutationObserver | null = null;

export function startCursorWatch(): void {
  const layers = document.querySelector(SEL.paintLayers);
  if (!layers || cursorObs) return;
  let raf = 0;
  cursorObs = new MutationObserver(() => {
    if (!raf)
      raf = requestAnimationFrame(() => {
        raf = 0;
        tagCursors();
      });
  });
  cursorObs.observe(layers, { childList: true, subtree: true });
}

export async function refreshClanNames(): Promise<void> {
  clanNames = new Set();
  const me = getMe();
  if (me && me.username) clanNames.add(String(me.username).toLowerCase());
  if (Backend.on) {
    try {
      const ms = await Backend.clanMembers();
      (ms || []).forEach(
        (m: any) => m.username && clanNames.add(String(m.username).toLowerCase()),
      );
    } catch (e: any) {
      log("CLAN_MEMBERS", "WARN", e.toString());
    }
  }
}

export async function applyCursorMode(): Promise<void> {
  injectCursorStyle();
  if (cfg.cursorMode === "clan") {
    await refreshClanNames();
    startCursorWatch();
    tagCursors();
  }
}
