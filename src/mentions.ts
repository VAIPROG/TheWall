/**
 * @username autocomplete + render @mentions as styled links.
 *
 * Architectural notes:
 *   - The suggest box gets re-parented to document.body the first time it's
 *     attached. Without that, it gets clipped by ancestor overflow.
 *   - Position calculation prefers placing the popup BELOW the textarea; if
 *     that goes offscreen we flip ABOVE. Always fits within viewport edges.
 *   - When the roster fetch returns empty we fall back to whatever usernames
 *     are currently visible in the chat log so users get *some* suggestions.
 *   - On every keystroke we re-filter from cached users; only the initial
 *     fetch hits the network.
 */
import { log } from "./log";

export type UserItem = { username: string; id?: string; avatar_url?: string };

const MENTION_RX_RENDER = /(^|[\s>(])@([a-zA-Z0-9_]{2,32})\b/g;
const MENTION_RX_INPUT  = /@([a-zA-Z0-9_]{0,32})$/;

export function renderMentions(html: string): string {
  return html.replace(MENTION_RX_RENDER, (_m, lead: string, name: string) =>
    `${lead}<span class="wp-mention" data-user="${name}">@${name}</span>`);
}

function scanVisibleUsernames(): UserItem[] {
  const set = new Set<string>();
  document.querySelectorAll(".chat-log .list b").forEach((el) => {
    const n = (el.textContent || "").trim();
    if (n && /^[a-zA-Z0-9_]{2,32}$/.test(n)) set.add(n);
  });
  document.querySelectorAll("#walldev-tool .au, #walldev-tool .wp-mention").forEach((el) => {
    const n = ((el as HTMLElement).dataset.user || el.textContent || "").trim().replace(/^@/, "");
    if (n && /^[a-zA-Z0-9_]{2,32}$/.test(n)) set.add(n);
  });
  return [...set].sort().map(username => ({ username }));
}

export interface MentionsHandle { destroy(): void }

export function attachMentions(
  ta: HTMLTextAreaElement,
  suggestEl: HTMLElement,
  fetchUsers: () => Promise<UserItem[]>,
): MentionsHandle {
  let users: UserItem[] = [];
  let filtered: UserItem[] = [];
  let selIdx = 0;
  let activeStart = -1;

  // Reparent to body so overflow doesn't clip us.
  if (suggestEl.parentElement !== document.body) document.body.appendChild(suggestEl);
  // Make sure it has the visual classes even if it was inline-styled before.
  suggestEl.classList.add("wp-mention-suggest");

  // Populate cache (network is best-effort; we always have the visible fallback).
  Promise.resolve()
    .then(fetchUsers)
    .then((u) => {
      users = u.length ? u : scanVisibleUsernames();
      log.info("MENTIONS", `${ta.id || "<textarea>"}: ${users.length} candidates (${u.length ? "from API" : "from visible chat"})`);
    })
    .catch((e) => {
      users = scanVisibleUsernames();
      log.warn("MENTIONS", `${ta.id || "<textarea>"}: fetch failed, fallback to ${users.length} visible`, e);
    });

  function refreshUsersFromVisibleIfEmpty(): void {
    if (users.length === 0) users = scanVisibleUsernames();
  }

  function close(): void {
    suggestEl.classList.remove("open");
    suggestEl.innerHTML = "";
    activeStart = -1;
  }

  function positionPopup(): void {
    const r = ta.getBoundingClientRect();
    const popH = suggestEl.offsetHeight || 140;
    const popW = Math.min(220, window.innerWidth - 16);
    const spaceBelow = window.innerHeight - r.bottom;
    const placeAbove = spaceBelow < popH + 8 && r.top > popH + 8;

    suggestEl.style.position = "fixed";
    suggestEl.style.width = popW + "px";
    suggestEl.style.maxHeight = "180px";
    suggestEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - popW - 8)) + "px";
    if (placeAbove) {
      suggestEl.style.top = (r.top - popH - 4) + "px";
    } else {
      suggestEl.style.top = (r.bottom + 4) + "px";
    }
    suggestEl.style.transform = "";
  }

  function render(): void {
    if (!filtered.length) { close(); return; }
    suggestEl.innerHTML = filtered.slice(0, 8).map((u, i) =>
      `<div class="item${i === selIdx ? " sel" : ""}" data-i="${i}">
        ${u.avatar_url ? `<img src="${u.avatar_url}" style="width:16px;height:16px;border-radius:50%;flex:none">` : ""}
        <span>@${u.username}</span>
      </div>`).join("");

    suggestEl.classList.add("open");
    positionPopup();

    suggestEl.querySelectorAll(".item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const i = parseInt((el as HTMLElement).dataset.i || "0", 10);
        pick(filtered[i]);
      });
    });
  }

  function pick(u: UserItem): void {
    if (activeStart < 0) return;
    const before = ta.value.slice(0, activeStart);
    const after = ta.value.slice(ta.selectionStart || ta.value.length);
    const inject = `@${u.username} `;
    ta.value = before + inject + after;
    const caret = before.length + inject.length;
    ta.focus();
    ta.setSelectionRange(caret, caret);
    close();
  }

  function update(): void {
    refreshUsersFromVisibleIfEmpty();
    const caret = ta.selectionStart || 0;
    const upto = ta.value.slice(0, caret);
    const m = upto.match(MENTION_RX_INPUT);
    if (!m) { close(); return; }
    activeStart = caret - m[0].length;
    const q = m[1].toLowerCase();
    filtered = (q ? users.filter(u => u.username.toLowerCase().startsWith(q)) : users.slice()).slice(0, 8);
    selIdx = 0;
    render();
  }

  function onKey(e: KeyboardEvent): void {
    if (!suggestEl.classList.contains("open") || !filtered.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); selIdx = (selIdx + 1) % filtered.length; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = (selIdx - 1 + filtered.length) % filtered.length; render(); }
    else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(filtered[selIdx]); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
  }

  ta.addEventListener("input", update);
  ta.addEventListener("click", update);
  ta.addEventListener("keydown", onKey);
  ta.addEventListener("blur", () => setTimeout(close, 120));
  window.addEventListener("resize", positionPopup);
  window.addEventListener("scroll", positionPopup, true);

  return {
    destroy() {
      ta.removeEventListener("input", update);
      ta.removeEventListener("click", update);
      ta.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", positionPopup);
      window.removeEventListener("scroll", positionPopup, true);
      close();
    }
  };
}
