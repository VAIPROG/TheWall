/**
 * PURE message → HTML for the Community chat thread. Import-safe in bare Bun:
 * imports only string transforms (`../../helpers`, `../../mentions`) and the
 * DOM-free `./api` facade — no emoji-picker, no top-level `document` access.
 * This is the unit-tested half of the thread; `thread.ts` owns the DOM.
 *
 * XSS discipline: ALL user content flows through `mdToHtml` (which starts with
 * `esc`) then `renderMentions`; author names go through `esc`. User strings are
 * never raw-injected.
 */
import { esc, mdToHtml } from "../../helpers";
import { renderMentions } from "../../mentions";
import { avatarUrl, type Message } from "./api";

export interface RenderCtx {
  /** The viewer's user id (for own-message edit/delete gating). */
  meId?: string;
  /** Whether the viewer can moderate this chat (pin/others' actions). */
  canModerate?: boolean;
  /**
   * Optional 7TV emote replacer, applied to the already-escaped message body
   * HTML (turns `:emote:` shortcodes into `<img class="wd-emote">`). Injected
   * by the DOM host (`thread.ts` passes `replaceEmotes`) so this module stays
   * pure + bare-Bun import-safe; defaults to identity when absent.
   */
  emotes?: (html: string) => string;
}

/** Compact, locale-aware timestamp. Pure: falls back to "" on a bad date. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d.toISOString();
  }
}

/** One reaction chip. Emoji is escaped for display but URL-encoded in the
 *  data attribute so the click handler can round-trip it cleanly. */
function reactionChip(mid: string, emoji: string, count: number, on: boolean): string {
  return (
    `<button type="button" class="wd-comm-react${on ? " is-on" : ""}"` +
    ` data-react="${encodeURIComponent(emoji)}" data-mid="${esc(mid)}">` +
    `${esc(emoji)} <span class="wd-comm-react-n">${esc(String(count))}</span></button>`
  );
}

/** An action button (delegated via `data-action` + `data-mid`). Label is a
 *  short i18n string passed in by the caller — kept out of this pure module so
 *  render.ts stays trivially testable without the i18n dict. */
function actionBtn(mid: string, action: string, label: string): string {
  return (
    `<button type="button" class="wd-comm-act" data-action="${esc(action)}"` +
    ` data-mid="${esc(mid)}">${esc(label)}</button>`
  );
}

/** Labels the thread passes in (defaults are English so render.ts is testable
 *  standalone). */
export interface ActionLabels {
  react?: string;
  edit?: string;
  delete?: string;
  report?: string;
  pin?: string;
  deleted?: string;
  edited?: string;
}

const DEFAULT_LABELS: Required<ActionLabels> = {
  react: "React",
  edit: "Edit",
  delete: "Delete",
  report: "Report",
  pin: "Pin",
  deleted: "[deleted]",
  edited: "(edited)",
};

/**
 * Render a single message to a trusted HTML string. `ctx` gates the action set;
 * `labels` supplies i18n text (defaults to English for standalone testing).
 */
export function renderMessage(m: Message, ctx: RenderCtx = {}, labels: ActionLabels = {}): string {
  const L = { ...DEFAULT_LABELS, ...labels };
  const isMine = !!ctx.meId && m.authorId === ctx.meId;

  // Avatar (only when we have an author id). The v6.4.0 avatar endpoint never
  // 404s (falls back to a seeded identicon), so no onerror chain is needed.
  const avatar = m.authorId
    ? `<img class="wd-comm-msg-av" src="${esc(avatarUrl(m.authorId))}" alt="" loading="lazy" decoding="async">`
    : "";

  const name = esc(m.authorUsername ?? "…");
  const time = fmtTime(m.createdAt);
  const edited = m.editedAt ? ` <span class="wd-comm-msg-edited">${esc(L.edited)}</span>` : "";

  // Body: deleted messages get a muted placeholder (never the raw content).
  // Live messages: markdown → mentions → emotes, all on already-escaped HTML
  // (mdToHtml starts with esc). The emote pass is injected (identity default)
  // so :emote: shortcodes inside text render as <img class="wd-emote">.
  const emotes = ctx.emotes ?? ((h: string) => h);
  const body = m.isDeleted
    ? `<div class="wd-comm-msg-body is-deleted">${esc(L.deleted)}</div>`
    : `<div class="wd-comm-msg-body">${emotes(renderMentions(mdToHtml(m.content)))}</div>`;

  // Reactions row.
  const reactions =
    !m.isDeleted && m.reactions.length
      ? `<div class="wd-comm-reacts">${m.reactions
          .map((r) => reactionChip(m.id, r.emoji, r.count, r.reactedByMe))
          .join("")}</div>`
      : "";

  // Actions — minimal + clearly gated. Own (non-deleted) messages: edit/delete.
  // Others' messages: report; moderators additionally get delete (the backend
  // allows mod deletion in clan/global/modmail chats — DMs never set
  // canModerate) and pin.
  const acts: string[] = [];
  if (!m.isDeleted) {
    // "React" is available to anyone who can post (open the emoji picker to add
    // a NEW reaction) — kept leftmost so it reads as the primary affordance.
    acts.push(actionBtn(m.id, "react", L.react));
    if (isMine) {
      acts.push(actionBtn(m.id, "edit", L.edit));
      acts.push(actionBtn(m.id, "delete", L.delete));
    } else {
      acts.push(actionBtn(m.id, "report", L.report));
      if (ctx.canModerate) acts.push(actionBtn(m.id, "delete", L.delete));
    }
    if (ctx.canModerate) acts.push(actionBtn(m.id, "pin", L.pin));
  }
  const actions = acts.length ? `<div class="wd-comm-acts">${acts.join("")}</div>` : "";

  return (
    `<div class="wd-comm-msg" data-mid="${esc(m.id)}" data-ver="${esc(String(m.version))}">` +
    `<div class="wd-comm-msg-head">${avatar}` +
    `<span class="wd-comm-msg-name">${name}</span>` +
    `<span class="wd-comm-msg-time">${esc(time)}${edited}</span></div>` +
    body +
    reactions +
    actions +
    `</div>`
  );
}
