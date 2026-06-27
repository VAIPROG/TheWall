import { cfg, saveCfg } from "../config";
import { $, esc } from "../helpers";
import { ic } from "../icons";
import { t } from "../i18n";
import { confirmDlg } from "../dialog";
import { log } from "../log";
import {
  loadTemplates,
  loadPublicTemplates,
  shareCurrentTemplate,
} from "../data";

export function wireTemplates(win: HTMLElement): void {
  // templates tab
  $("cfg-unverified")!.addEventListener("change", async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.checked && !(await confirmDlg(t("unverifiedWarn")))) {
      target.checked = false;
      return;
    }
    cfg.showUnverified = target.checked;
    saveCfg();
    loadPublicTemplates();
  });
  $("cfg-unverified-clan")?.addEventListener("change", async (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (target.checked && !(await confirmDlg(t("unverifiedWarn")))) {
      target.checked = false;
      return;
    }
    cfg.showUnverifiedClan = target.checked;
    saveCfg();
    loadTemplates();
  });
  $("btn-tpl-share")!.addEventListener("click", shareCurrentTemplate);

  // Manual reload buttons — bypass the 5-min cache, force a network round-trip.
  $("btn-reload-pub-tpl")?.addEventListener("click", () => {
    loadPublicTemplates(true).catch(() => {});
  });
  $("btn-reload-clan-tpl")?.addEventListener("click", () => {
    loadTemplates(true).catch(() => {});
  });

  /**
   * Live template-catalog search with a small structured DSL.
   *
   * Tokens (separated by whitespace, AND-combined — every token must match):
   *
   *   x:5569          coordinate exactly equals 5569
   *   x:100-500       coordinate in the inclusive range [100, 500]
   *   y:440           same, for y
   *   y:0-1000        same, for y range
   *   author:vai      substring match against the row's author field
   *   anything else   substring match against the row's name field
   *
   * Examples:
   *   `swarm`                     → name contains "swarm"
   *   `x:5569`                    → templates anchored at x=5569
   *   `x:5000-6000 y:0-500 vai`   → name~vai AND x∈[5000..6000] AND y∈[0..500]
   *   `author:vai swarm activity` → author~vai AND (name~swarm OR name~activity)*
   *
   *   *Plain-text terms are joined with AND too — every word must appear
   *    somewhere in the name. Use `name:multi word` if you need a literal
   *    multi-word match (not implemented yet, single-word terms cover the
   *    common case).
   *
   * The show-unverified checkboxes apply independently — the server
   * decides whether unverified rows even reach the DOM. The search just
   * filters whatever rows are currently visible.
   */
  type SearchToken =
    | { kind: "name"; q: string }
    | { kind: "author"; q: string }
    | { kind: "x" | "y"; min: number; max: number };

  const parseRange = (val: string): { min: number; max: number } | null => {
    const m = /^(-?\d+)(?:-(-?\d+))?$/.exec(val);
    if (!m) return null;
    const a = Number(m[1]);
    if (m[2] === undefined) return { min: a, max: a };
    const b = Number(m[2]);
    return { min: Math.min(a, b), max: Math.max(a, b) };
  };

  const parseSearchQuery = (raw: string): SearchToken[] => {
    const out: SearchToken[] = [];
    // Split on whitespace; the DSL doesn't (yet) support quoted multi-word
    // values, so simple whitespace tokenisation is fine.
    for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
      const lower = tok.toLowerCase();
      if (lower.startsWith("x:") || lower.startsWith("y:")) {
        const axis = lower[0] as "x" | "y";
        const r = parseRange(lower.slice(2));
        if (r) {
          out.push({ kind: axis, min: r.min, max: r.max });
          continue;
        }
        // Malformed coord token — fall through and treat as a name match
        // so the user at least sees *something* (rather than empty list).
      }
      if (lower.startsWith("author:")) {
        const q = lower.slice("author:".length);
        if (q) out.push({ kind: "author", q });
        continue;
      }
      out.push({ kind: "name", q: lower });
    }
    return out;
  };

  /** Check one row against the parsed tokens (AND). */
  const rowMatchesTokens = (
    row: HTMLElement,
    tokens: SearchToken[],
  ): boolean => {
    if (tokens.length === 0) return true;
    const name = (row.dataset.tplName || "").toLowerCase();
    const author = (row.dataset.tplAuthor || "").toLowerCase();
    const x = Number(row.dataset.tplX || 0);
    const y = Number(row.dataset.tplY || 0);
    for (const tok of tokens) {
      switch (tok.kind) {
        case "name":
          if (!name.includes(tok.q)) return false;
          break;
        case "author":
          if (!author.includes(tok.q)) return false;
          break;
        case "x":
          if (x < tok.min || x > tok.max) return false;
          break;
        case "y":
          if (y < tok.min || y > tok.max) return false;
          break;
      }
    }
    return true;
  };

  const applyTplSearch = (): void => {
    const inp = $("tpl-search") as HTMLInputElement | null;
    const raw = inp?.value || "";
    const tokens = parseSearchQuery(raw);
    let shown = 0;
    let hidden = 0;
    for (const listId of ["pub-templates", "clan-templates"]) {
      const box = $(listId);
      if (!box) continue;
      box.querySelectorAll<HTMLElement>(".wp-li").forEach((row) => {
        if (rowMatchesTokens(row, tokens)) {
          row.style.display = "";
          shown += 1;
        } else {
          row.style.display = "none";
          hidden += 1;
        }
      });
    }
    log(
      "TPL_SEARCH",
      "INFO",
      `q="${raw}" tokens=${tokens.length} shown=${shown} hidden=${hidden}`,
    );
  };
  $("tpl-search")?.addEventListener("input", applyTplSearch);
  // Re-apply after re-renders too (reload buttons + initial loads). The
  // refresh handlers call loadTemplates/loadPublicTemplates which replace
  // the list HTML, so any stale display:none gets reset along with it.
  // Defer with a microtask so we run after the list innerHTML is in place.
  const tplObserver = new MutationObserver(() => {
    queueMicrotask(applyTplSearch);
  });
  const pubList = $("pub-templates");
  const clanList = $("clan-templates");
  if (pubList) tplObserver.observe(pubList, { childList: true });
  if (clanList) tplObserver.observe(clanList, { childList: true });
}

