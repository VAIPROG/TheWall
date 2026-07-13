/**
 * Foundation kit primitives. Render helpers that return HTML strings (matching
 * the codebase's string-HTML style) using the `wd-*` classes from kit/styles.ts
 * and the active theme tokens. These are the building blocks every rebuilt tab
 * is composed from.
 */
import { esc } from "../../helpers";
import { icon as kitIcon } from "./icons";

export type StatusKind = "ok" | "warn" | "err" | "info" | "muted";
export type BtnVariant = "primary" | "default" | "danger" | "ghost";
export type BtnSize = "sm" | "md" | "lg";

export interface ButtonOpts {
  variant?: BtnVariant;
  size?: BtnSize;
  /** Icon name (see icons.ts) or a raw emoji/char. */
  icon?: string;
  id?: string;
  full?: boolean;
  disabled?: boolean;
  working?: boolean;
  title?: string;
  /** Extra `key="value"` attributes (e.g. data-*). Values are trusted. */
  attrs?: Record<string, string>;
}

function attrStr(attrs?: Record<string, string>): string {
  if (!attrs) return "";
  return Object.entries(attrs)
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join("");
}

/** Render an icon: kit SVG when the name is known, else emoji fallback. */
function iconHtml(icon?: string): string {
  if (!icon) return "";
  return kitIcon(icon, 14);
}

export function button(label: string, o: ButtonOpts = {}): string {
  const cls = [
    "wd-btn",
    o.variant && o.variant !== "default" ? `wd-btn--${o.variant}` : "",
    o.size && o.size !== "md" ? `wd-btn--${o.size}` : "",
    o.full ? "wd-btn--full" : "",
    o.working ? "is-working" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const icon = o.working
    ? `<span class="wd-spin">⟳</span>`
    : iconHtml(o.icon);
  return (
    `<button class="${cls}"` +
    (o.id ? ` id="${esc(o.id)}"` : "") +
    (o.title ? ` title="${esc(o.title)}"` : "") +
    (o.disabled ? " disabled" : "") +
    attrStr(o.attrs) +
    `>${icon}${esc(label)}</button>`
  );
}

/** Icon-only square button. */
export function iconButton(icon: string, o: Omit<ButtonOpts, "icon" | "full"> = {}): string {
  const cls = [
    "wd-btn",
    "wd-btn--icon",
    o.variant && o.variant !== "default" ? `wd-btn--${o.variant}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `<button class="${cls}"` +
    (o.id ? ` id="${esc(o.id)}"` : "") +
    (o.title ? ` title="${esc(o.title)}"` : "") +
    (o.disabled ? " disabled" : "") +
    attrStr(o.attrs) +
    `>${iconHtml(icon)}</button>`
  );
}

/** A segmented toggle. `options` = [{value,label}], `active` = selected value. */
export function segmented(
  options: Array<{ value: string; label: string }>,
  active: string,
  attrName = "data-seg",
): string {
  const buttons = options
    .map(
      (o) =>
        `<button class="${o.value === active ? "is-on" : ""}" ${attrName}="${esc(o.value)}">${esc(o.label)}</button>`,
    )
    .join("");
  return `<span class="wd-seg">${buttons}</span>`;
}

export function statusText(kind: StatusKind, msg: string, icon?: string): string {
  return `<span class="wd-status wd-status--${kind}">${iconHtml(icon)}${esc(msg)}</span>`;
}

export function statusPill(kind: Exclude<StatusKind, "muted">, msg: string, icon?: string): string {
  return `<span class="wd-pill wd-pill--${kind}">${iconHtml(icon)}${esc(msg)}</span>`;
}

/** Monospace LED-green readout of coordinates / live values. */
export function readout(parts: Array<string | number>, opts: { boxed?: boolean } = {}): string {
  const inner = parts
    .map((p) => `<span>${esc(String(p))}</span>`)
    .join(`<span class="sep">·</span>`);
  return `<span class="wd-readout${opts.boxed ? " wd-readout--boxed" : ""}">${inner}</span>`;
}

export function emptyState(msg: string, icon?: string): string {
  return `<div class="wd-empty">${icon ? `<span class="wd-empty-ico">${esc(icon)}</span>` : ""}${esc(msg)}</div>`;
}

export function loading(msg = "Loading…"): string {
  return `<div class="wd-loading"><span class="wd-spin">⟳</span> ${esc(msg)}</div>`;
}

export function errorState(msg: string): string {
  return `<div class="wd-errstate">${esc(msg)}</div>`;
}

export type BadgeKind = "owner" | "admin" | "mod" | "member";

/** Role/status badge. `kind` picks the colour; text defaults to the kind. */
export function badge(text: string, kind?: BadgeKind): string {
  return `<span class="wd-badge${kind ? ` wd-badge--${kind}` : ""}">${esc(text)}</span>`;
}

/** A titled group box. `body` is trusted HTML. */
export function group(legend: string, body: string, opts: { icon?: string; danger?: boolean } = {}): string {
  const cls = opts.danger ? "wd-danger-zone" : "wd-group";
  return `<div class="${cls}"><div class="wd-legend">${iconHtml(opts.icon)}${esc(legend)}</div>${body}</div>`;
}

/** A card container. `body` is trusted HTML. */
export function card(body: string, extraClass = ""): string {
  return `<div class="wd-card ${extraClass}">${body}</div>`;
}
