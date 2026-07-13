/**
 * Publish screen for the Templates super-tab — the reworked Share, on V3. Takes
 * a the-wall-dev/2 document (from the Overlay hand-off, or built from the
 * current overlay) and a metadata form (name/position/scale, scope,
 * author-visibility, password, and an advanced access block: whitelist,
 * blocklist, co-editors, domains) and POSTs it to `/templates/new`. Access
 * fields live at the document root and are enforced by the backend ACL.
 */
import type { PanelScreen } from "../kit/panel-stack";
import { segmented, button, group } from "../kit/primitives";
import { emptyState } from "../kit/primitives";
import { $, esc } from "../../helpers";
import { t } from "../../i18n";
import { toast } from "../../notify";
import {
  createTemplate,
  parseIdList,
  type AuthorVisibility,
  type Scope,
  type PublishInput,
} from "./api";
import { openDetail, resetToBrowse } from "./shell";

export interface PublishHandoff {
  /** A ready the-wall-dev/2 document (built by the Overlay hand-off, which owns
   *  the overlay-encoding imports so this screen stays DOM-free / test-safe). */
  document?: Record<string, unknown>;
  name?: string;
}

interface DocTpl {
  name?: string;
  x?: number;
  y?: number;
  scale?: number;
  [k: string]: unknown;
}

/** The base document comes from the Overlay hand-off (which owns the
 *  overlay-encoding). Null when Publish is opened with nothing to publish. */
function baseDocument(handoff?: PublishHandoff): Record<string, unknown> | null {
  return handoff?.document ?? null;
}

function firstTpl(doc: Record<string, unknown>): DocTpl {
  const arr = doc.templates as DocTpl[] | undefined;
  return arr?.[0] ?? {};
}

function numInput(id: string, label: string, value: number, step = "1"): string {
  return `<label class="wd-kv" style="align-items:center">
    <span class="wd-kv-k">${esc(label)}</span>
    <input id="${id}" class="wp-input" type="number" step="${step}" value="${value}" style="width:88px">
  </label>`;
}

function textField(id: string, label: string, value: string, placeholder = ""): string {
  return `<label style="display:block;margin-top:6px">
    <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(label)}</span>
    <input id="${id}" class="wp-input" value="${esc(value)}" placeholder="${esc(placeholder)}" style="width:100%;margin-top:2px">
  </label>`;
}

function listField(id: string, label: string, hint: string): string {
  return `<label style="display:block;margin-top:6px">
    <span style="font-size:10px;color:var(--sub);text-transform:uppercase;letter-spacing:.5px">${esc(label)}</span>
    <textarea id="${id}" class="wp-input" rows="2" placeholder="${esc(hint)}" style="width:100%;margin-top:2px;resize:vertical;font:11px monospace"></textarea>
  </label>`;
}

export function publishScreen(handoff?: PublishHandoff): PanelScreen {
  const doc = baseDocument(handoff);
  let scope: Scope = "private";
  let authorVis: AuthorVisibility = "full";

  return {
    title: t("tplPublishTitle") || "Publish",
    render: () => {
      if (!doc) {
        return emptyState(
          t("tplPublishNoSource") || "Load or create an overlay first, then Publish it here.",
          "📤",
        );
      }
      const tpl = firstTpl(doc);
      const name = (tpl.name as string) || handoff?.name || "";
      const scaleGrid = `<div class="wd-kvgrid" style="margin-top:4px">
        ${numInput("pub-x", "X", Number(tpl.x ?? 0))}
        ${numInput("pub-y", "Y", Number(tpl.y ?? 0))}
        ${numInput("pub-scale", t("tplScale") || "Scale", Number(tpl.scale ?? 1), "0.1")}
      </div>`;

      const advanced = group(
        t("tplAccessAdvanced") || "Access (advanced)",
        listField("pub-wl", t("tplWhitelist") || "Whitelist (user ids)", "uuid uuid …") +
          listField("pub-bl", t("tplBlocklist") || "Blocklist (user ids)", "uuid uuid …") +
          listField("pub-edit-u", t("tplCoEditorUsers") || "Co-editors (user ids)", "uuid uuid …") +
          listField("pub-edit-c", t("tplCoEditorClans") || "Co-editor clans (clan ids)", "uuid uuid …") +
          listField("pub-domains", t("tplDomains") || "Allowed domains", "wplace.live filianislost.com"),
      );

      return `
        <div class="wd-tpl-publish">
          ${textField("pub-name", t("tplName") || "Name", name, t("tplName") || "Name")}
          ${group(t("tplPlacement") || "Placement", scaleGrid)}

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

          ${textField("pub-pass", t("tplPassword") || "Password (optional)", "", "leave empty for none")}
          ${advanced}

          <div style="margin-top:8px">${button(t("tplPublishBtn") || "Publish", {
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
        const num = (id: string, d: number) => {
          const n = Number(val(id));
          return Number.isFinite(n) ? n : d;
        };

        // Clone the base document and stamp the form's placement/name onto the
        // primary layer so the backend derives the row fields from it.
        const outDoc: Record<string, unknown> = JSON.parse(JSON.stringify(doc));
        const tpls = (outDoc.templates as DocTpl[] | undefined) ?? [];
        if (tpls[0]) {
          tpls[0].name = val("pub-name").trim() || (tpls[0].name as string) || "Untitled";
          tpls[0].x = num("pub-x", Number(tpls[0].x ?? 0));
          tpls[0].y = num("pub-y", Number(tpls[0].y ?? 0));
          tpls[0].scale = num("pub-scale", Number(tpls[0].scale ?? 1));
        }

        const input: PublishInput = {
          document: outDoc,
          scope,
          clanId: scope === "clan" ? val("pub-clan").trim() || null : null,
          password: val("pub-pass"),
          authorVisibility: authorVis,
          access: {
            usersWhitelist: parseIdList(val("pub-wl")),
            usersBlocklist: parseIdList(val("pub-bl")),
            allowedToEdit: {
              userIds: parseIdList(val("pub-edit-u")),
              clanIds: parseIdList(val("pub-edit-c")),
            },
            domainsWhitelist: parseIdList(val("pub-domains")),
          },
        };

        btn?.classList.add("is-working");
        setStatus("muted", t("tplPublishing") || "Publishing…");
        try {
          const res = await createTemplate(input);
          const id = res?.template?.id;
          const warn = res?.warnings?.length ? ` (${res.warnings.length} warning(s))` : "";
          toast(t("tplPublishBtn") || "Publish", (t("tplPublishOk") || "Published.") + warn);
          if (id) openDetail(id);
          else resetToBrowse();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus("err", (t("tplPublishFail") || "Publish failed") + ": " + msg);
        } finally {
          btn?.classList.remove("is-working");
        }
      });
    },
  };
}