export function buildTemplatesPane(): string {
  return `<div class="wp-pane" data-p="tp">
                  <div class="wp-group"><div class="wp-legend">${ic("scan")}${t("tplSearchLegend")}</div>
                      <input type="text" id="tpl-search" class="wp-input" autocomplete="off" placeholder="${esc(t("tplSearchPlaceholder"))}">
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:2px">${t("tplSearchHint")}</div>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("check")}${t("publicTpl")}</div>
                      <div class="wp-list" id="pub-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-unverified" ${cfg.showUnverified ? "checked" : ""}> ${t("unverified")}</label>
                          <button class="wp-btn" id="btn-reload-pub-tpl" style="padding:2px 8px;margin:0" title="Reload public templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <label class="wp-check" style="margin-top:2px"><input type="checkbox" id="cfg-hide-anim-pub" ${cfg.hideAnimatedPub ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("shield")}${t("clanTpl")}</div>
                      <div class="wp-list" id="clan-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-unverified-clan" ${cfg.showUnverifiedClan ? "checked" : ""}> ${t("unverified")}</label>
                          <button class="wp-btn" id="btn-reload-clan-tpl" style="padding:2px 8px;margin:0" title="Reload clan templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <label class="wp-check" style="margin-top:2px"><input type="checkbox" id="cfg-hide-anim-clan" ${cfg.hideAnimatedClan ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                  </div>
                  <div class="wp-group"><div class="wp-legend">${ic("user")}${t("myTpl")}</div>
                      <div class="wp-list" id="my-templates"><div style="padding:6px;color:var(--sub)">${t("backend")}: ${t("offline")}</div></div>
                      <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                          <label class="wp-check" style="flex:1;margin:0"><input type="checkbox" id="cfg-hide-anim-mine" ${cfg.hideAnimatedMine ? "checked" : ""}> ${t("hideAnimatedTpl")}</label>
                          <button class="wp-btn" id="btn-reload-my-tpl" style="padding:2px 8px;margin:0" title="Reload my templates">${ic("scan", 10)}Reload</button>
                      </div>
                      <div class="wp-note" style="color:var(--sub);font-size:10px;margin-top:4px">${t("myTplHint")}</div>
                  </div>
              </div>`;
}
