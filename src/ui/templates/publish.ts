/**
 * Publish / Share screen for the Templates super-tab — the reworked Share, on
 * V3. Placement & scale are the Overlay's job; this screen is purely about
 * *sharing*: it shows what you're sharing (a preview + name), lets you set
 * metadata (name, notes) and access (scope, author visibility, password, and an
 * advanced block of whitelist / blocklist / co-editors by username, plus
 * domains), then POSTs to `/templates/new` — or PATCHes an existing template in
 * edit mode. Usernames in the access lists are resolved to uuids server-side.
 *
 * DOM-free (no overlay/formats imports) so the shell test stays import-safe;
 * the hand-off (handoff.ts) builds the document from the overlay.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { segmented, button, group } from "../kit/primitives";
import { emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { toast } from "../../notify";
import {
  createTemplate,
  patchTemplate,
  parseIdList,
  resolveUsernames,
  type AuthorVisibility,
  type Scope,
  type AccessConfig,
} from "./api";
import { openDetail, resetToBrowse } from "./shell";

export interface PublishAccessPrefill {
  usersWhitelist?: string[];
  usersBlocklist?: string[];
  coEditorUsers?: string[];
  coEditorClans?: string[];
  domains?: string[];
}

export interface PublishHandoff {
  /** the-wall-dev/2 document (built by the Overlay hand-off, or an existing
   *  template's document in edit mode). */
  document?: Record<string, unknown>;
  name?: string;
  /** When set, PATCH this template instead of creating a new one. */
  editId?: string;
  scope?: Scope;
  authorVisibility?: AuthorVisibility;
  access?: PublishAccessPrefill;
  notes?: string[];
}

interface DocTpl {
  name?: string;
  imageSources?: string[];
  [k: string]: unknown;
}

function firstTpl(doc: Record<string, unknown>): DocTpl {
  return (doc.templates as DocTpl[] | undefined)?.[0] ?? {};
}

/** The primary image (data URI or URL) to show as the share preview. */
function previewSrc(doc: Record<string, unknown>): string {
  const src = firstTpl(doc).imageSources?.[0];
  return typeof src === "string" ? src : "";
}

function textField(id: string, label: string, value: string, placeholder = ""): string {
  return `<label style="display:block;margin-top:6px">
    <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(label)}</span>
    <input id="${id}" class="wp-input" value="${esc(value)}" placeholder="${esc(placeholder)}" style="width:100%;margin-top:2px">
  </label>`;
}

function listField(id: string, label: string, value: string, hint: string): string {
  return `<label style="display:block;margin-top:6px">
    <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(label)}</span>
    <textarea id="${id}" class="wp-input" rows="2" placeholder="${esc(hint)}" style="width:100%;margin-top:2px;resize:vertical;font:11px monospace">${esc(value)}</textarea>
  </label>`;
}

const joinList = (a?: string[]): string => (a?.length ? a.join(" ") : "");

