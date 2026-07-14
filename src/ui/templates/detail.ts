/**
 * Detail drill-in for the Templates super-tab. Fetches the full V3 template
 * (document, author, notes, bundle) and renders a rich read view: large
 * preview, name + type/scope/status pills, an info grid, author (honouring the
 * opt-in author field), free-form notes, bundle contents, and actions
 * (Load / Pin / Report / Delete). Load decodes the stored the-wall-dev/2
 * document through the formats layer and applies it to the overlay.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { badge, button, group } from "../kit/primitives";
import { loading, errorState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { toast } from "../../notify";
import { confirmDlg, promptDlg } from "../../dialog";
import { getActiveClient } from "../../backend/index";
import { decodeAny, primaryLayer } from "../../formats";
import { applyLayer } from "../../formats/apply-layer";
import { previewUrl, animatedUrl, exportUrl, shareLink, getUsername } from "./api";
import { computePercentPainted, formatPct } from "./percent";
import { openPublish, resetToBrowse } from "./shell";
import type { AuthorVisibility, Scope } from "./api";
import { isAllowedOnDomain, domainsOf } from "../../domain-guard";

interface DocTemplate {
  name?: string;
  x?: number;
  y?: number;
  scale?: number;
  width?: number;
  height?: number;
  layers?: Array<{ animation?: unknown }>;
  animation?: unknown;
}
interface WallDoc {
  format?: string;
  author?: { id?: string; username?: string; name?: string } | null;
  notes?: string[] | null;
  createdAt?: string;
  editedAt?: string;
  templates?: DocTemplate[];
  contacts?: unknown[];
}
type AuthorField = { id?: string; username?: string; name?: string } | string | null;

export interface FullTpl {
  id: string;
  /** null when redacted for anonymity (see api.ts TplSummary.userId). */
  userId: string | null;
  name: string;
  x: number;
  y: number;
  scale: number;
  scope: string;
  status: string;
  version: number;
  clanId?: string | null;
  author?: AuthorField;
  verifiedAt?: string | null;
  rejectionReason?: string | null;
  createdAt?: string;
  document?: WallDoc | null;
}

function docAnimated(doc?: WallDoc | null): boolean {
  return !!doc?.templates?.some((tp) => tp.animation || tp.layers?.some((l) => l.animation));
}

/**
 * Display author from `document.author` (privacy-aware): the nickname when
 * present; otherwise the id to resolve to a username asynchronously; otherwise
 * Anonymous. Never shows a bare uuid — it resolves or falls back to Anonymous.
 */
function authorInfo(tpl: FullTpl): { name: string; resolveId?: string } {
  const anon = t("tplAnonymous") || "Anonymous";
  const da = (tpl.document as { author?: unknown } | null | undefined)?.author;
  if (da === "anon" || da === null) return { name: anon };
  if (da && typeof da === "object") {
    const o = da as { name?: string; id?: string };
    if (o.name) return { name: o.name };
    if (o.id) return { name: "…", resolveId: o.id };
    return { name: anon };
  }
  // Fall back to the row column for older rows without a structured author.
  const a = tpl.author;
  if (!a || a === "anon" || a === "anonymous") return { name: anon };
  if (typeof a === "string") return { name: a };
  if (a.username || a.name) return { name: (a.username || a.name) as string };
  if (a.id) return { name: "…", resolveId: a.id };
  return { name: anon };
}

