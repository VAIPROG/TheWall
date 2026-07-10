import { DISCORD_CDN } from "./constants";

export const $ = (id: string): HTMLElement | null =>
  document.getElementById(id);

export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      (
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }) as Record<string, string>
      )[c],
  );
}

export function guildIcon(id: string, icon: string | null | undefined): string {
  return icon
    ? `${DISCORD_CDN}/icons/${id}/${icon}.${icon.startsWith("a_") ? "gif" : "png"}?size=64`
    : "";
}

export function defaultDiscordAvatar(uid: string): string {
  try {
    return `${DISCORD_CDN}/embed/avatars/${Number(BigInt(uid) >> 22n) % 6}.png`;
  } catch {
    return `${DISCORD_CDN}/embed/avatars/0.png`;
  }
}

export function avatarSrcs(
  wallId: string | number | null,
  discordId: string | null | undefined,
  backendBase: string,
  hasCustomAvatar?: boolean,
): string[] {
  const out: string[] = [];
  // Prefer custom backend avatar only if we know one exists (avoids spurious 404).
  if (hasCustomAvatar && backendBase && wallId != null) {
    out.push(
      `${backendBase}/avatar?userId=${encodeURIComponent(String(wallId))}`,
    );
  }
  // Discord proxied avatar (server caches + serves the right hash).
  if (backendBase && discordId) {
    out.push(
      `${backendBase}/discord/avatar?userId=${encodeURIComponent(discordId)}`,
    );
  }
  // Final fallback: Discord's default embed avatar (color tile).
  out.push(defaultDiscordAvatar(discordId || "0"));
  return out;
}

export function avImg(srcs: string[], cls?: string): string {
  return `<img class="${cls || ""}" data-srcs="${esc(srcs.join("|"))}">`;
}

export function wireAvatars(root?: HTMLElement | Document | null): void {
  (root || document)
    .querySelectorAll<HTMLImageElement>("img[data-srcs]")
    .forEach((img) => {
      const list = (img.dataset.srcs || "").split("|").filter(Boolean);
      let i = 0;
      const next = () => {
        if (i < list.length) img.src = list[i++];
        else {
          img.onerror = null;
          img.style.visibility = "hidden";
        }
      };
      img.removeAttribute("data-srcs");
      img.onerror = next;
      next();
    });
}

/** Pull a readable message out of whatever was thrown. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === "string" ? m : String(e ?? "error");
}

/** A single line shown inside a list when it's empty, loading, or errored. */
export function noteBox(msg: string, tone: "err" | "sub" = "sub"): string {
  const color = tone === "err" ? "#b33" : "var(--sub)";
  return `<div style="padding:6px;color:${color}">${esc(msg)}</div>`;
}

// The tabs all render the same kind of list: a flex row with an ellipsizing
// label and a few small action buttons. These three keep that consistent
// (styles live in styles.ts as .wp-row-item / .wp-row-grow / .wp-btn-mini).

export function listRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "wp-row-item";
  return row;
}

export function growLabel(text: string, title?: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = "wp-row-grow";
  el.textContent = text;
  if (title) el.title = title;
  return el;
}

export function miniBtn(
  label: string,
  onClick: () => void,
  title?: string,
): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "wp-btn wp-btn-mini";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export function mdToHtml(src: string): string {
  let s = esc(src);

  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*]+?)\*/g, "$1<i>$2</i>");

  s = s.replace(/\[([^\]]+?)\]\(\s*([^\s)]+?)\s*\)/g, (match, text, url) => {
    let href = url;

    if (!href.startsWith("http://") && !href.startsWith("https://")) {
      if (href.startsWith("www.")) {
        href = "https://" + href;
      } else if (!href.startsWith("/") && !href.startsWith("#")) {
      }
    }

    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  s = s.replace(/\n/g, "<br>");
  return s;
}