export function publishScreen(handoff?: PublishHandoff): PanelScreen {
  const doc = handoff?.document ?? null;
  const isEdit = !!handoff?.editId;
  let scope: Scope = handoff?.scope ?? "private";
  let authorVis: AuthorVisibility = handoff?.authorVisibility ?? "full";

  return {
    title: isEdit ? t("tplEditTitle") || "Edit share" : t("tplPublishTitle") || "Publish",
    render: () => {
      if (!doc) {
        return emptyState(
          t("tplPublishNoSource") || "Load a template onto the wall (Overlay tab), then hit Share to publish it here.",
          "📤",
        );
      }
      const tpl = firstTpl(doc);
      const name = (tpl.name as string) || handoff?.name || "";
      const src = previewSrc(doc);
      const notesText = (handoff?.notes ?? (doc.notes as string[] | undefined) ?? []).join("\n");
      const acc = handoff?.access ?? {};

      const hero = src
        ? `<div class="wd-tpl-hero"><img class="wd-tpl-hero-img" src="${esc(src)}" onerror="this.style.opacity=.2"></div>`
        : "";

      const advanced = group(
        t("tplAccessAdvanced") || "Access (advanced)",
        `<div style="font-size:10px;color:var(--sub);margin-bottom:2px">${esc(t("tplAccessHint") || "Usernames or ids, space/comma separated.")}</div>` +
          listField("pub-wl", t("tplWhitelist") || "Whitelist (users)", joinList(acc.usersWhitelist), "@alice bob") +
          listField("pub-bl", t("tplBlocklist") || "Blocklist (users)", joinList(acc.usersBlocklist), "@spammer") +
          listField("pub-edit-u", t("tplCoEditorUsers") || "Co-editors (users)", joinList(acc.coEditorUsers), "@alice") +
          listField("pub-edit-c", t("tplCoEditorClans") || "Co-editor clans (clan ids)", joinList(acc.coEditorClans), "clan-uuid") +
          listField("pub-domains", t("tplDomains") || "Allowed domains", joinList(acc.domains), "wplace.live filianislost.com"),
      );

      return `
        <div class="wd-tpl-publish">
          ${hero}
          ${textField("pub-name", t("tplName") || "Name", name, t("tplName") || "Name")}
          ${listField("pub-notes", t("tplNotes") || "Notes", notesText, t("tplNotesHint") || "One note per line")}

          <div style="margin-top:6px">
            <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(t("tplScope") || "Scope")}</span>
            <div id="pub-scope" style="margin-top:2px">${segmented(
              [
                { value: "private", label: t("tplScopePrivate") || "Private" },
                { value: "clan", label: t("tplClan") || "Clan" },
                { value: "public", label: t("tplPublic") || "Public" },
              ],
              scope,
            )}</div>
          </div>
          <div id="pub-clan-wrap" style="display:${scope === "clan" ? "block" : "none"}">
            ${textField("pub-clan", t("tplClanId") || "Clan id (optional)", "", "defaults to your clan")}
          </div>

          <div style="margin-top:6px">
            <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(t("tplAuthorVis") || "Author visibility")}</span>
            <div id="pub-author" style="margin-top:2px">${segmented(
              [
                { value: "full", label: t("tplAuthorFull") || "Full" },
                { value: "anon", label: t("tplAuthorAnon") || "Anon" },
                { value: "hidden", label: t("tplAuthorHidden") || "Hidden" },
              ],
              authorVis,
            )}</div>
          </div>

          ${textField("pub-pass", t("tplPassword") || "Password (optional)", "", isEdit ? "unchanged unless set" : "leave empty for none")}
          ${advanced}

          <div style="margin-top:8px">${button(isEdit ? t("tplSaveChanges") || "Save changes" : t("tplPublishBtn") || "Publish", {
            variant: "primary",
            full: true,
            id: "pub-submit",
            icon: "upload",
          })}</div>
          <div id="pub-status" class="wd-status wd-status--muted" style="margin-top:6px;min-height:14px"></div>
        </div>`;
    },
    onMount: () => {
      if (!doc) return;
      const wireSeg = (wrapId: string, onPick: (v: string) => void) => {
        $(wrapId)
          ?.querySelectorAll<HTMLElement>("[data-seg]")
          .forEach((b) =>
            b.addEventListener("click", () => {
              $(wrapId)
                ?.querySelectorAll<HTMLElement>("[data-seg]")
                .forEach((x) => x.classList.toggle("is-on", x === b));
              onPick(b.dataset.seg || "");
            }),
          );
      };
      wireSeg("pub-scope", (v) => {
        scope = (v as Scope) || "private";
        const wrap = $("pub-clan-wrap");
        if (wrap) wrap.style.display = scope === "clan" ? "block" : "none";
      });
      wireSeg("pub-author", (v) => {
        authorVis = (v as AuthorVisibility) || "full";
      });

      $("pub-submit")?.addEventListener("click", async () => {
        const btn = $("pub-submit") as HTMLButtonElement | null;
        const status = $("pub-status");
        const setStatus = (cls: string, msg: string) => {
          if (status) {
            status.className = `wd-status wd-status--${cls}`;
            status.textContent = msg;
          }
        };
        const val = (id: string) => ($(id) as HTMLInputElement | null)?.value ?? "";

        // Resolve every user ref (whitelist/blocklist/co-editors) to uuids in a
        // single batch. Clans + domains are passed through as-is.
        const wl = parseIdList(val("pub-wl"));
        const bl = parseIdList(val("pub-bl"));
        const coU = parseIdList(val("pub-edit-u"));
        const coC = parseIdList(val("pub-edit-c"));
        const domains = parseIdList(val("pub-domains"));
        const userRefs = [...new Set([...wl, ...bl, ...coU])];

        btn?.classList.add("is-working");
        setStatus("muted", t("tplPublishing") || "Working…");

        try {
          let map: Record<string, string> = {};
          if (userRefs.length) {
            const res = await resolveUsernames(userRefs);
            map = res.resolved;
            if (res.unresolved.length) {
              setStatus("err", (t("tplUnknownUsers") || "Unknown users") + ": " + res.unresolved.join(", "));
              btn?.classList.remove("is-working");
              return;
            }
          }
          const toIds = (refs: string[]) => refs.map((r) => map[r] ?? r);

          const access: AccessConfig = {
            usersWhitelist: toIds(wl),
            usersBlocklist: toIds(bl),
            allowedToEdit: { userIds: toIds(coU), clanIds: coC },
            domainsWhitelist: domains,
          };
          const notes = val("pub-notes")
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
          const name = val("pub-name").trim();
          const password = val("pub-pass");

          if (isEdit && handoff?.editId) {
            // PATCH: doc.access merges into the document root; empty arrays clear.
            const patch: Record<string, unknown> = {
              scope,
              doc: {
                name: name || undefined,
                notes,
                access: {
                  usersWhitelist: access.usersWhitelist,
                  usersBlocklist: access.usersBlocklist,
                  allowedToEdit: access.allowedToEdit,
                  domainsWhitelist: access.domainsWhitelist,
                },
                authorVisibility: authorVis,
              },
              ...(scope === "clan" && val("pub-clan").trim() ? { clanId: val("pub-clan").trim() } : {}),
              ...(password.trim() ? { accessPassword: password.trim() } : {}),
            };
            await patchTemplate(handoff.editId, patch);
            toast(t("tplSaveChanges") || "Save changes", t("tplSaveOk") || "Changes saved.");
            openDetail(handoff.editId);
          } else {
            // CREATE: stamp name onto the primary layer; access lives at doc root.
            const outDoc: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
            const tpls = (outDoc.templates as DocTpl[] | undefined) ?? [];
            if (tpls[0] && name) tpls[0].name = name;
            const res = await createTemplate({
              document: outDoc,
              scope,
              clanId: scope === "clan" ? val("pub-clan").trim() || null : null,
              password,
              authorVisibility: authorVis,
              access,
              notes,
            });
            const id = res?.template?.id;
            const warn = res?.warnings?.length ? ` (${res.warnings.length} warning(s))` : "";
            toast(t("tplPublishBtn") || "Publish", (t("tplPublishOk") || "Published.") + warn);
            if (id) openDetail(id);
            else resetToBrowse();
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus("err", (t("tplPublishFail") || "Failed") + ": " + msg);
        } finally {
          btn?.classList.remove("is-working");
        }
      });
    },
  };
}
