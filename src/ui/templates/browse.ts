/**
 * Browse screen (root of the Templates super-tab): chips (All/Public/Clan/Mine),
 * a client-side search, a density toggle, and a card grid. Tapping a card drills
 * into Detail. Data from the V3 list endpoint.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { segmented, emptyState, loading, errorState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { listTemplates, type Chip, type TplSummary } from "./api";
import { templateCard } from "./card";
import { openDetail } from "./shell";

// Persisted across pushes/pops within a session.
let curChip: Chip = "all";
let curDensity: "grid" | "compact" = "grid";
let rows: TplSummary[] = [];
let search = "";
// Scope toggles (mirror the old tab): show pending/unverified templates, and
// hide animated ones. `showUnverified` changes the server query (refetch);
// `hideAnimated` is a client-side filter (re-render only).
let showUnverified = false;
let hideAnimated = false;

function filtered(): TplSummary[] {
  const q = search.trim().toLowerCase();
  const toks = q ? q.split(/\s+/).filter(Boolean) : [];
  return rows.filter((r) => {
    if (hideAnimated && r.animated) return false;
    if (!toks.length) return true;
    const hay = `${r.name} ${r.id}`.toLowerCase();
    return toks.every((tk) => hay.includes(tk));
  });
}

function renderGrid(): string {
  const list = filtered();
  if (!list.length) return emptyState(t("tplNone") || "No templates here yet.", "📭");
  const cls = curDensity === "compact" ? "wd-tplgrid wd-tplgrid--compact" : "wd-tplgrid";
  return `<div class="${cls}">${list.map((r) => templateCard(r, curChip)).join("")}</div>`;
}

export function browseScreen(): PanelScreen {
  return {
    title: "",
    render: () => `
      <div class="wp-group" style="margin:0 0 6px">
        <div id="tpl-chips">${segmented(
          [
            { value: "all", label: t("tplAll") || "All" },
            { value: "public", label: t("tplPublic") || "Public" },
            { value: "clan", label: t("tplClan") || "Clan" },
            { value: "mine", label: t("tplMine") || "Mine" },
          ],
          curChip,
        )}</div>
        <input id="tpl-search" class="wp-input" placeholder="${esc(t("tplSearch") || "Search name / id…")}" value="${esc(search)}" style="margin-top:6px;width:100%">
        <div style="display:flex;gap:6px;align-items:center;margin-top:6px">
          <button class="wp-btn" id="tpl-reload" style="margin:0" title="${esc(t("refresh") || "Refresh")}">↻</button>
          <span style="flex:1"></span>
          <span id="tpl-density">${segmented(
            [
              { value: "grid", label: "▦" },
              { value: "compact", label: "≣" },
            ],
            curDensity,
          )}</span>
        </div>
        <div style="display:flex;gap:12px;align-items:center;margin-top:6px;font-size:10px;color:var(--sub)">
          <label style="display:flex;gap:3px;align-items:center;cursor:pointer">
            <input type="checkbox" id="tpl-unverified"${showUnverified ? " checked" : ""}>${esc(t("tplShowUnverified") || "Show unverified")}
          </label>
          <label style="display:flex;gap:3px;align-items:center;cursor:pointer">
            <input type="checkbox" id="tpl-hideanim"${hideAnimated ? " checked" : ""}>${esc(t("tplHideAnimated") || "Hide animated")}
          </label>
        </div>
      </div>
      <div id="tpl-grid">${loading()}</div>`,
    onMount: () => {
      const load = async () => {
        const grid = $("tpl-grid");
        if (!grid) return;
        grid.innerHTML = loading();
        try {
          rows = await listTemplates(curChip, showUnverified);
        } catch {
          grid.innerHTML = errorState(t("tplLoadErr") || "Failed to load templates.");
          return;
        }
        grid.innerHTML = renderGrid();
      };
      const rerender = () => {
        const g = $("tpl-grid");
        if (g) g.innerHTML = renderGrid();
      };
      // Chips → refetch.
      $("tpl-chips")
        ?.querySelectorAll<HTMLElement>("[data-seg]")
        .forEach((b) =>
          b.addEventListener("click", () => {
            curChip = (b.dataset.seg as Chip) || "all";
            $("tpl-chips")
              ?.querySelectorAll<HTMLElement>("[data-seg]")
              .forEach((x) => x.classList.toggle("is-on", x === b));
            load();
          }),
        );
      // Density → re-render only.
      $("tpl-density")
        ?.querySelectorAll<HTMLElement>("[data-seg]")
        .forEach((b) =>
          b.addEventListener("click", () => {
            curDensity = (b.dataset.seg as "grid" | "compact") || "grid";
            $("tpl-density")
              ?.querySelectorAll<HTMLElement>("[data-seg]")
              .forEach((x) => x.classList.toggle("is-on", x === b));
            rerender();
          }),
        );
      $("tpl-search")?.addEventListener("input", (e) => {
        search = (e.target as HTMLInputElement).value;
        rerender();
      });
      // Show unverified → changes the server query, so refetch.
      $("tpl-unverified")?.addEventListener("change", (e) => {
        showUnverified = (e.target as HTMLInputElement).checked;
        load();
      });
      // Hide animated → client-side filter, re-render only.
      $("tpl-hideanim")?.addEventListener("change", (e) => {
        hideAnimated = (e.target as HTMLInputElement).checked;
        rerender();
      });
      $("tpl-reload")?.addEventListener("click", load);
      // Card open — delegate on the grid (recreated fresh each mount, so no
      // listener accumulation on the persistent stack container).
      $("tpl-grid")?.addEventListener("click", (e) => {
        const b = (e.target as HTMLElement).closest<HTMLElement>("[data-open]");
        if (b?.dataset.open) openDetail(b.dataset.open);
      });
      void load();
    },
  };
}