function fmtDate(s?: string): string {
  if (!s) return "—";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

/** One label→value row in the info grid. */
function infoRow(label: string, value: string): string {
  return `<div class="wd-kv"><span class="wd-kv-k">${esc(label)}</span><span class="wd-kv-v">${esc(value)}</span></div>`;
}

function statusPill(tpl: FullTpl): string {
  if (tpl.status === "approved") return badge(`✓ ${t("tplVerified") || "Verified"}`, "mod");
  if (tpl.status === "pending") return badge(`⏳ ${t("tplPending") || "Pending"}`, "member");
  if (tpl.status === "rejected") return badge(`✕ ${t("tplRejected") || "Rejected"}`, "admin");
  return "";
}

function render(tpl: FullTpl): string {
  const doc = tpl.document ?? null;
  const first = doc?.templates?.[0];
  const name = tpl.name || first?.name || t("tplUntitled") || "Untitled";
  const animated = docAnimated(doc);
  const count = doc?.templates?.length ?? 1;
  const w = first?.width;
  const h = first?.height;
  const me = getActiveClient()?.me;
  const isOwner = !!me && me.id === tpl.userId;

  const scopeLabel = { public: "PUBLIC", clan: "CLAN", private: "PRIVATE" }[tpl.scope] ?? tpl.scope.toUpperCase();
  const pills =
    badge(animated ? "🎞 ANIMATED" : "🖼 STATIC", animated ? "admin" : "member") +
    badge(scopeLabel, tpl.scope === "public" ? "mod" : tpl.scope === "clan" ? "owner" : "member") +
    statusPill(tpl);

  const previewSrc = animated ? animatedUrl(tpl.id) : previewUrl(tpl.id, 256);

  // Painted-% row carries an id so onMount can fill it after the async tile diff.
  const paintedRow = `<div class="wd-kv"><span class="wd-kv-k">${esc(t("tplPainted") || "Painted")}</span><span class="wd-kv-v" id="tpl-pct">…</span></div>`;
  // Author row: nickname if present, else an id-carrying span resolved on mount.
  const ai = authorInfo(tpl);
  const authorRow = `<div class="wd-kv"><span class="wd-kv-k">${esc(t("tplAuthor") || "Author")}</span><span class="wd-kv-v" id="tpl-author-val"${ai.resolveId ? ` data-uid="${esc(ai.resolveId)}"` : ""}>${esc(ai.name)}</span></div>`;
  const info = [
    infoRow(t("tplDims") || "Dimensions", w && h ? `${w} × ${h}` : "—"),
    infoRow(t("tplPos") || "Position", `${tpl.x}, ${tpl.y}`),
    infoRow(t("tplScale") || "Scale", `${tpl.scale}×`),
    infoRow(t("tplBundleCount") || "Templates", String(count)),
    infoRow(t("tplVersion") || "Version", `v${tpl.version}`),
    authorRow,
    infoRow(t("tplCreated") || "Created", fmtDate(tpl.createdAt ?? doc?.createdAt)),
  ].join("");

  // Notes (free-form) from the document.
  const notes = (doc?.notes ?? []).filter((n) => typeof n === "string" && n.trim());
  const notesBody = notes.length
    ? `<ul class="wd-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`
    : `<div class="wd-empty" style="border:0;padding:4px">${esc(t("tplNoNotes") || "No notes.")}</div>`;

  // Bundle contents (only meaningful for multi-template bundles).
  const bundleBody =
    count > 1
      ? group(
          t("tplBundle") || "Bundle contents",
          `<ol class="wd-bundle">${(doc?.templates ?? [])
            .map((tp) => `<li>${esc(tp.name || t("tplUntitled") || "Untitled")}</li>`)
            .join("")}</ol>`,
        )
      : "";

  const rejected =
    tpl.status === "rejected" && tpl.rejectionReason
      ? group(t("tplRejected") || "Rejected", `<div class="wd-status wd-status--err">${esc(tpl.rejectionReason)}</div>`, {
          danger: true,
        })
      : "";

  // Site restriction (domainsWhitelist) — a courtesy note when this template is
  // not shared for the current site.
  const domains = domainsOf(doc);
  const domainNote =
    domains?.length && !isAllowedOnDomain(domains)
      ? group(
          t("tplRestricted") || "Site-restricted",
          `<div class="wd-status wd-status--warn">${esc((t("tplNotForSite") || "This template isn't shared for this site.") + " " + domains.join(", "))}</div>`,
        )
      : "";

  const labelRow = (label: string, buttons: string) =>
    `<div style="display:flex;gap:6px;align-items:center;margin-top:6px"><span style="font-size:10px;color:var(--sub);min-width:66px">${esc(label)}</span>${buttons}</div>`;

  const actions =
    button(t("tplLoad") || "Load onto wall", { variant: "primary", full: true, id: "tpl-d-load", icon: "download" }) +
    labelRow(
      t("tplShareLink") || "Share link",
      button("WallDev", { id: "tpl-d-share-wd", size: "sm", icon: "link" }) +
        button("Charity", { id: "tpl-d-share-ch", size: "sm", icon: "link" }),
    ) +
    labelRow(
      t("tplExportJson") || "Export JSON",
      button("WallDev", { id: "tpl-d-export", size: "sm", title: "the-wall-dev/2 JSON" }) +
        button("Charity", { id: "tpl-d-charity", size: "sm", title: "Charity config JSON" }),
    ) +
    `<div style="display:flex;gap:6px;margin-top:6px">` +
    button(t("tplPin") || "Pin", { id: "tpl-d-pin", size: "sm" }) +
    button(t("tplCopyId") || "Copy ID", { id: "tpl-d-copyid", size: "sm" }) +
    button(t("tplReport") || "Report", { id: "tpl-d-report", size: "sm" }) +
    `</div>` +
    (isOwner
      ? `<div style="display:flex;gap:6px;margin-top:6px">` +
        button(t("tplEdit") || "Edit", { id: "tpl-d-edit", size: "sm", icon: "edit" }) +
        button(t("tplDelete") || "Delete", { id: "tpl-d-delete", size: "sm", variant: "danger" }) +
        `</div>`
      : "");

  return `
    <div class="wd-tpl-detail">
      <div class="wd-tpl-hero">
        <img class="wd-tpl-hero-img" src="${esc(previewSrc)}" onerror="this.style.opacity=.2">
      </div>
      <h3 class="wd-tpl-title">${esc(name)}</h3>
      <div class="wd-tpl-pills">${pills}</div>
      ${group(t("tplInfo") || "Info", `<div class="wd-kvgrid">${paintedRow}${info}</div>`)}
      ${group(t("tplNotes") || "Notes", notesBody)}
      ${bundleBody}
      ${rejected}
      ${domainNote}
      <div style="margin-top:8px">${actions}</div>
      <div class="wd-tpl-id" title="${esc(tpl.id)}">${esc(tpl.id)}</div>
    </div>`;
}

async function loadOntoWall(id: string, btn: HTMLElement): Promise<void> {
  const c = getActiveClient();
  if (!c) return;
  btn.classList.add("is-working");
  try {
    const doc = await c.get<unknown>(`/templates/${encodeURIComponent(id)}/wall-dev`);
    if (!isAllowedOnDomain(domainsOf(doc))) {
      toast(t("tplLoad") || "Load", t("tplNotForSite") || "This template isn't shared for this site.");
      return;
    }
    const { set } = decodeAny(doc as object);
    const layer = primaryLayer(set);
    if (!layer) throw new Error("no layer");
    await applyLayer(layer);
    toast(t("tplLoad") || "Load", t("tplLoadOk") || "Template applied to the wall.");
  } catch {
    toast(t("tplLoad") || "Load", t("tplLoadFail") || "Failed to load this template.");
  } finally {
    btn.classList.remove("is-working");
  }
}

export function detailScreen(id: string): PanelScreen {
  return {
    title: t("tplDetailTitle") || "Template",
    render: () => `<div id="tpl-detail">${loading()}</div>`,
    onMount: async () => {
      const root = $("tpl-detail");
      if (!root) return;
      const c = getActiveClient();
      if (!c) {
        root.innerHTML = errorState(t("tplLoadErr") || "Not connected.");
        return;
      }
      let tpl: FullTpl;
      try {
        tpl = await c.get<FullTpl>(`/templates/${encodeURIComponent(id)}`);
      } catch {
        root.innerHTML = errorState(t("tplLoadErr") || "Failed to load template.");
        return;
      }
      root.innerHTML = render(tpl);

      // % painted — async wall-tile diff; fill the slot when it resolves.
      const setPct = (txt: string) => {
        const el = $("tpl-pct");
        if (el) el.textContent = txt;
      };
      if (tpl.document) {
        computePercentPainted(tpl.document)
          .then((r) => setPct(r ? formatPct(r.total, r.match) : "—"))
          .catch(() => setPct("—"));
      } else {
        setPct("—");
      }

      // Resolve the author id → username when only an id is available.
      const av = $("tpl-author-val");
      const uid = av?.getAttribute("data-uid");
      if (av && uid) {
        void getUsername(uid).then((name) => {
          av.textContent = name || (t("tplAnonymous") || "Anonymous");
        });
      }

      $("tpl-d-load")?.addEventListener("click", (e) =>
        loadOntoWall(id, e.currentTarget as HTMLElement),
      );
      $("tpl-d-pin")?.addEventListener("click", async () => {
        try {
          await c.post(`/templates/${encodeURIComponent(id)}/pin`, {});
          toast(t("tplPin") || "Pin", t("tplPinOk") || "Pinned.");
        } catch {
          toast(t("tplPin") || "Pin", t("tplPinFail") || "Could not pin.");
        }
      });
      $("tpl-d-copyid")?.addEventListener("click", () => {
        void navigator.clipboard?.writeText(id);
        toast(t("tplCopyId") || "Copy ID", t("tplCopied") || "Copied to clipboard.");
      });
      const copyShare = (format: "wall-dev" | "charity") => {
        const link = shareLink(id, { format });
        if (!link) return;
        void navigator.clipboard?.writeText(link);
        const note = tpl.scope === "public" ? "" : " " + (t("tplShareNote") || "(private — recipient must have access)");
        toast(t("tplShareLink") || "Share link", (t("tplShareCopied") || "Share link copied.") + note);
      };
      $("tpl-d-share-wd")?.addEventListener("click", () => copyShare("wall-dev"));
      $("tpl-d-share-ch")?.addEventListener("click", () => copyShare("charity"));
      $("tpl-d-export")?.addEventListener("click", () => {
        const url = exportUrl(id, "wall-dev");
        if (url) window.open(url, "_blank", "noopener");
      });
      $("tpl-d-charity")?.addEventListener("click", () => {
        const url = exportUrl(id, "charity");
        if (url) window.open(url, "_blank", "noopener");
      });
      $("tpl-d-edit")?.addEventListener("click", () => {
        const d = (tpl.document ?? {}) as Record<string, unknown>;
        const a = d.author;
        const authorVisibility: AuthorVisibility =
          a === "anon" || a === "anonymous" ? "anon" : a === null || a === undefined ? "hidden" : "full";
        const ate = (d.allowedToEdit ?? {}) as { userIds?: string[]; clanIds?: string[] };
        openPublish({
          editId: tpl.id,
          document: d,
          name: tpl.name,
          scope: tpl.scope as Scope,
          authorVisibility,
          notes: (d.notes as string[] | undefined) ?? [],
          access: {
            usersWhitelist: d.usersWhitelist as string[] | undefined,
            usersBlocklist: d.usersBlocklist as string[] | undefined,
            coEditorUsers: ate.userIds,
            coEditorClans: ate.clanIds,
            domains: d.domainsWhitelist as string[] | undefined,
          },
        });
      });
      $("tpl-d-report")?.addEventListener("click", async () => {
        const reason = await promptDlg(
          t("tplReportPrompt") || "Why are you reporting this template? (10–2000 chars)",
          "",
          t("tplReport") || "Report",
        );
        if (!reason || reason.trim().length < 10) return;
        try {
          await c.post(`/templates/${encodeURIComponent(id)}/report`, { reason: reason.trim() });
          toast(t("tplReport") || "Report", t("tplReportOk") || "Report submitted. Thank you.");
        } catch {
          toast(t("tplReport") || "Report", t("tplReportFail") || "Could not submit report.");
        }
      });
      $("tpl-d-delete")?.addEventListener("click", async () => {
        const ok = await confirmDlg(
          t("tplDeleteConfirm") || "Delete this template permanently?",
          t("tplDelete") || "Delete",
        );
        if (!ok) return;
        try {
          await c.delete(`/templates/${encodeURIComponent(id)}`);
          toast(t("tplDelete") || "Delete", t("tplDeleteOk") || "Template deleted.");
          resetToBrowse();
        } catch {
          toast(t("tplDelete") || "Delete", t("tplDeleteFail") || "Could not delete.");
        }
      });
    },
  };
}
