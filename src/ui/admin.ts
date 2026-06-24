import { $, esc, errMsg } from "../helpers";
import { t } from "../i18n";
import { ic } from "../icons";
import { toast } from "../notify";
import { confirmDlg, errorDlg, infoDlg } from "../dialog";
import { log } from "../log";
import { Backend } from "../backend";
import {
  loadAdminUsers,
  loadModApps,
  loadAdminTemplates,
  loadAdminNotifs,
  broadcastNotification,
} from "../admin-ui";
import {
  listCatalogue,
  adminGrant,
  adminRevoke,
  adminGrantByName,
  adminRevokeByName,
  adminCreate,
} from "../achievements";

export function wireAdmin(_win: HTMLElement): void {
  // admin
  $("btn-admin-reload")?.addEventListener("click", () => {
    loadAdminUsers();
    loadModApps();
    loadAdminTemplates();
    loadAdminNotifs();
  });
  $("btn-broadcast")?.addEventListener("click", broadcastNotification);

  // Admin: achievement grant/revoke. Populate the picker from the catalogue
  // the first time the tab is opened (we lazy-load so non-admins never see it).
  let achCatalogueLoaded = false;
  async function loadAchCatalogue(): Promise<void> {
    if (achCatalogueLoaded) return;
    achCatalogueLoaded = true;
    const sel = $("admin-ach-id") as HTMLSelectElement | null;
    if (!sel) return;
    const cat = await listCatalogue();
    if (!cat.length) {
      achCatalogueLoaded = false;
      return;
    }
    const byCat = new Map<string, typeof cat>();
    for (const a of cat) {
      const arr = byCat.get(a.category) || [];
      arr.push(a);
      byCat.set(a.category, arr);
    }
    sel.innerHTML =
      `<option value="" disabled selected>${esc(t("achAdminPickAch"))}</option>` +
      [...byCat.entries()]
        .map(
          ([cat, items]) =>
            `<optgroup label="${esc(cat)}">${items
              .map(
                (a) =>
                  `<option value="${esc(a.id)}">${esc(a.name)} · ${a.points} pts${a.secret ? " 🔒" : ""}</option>`,
              )
              .join("")}</optgroup>`,
        )
        .join("");
  }
  document
    .querySelectorAll('.wp-tab[data-p="ad"]')
    .forEach((b) => b.addEventListener("click", () => loadAchCatalogue()));
  // The same input field accepts either a UUID (legacy direct path) or a
  // username (looked up server-side). We pick the route by sniffing for a
  // standard UUID v4 shape — anything that doesn't match goes through the
  // username endpoint, which 404s for unknown names.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  $("btn-admin-ach-grant")?.addEventListener("click", async () => {
    const who = ($("admin-ach-uid") as HTMLInputElement)?.value.trim();
    const aid = ($("admin-ach-id") as HTMLSelectElement)?.value;
    if (!who || !aid) {
      await errorDlg("Enter a username or UUID and pick an achievement");
      return;
    }
    try {
      const r = UUID_RE.test(who)
        ? await adminGrant(who, aid)
        : await adminGrantByName(who, aid);
      if (r) {
        toast("Admin", `granted "${r.achievement.name}" (new=${r.was_new})`);
      } else {
        await errorDlg("Grant failed (see console)");
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      await errorDlg(
        msg.includes("no such user")
          ? `No such user: ${who}`
          : `Grant failed: ${msg}`,
      );
    }
  });
  $("btn-admin-ach-revoke")?.addEventListener("click", async () => {
    const who = ($("admin-ach-uid") as HTMLInputElement)?.value.trim();
    const aid = ($("admin-ach-id") as HTMLSelectElement)?.value;
    if (!who || !aid) {
      await errorDlg("Enter a username or UUID and pick an achievement");
      return;
    }
    if (!(await confirmDlg(`Revoke "${aid}" from ${who}?`, "Revoke"))) return;
    try {
      const ok = UUID_RE.test(who)
        ? await adminRevoke(who, aid)
        : await adminRevokeByName(who, aid);
      if (ok) toast("Admin", "revoked");
      else await errorDlg("Revoke failed");
    } catch (e: any) {
      const msg = e?.message || String(e);
      await errorDlg(
        msg.includes("no such user")
          ? `No such user: ${who}`
          : `Revoke failed: ${msg}`,
      );
    }
  });
  $("btn-admin-ach-create")?.addEventListener("click", async () => {
    const id = ($("admin-ach-new-id") as HTMLInputElement)?.value.trim();
    const name = ($("admin-ach-new-name") as HTMLInputElement)?.value.trim();
    const desc = ($("admin-ach-new-desc") as HTMLInputElement)?.value.trim();
    const icon =
      ($("admin-ach-new-icon") as HTMLSelectElement)?.value || "medal";
    const category =
      ($("admin-ach-new-cat") as HTMLSelectElement)?.value || "general";
    const points = Number(
      ($("admin-ach-new-pts") as HTMLInputElement)?.value || "10",
    );
    const secret =
      ($("admin-ach-new-secret") as HTMLInputElement)?.checked || false;
    if (!id || !name || !desc) {
      await errorDlg("ID, name and description are required");
      return;
    }
    if (!/^[a-z0-9_]+$/.test(id)) {
      await errorDlg("ID must be lowercase snake_case (a–z, 0–9, _)");
      return;
    }
    try {
      const row = await adminCreate({
        id,
        name,
        description: desc,
        icon,
        category,
        points,
        secret,
      });
      if (row) {
        toast("Admin", `${t("achAdminCreated")}: ${row.name}`);
        // Refresh the grant dropdown.
        const opt = document.createElement("option");
        opt.value = row.id;
        opt.textContent = `${row.name} · ${row.points} pts${row.secret ? " 🔒" : ""}`;
        ($("admin-ach-id") as HTMLSelectElement | null)?.appendChild(opt);
        // Reset the form.
        ($("admin-ach-new-id") as HTMLInputElement).value = "";
        ($("admin-ach-new-name") as HTMLInputElement).value = "";
        ($("admin-ach-new-desc") as HTMLInputElement).value = "";
      }
    } catch (e: any) {
      await errorDlg("Create failed: " + errMsg(e));
    }
  });

  $("btn-backfill-previews")?.addEventListener("click", async () => {
    const ok = await confirmDlg(
      "Generate previews for every template that doesn't have one yet?\nThis can take a while on a large catalog.",
      "Backfill previews",
    );
    if (!ok) return;
    const btn = $("btn-backfill-previews") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Working…";
    }
    try {
      const r = await Backend.req(
        "POST",
        "/v2/admin/templates/backfill-previews",
        {},
      );
      log("ADMIN", "OK", "backfill: " + JSON.stringify(r));
      await infoDlg(
        `Scanned ${r.scanned}\n` +
          `Generated ${r.generated}\n` +
          `Skipped (undecodable share) ${r.skipped_undecodable}\n` +
          `Skipped (already cached) ${r.skipped_already_cached}\n` +
          `Failed ${r.failed}`,
        "Backfill complete",
      );
    } catch (e: any) {
      await errorDlg("Backfill failed: " + errMsg(e));
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = ic("scan") + "Backfill missing previews";
      }
    }
  });
}
