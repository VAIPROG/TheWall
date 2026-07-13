/**
 * Publish / Share screen for the Templates super-tab — the reworked Share, on
 * V3. Placement & scale are the Overlay's job; this screen is purely about
 * *sharing*: it shows what you're sharing (preview + name), lets you set
 * metadata (name, notes, contacts) and access, then POSTs to `/templates/new`
 * — or PATCHes an existing template in edit mode.
 *
 * Access model: whitelist and blocklist are mutually exclusive (a segmented
 * "who can see" — Everyone / Only-listed / All-except-listed). Whitelist means
 * "deny all except listed"; blocklist means "allow all except listed". The
 * blocklist can't contain you or your co-editors (they're always allowed), and
 * server staff are immune to it (enforced by the backend ACL). Access lists
 * accept usernames, resolved to uuids server-side before publishing.
 *
 * DOM-free (no overlay/formats imports) so the shell test stays import-safe.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { segmented, button, group } from "../kit/primitives";
import { emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { toast } from "../../notify";
import { getActiveClient } from "../../backend/index";
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

type AccessMode = "everyone" | "whitelist" | "blocklist";

export interface PublishAccessPrefill {
  usersWhitelist?: string[];
  usersBlocklist?: string[];
  coEditorUsers?: string[];
  coEditorClans?: string[];
  domains?: string[];
}

export interface PublishHandoff {
  document?: Record<string, unknown>;
  name?: string;
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
function previewSrc(doc: Record<string, unknown>): string {
  const src = firstTpl(doc).imageSources?.[0];
  return typeof src === "string" ? src : "";
}
const joinList = (a?: string[]): string => (a?.length ? a.join(" ") : "");

/** Read a prefilled contact handle for a platform from a document's contacts. */
function contactVal(doc: Record<string, unknown>, key: string, field: "link" | "url"): string {
  const arr = (doc.contacts as Record<string, unknown> | undefined)?.[key] as
    | Array<Record<string, unknown>>
    | undefined;
  const v = arr?.[0]?.[field];
  return typeof v === "string" ? v : "";
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

export function publishScreen(handoff?: PublishHandoff): PanelScreen {
  const doc = handoff?.document ?? null;
  const isEdit = !!handoff?.editId;
  let scope: Scope = handoff?.scope ?? "private";
  let authorVis: AuthorVisibility = handoff?.authorVisibility ?? "full";
  const acc = handoff?.access ?? {};
  let accessMode: AccessMode = acc.usersWhitelist?.length
    ? "whitelist"
    : acc.usersBlocklist?.length
      ? "blocklist"
      : "everyone";

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
      const accListValue = joinList(
        accessMode === "whitelist" ? acc.usersWhitelist : accessMode === "blocklist" ? acc.usersBlocklist : [],
      );
      const me = getActiveClient()?.me;

      const hero = src
        ? `<div class="wd-tpl-hero"><img class="wd-tpl-hero-img" src="${esc(src)}" onerror="this.style.opacity=.2"></div>`
        : "";

      const contacts = group(
        t("tplContacts") || "Contacts (optional)",
        textField("pub-c-discord", "Discord", contactVal(doc, "discord", "link"), "invite / profile link") +
          textField("pub-c-tg", "Telegram", contactVal(doc, "telegram", "link"), "t.me/…") +
          textField("pub-c-x", "X", contactVal(doc, "x", "link"), "x.com/…") +
          textField("pub-c-site", t("tplWebsite") || "Website", contactVal(doc, "site", "url"), "https://…"),
      );

      const accessGroup = group(
        t("tplAccess") || "Access",
        `<div>
          <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(t("tplWhoCanSee") || "Who can see")}</span>
          <div id="pub-accmode" style="margin-top:2px">${segmented(
            [
              { value: "everyone", label: t("tplAccEveryone") || "Everyone" },
              { value: "whitelist", label: t("tplAccWhitelist") || "Only listed" },
              { value: "blocklist", label: t("tplAccBlocklist") || "All but listed" },
            ],
            accessMode,
          )}</div>
        </div>
        <div id="pub-acclist-wrap" style="display:${accessMode === "everyone" ? "none" : "block"}">
          ${listField("pub-acclist", t("tplAccUsers") || "Users", accListValue, "@alice bob")}
        </div>
        <div style="font-size:10px;color:var(--sub);margin-top:2px">${esc(t("tplAccessHint") || "Usernames or ids, space/comma separated.")}</div>
        ${listField("pub-edit-u", t("tplCoEditorUsers") || "Co-editors (users)", joinList(acc.coEditorUsers), "@alice")}
        ${listField("pub-edit-c", t("tplCoEditorClans") || "Co-editor clans (clan ids)", joinList(acc.coEditorClans), "clan-uuid")}
        ${listField("pub-domains", t("tplDomains") || "Allowed domains", joinList(acc.domains), "wplace.live filianislost.com")}`,
      );

      return `
        <div class="wd-tpl-publish">
          ${hero}
          ${textField("pub-name", t("tplName") || "Name", name, t("tplName") || "Name")}
          ${listField("pub-notes", t("tplNotes") || "Notes", notesText, t("tplNotesHint") || "One note per line")}
          ${contacts}

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
            <div id="pub-author-hint" style="font-size:10px;color:var(--sub);margin-top:2px;display:${authorVis === "full" && me?.username ? "block" : "none"}">${esc((t("tplSharingAs") || "Sharing as") + " @" + (me?.username ?? ""))}</div>
          </div>

          ${textField("pub-pass", t("tplPassword") || "Password (optional)", "", isEdit ? "unchanged unless set" : "leave empty for none")}
          ${accessGroup}

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
        const hint = $("pub-author-hint");
        if (hint) hint.style.display = authorVis === "full" && getActiveClient()?.me?.username ? "block" : "none";
      });
      wireSeg("pub-accmode", (v) => {
        accessMode = (v as AccessMode) || "everyone";
        const wrap = $("pub-acclist-wrap");
        if (wrap) wrap.style.display = accessMode === "everyone" ? "none" : "block";
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

        const acclistRefs = accessMode === "everyone" ? [] : parseIdList(val("pub-acclist"));
        const coURefs = parseIdList(val("pub-edit-u"));
        const coCRefs = parseIdList(val("pub-edit-c"));
        const domains = parseIdList(val("pub-domains"));
        const userRefs = [...new Set([...acclistRefs, ...coURefs])];

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
          const acclistIds = toIds(acclistRefs);
          const coUIds = toIds(coURefs);

          // Blocklist can't contain you or your co-editors (they're always
          // allowed anyway); server staff are immune on the backend.
          if (accessMode === "blocklist") {
            const meId = getActiveClient()?.me?.id;
            const bad = acclistIds.filter((uid) => uid === meId || coUIds.includes(uid));
            if (bad.length) {
              setStatus("err", t("tplBlocklistSelf") || "The blocklist can't contain you or your co-editors.");
              btn?.classList.remove("is-working");
              return;
            }
          }

          const access: AccessConfig = {
            usersWhitelist: accessMode === "whitelist" ? acclistIds : [],
            usersBlocklist: accessMode === "blocklist" ? acclistIds : [],
            allowedToEdit: { userIds: coUIds, clanIds: coCRefs },
            domainsWhitelist: domains,
          };

          // Contacts (only non-empty platforms).
          const contacts: Record<string, unknown> = {};
          const dc = val("pub-c-discord").trim();
          if (dc) contacts.discord = [{ type: "user", link: dc }];
          const tg = val("pub-c-tg").trim();
          if (tg) contacts.telegram = [{ type: "user", link: tg }];
          const x = val("pub-c-x").trim();
          if (x) contacts.x = [{ link: x }];
          const site = val("pub-c-site").trim();
          if (site) contacts.site = [{ url: site }];

          const notes = val("pub-notes").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const name = val("pub-name").trim();
          const password = val("pub-pass");

          if (isEdit && handoff?.editId) {
            const patch: Record<string, unknown> = {
              scope,
              doc: {
                name: name || undefined,
                notes,
                contacts: Object.keys(contacts).length ? contacts : undefined,
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
              contacts: Object.keys(contacts).length ? contacts : undefined,
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
