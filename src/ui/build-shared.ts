import { PALETTE, activeColor } from "../palette";
import { t } from "../i18n";

// <option> list for the publish/protect scope selects. Protection adds a
// device-local scope on top of the shared private/clan/public set.
export function scopeOptions(opts: { local?: boolean } = {}): string {
  const rows: Array<[string, string]> = [];
  if (opts.local) rows.push(["local", "scopeLocal"]);
  rows.push(
    ["private", "scopePrivate"],
    ["clan", "scopeClan"],
    ["public", "scopePublic"],
  );
  return rows
    .map(([value, key]) => `<option value="${value}">${t(key)}</option>`)
    .join("");
}

export function paletteSwatches(): string {
  return `<div class="wp-sw">${PALETTE.map(
    (h) =>
      `<button data-hex="${h}" style="background:${h}" title="${h}" class="${h === activeColor ? "sel" : ""}"></button>`,
  ).join("")}</div>`;
}
