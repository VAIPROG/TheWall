/**
 * Linked-accounts UI (Settings tab): one row per provider with live status
 * and a context-correct action — Connect when unlinked, Unlink when linked —
 * plus the remote paint-reminder toggle that depends on those links.
 *
 * Why Connect goes through the landing instead of opening the OAuth URL
 * directly: the providers redirect to the landing's callback page, which
 * needs a Wall JWT on the LANDING origin to call the exchange endpoint. The
 * `me.html#wd_jwt=…` handoff plants that token first, making the flow work
 * end-to-end no matter where it started.
 */
import { $, errMsg, noteBox } from "./helpers";
import { log } from "./log";
import { toast } from "./notify";
import { t } from "./i18n";
import { cfg, saveCfg } from "./config";
import { errorDlg } from "./dialog";
import { getActiveClient, api } from "./backend/index";
import { mapLinkStatus, type ProviderLinkRow } from "./backend/link-status";

const LANDING_BASE = "https://the-wall.vai-rice.space";

function linkManagerUrl(): string {
  // Prefer the live client token; cfg.backendToken is the legacy mirror.
  const tok = getActiveClient()?.token || cfg.backendToken || "";
  return `${LANDING_BASE}/me.html${tok ? `#wd_jwt=${encodeURIComponent(tok)}` : ""}`;
}

const PROVIDER_LABEL: Record<ProviderLinkRow["key"], string> = {
  telegram: "✈️ Telegram",
  discord: "🎮 Discord",
};

async function renderLinkRows(): Promise<void> {
  const el = $("links-rows");
  if (!el) return;
  const client = getActiveClient();
  if (!client?.on) {
    el.innerHTML = noteBox(t("offline"));
    return;
  }
  let mapped: ReturnType<typeof mapLinkStatus>;
  try {
    // /v2/me/links returns a FLAT snake_case body; mapLinkStatus() owns the
    // translation into per-provider rows (incl. Discord via-site semantics).
    mapped = mapLinkStatus(await api(client).mailbox.links());
  } catch (e) {
    el.innerHTML = noteBox("load failed: " + errMsg(e), "err");
    return;
  }
  el.innerHTML = "";
  for (const p of [mapped.telegram, mapped.discord]) {
    const row = document.createElement("div");
    row.className = "wp-link-row";
    const name = document.createElement("span");
    name.className = "wp-link-name";
    name.textContent = PROVIDER_LABEL[p.key];
    const status = document.createElement("span");
    status.className = "wp-link-status";
    if (p.linked) {
      if (p.photoUrl) {
        // Telegram exposes a profile photo — a tiny avatar next to the handle.
        const img = document.createElement("img");
        img.src = p.photoUrl;
        img.alt = "";
        img.style.cssText =
          "width:14px;height:14px;border-radius:2px;vertical-align:-2px;margin-right:3px";
        img.onerror = () => img.remove();
        status.appendChild(img);
      }
      const b = document.createElement("b");
      b.className = "ok";
      b.textContent = `✅ ${p.detail}`;
      status.title = p.detail;
      status.appendChild(b);
      if (p.note) {
        // e.g. Discord identity that came from the site login, not OAuth.
        const n = document.createElement("span");
        n.style.cssText = "color:var(--sub);margin-left:4px;font-size:10px";
        n.textContent = `(${p.note})`;
        status.appendChild(n);
      }
    } else {
      const s2 = document.createElement("span");
      s2.className = "off";
      s2.textContent = t("linksNotLinked");
      status.appendChild(s2);
    }
    // Unlink only when the backend can actually undo the link (Discord rows
    // sourced from the site login keep Connect — DELETE would be a no-op).
    const showUnlink = p.linked && p.canUnlink;
    const btn = document.createElement("button");
    btn.className = "wp-btn" + (showUnlink ? "" : " primary");
    btn.textContent = showUnlink ? t("linksUnlink") : t("linksConnect");
    btn.title = showUnlink
      ? `${t("linksUnlink")} ${PROVIDER_LABEL[p.key]}`
      : t("linksManageTip");
    btn.addEventListener("click", () => {
      if (showUnlink) void unlink(p.key);
      else window.open(linkManagerUrl(), "_blank", "noopener");
    });
    row.append(name, status, btn);
    el.appendChild(row);
  }
}

async function unlink(provider: "telegram" | "discord"): Promise<void> {
  const client = getActiveClient();
  if (!client?.on) return;
  try {
    await api(client).mailbox.unlink(provider);
    toast(t("linksLegend"), `${provider} unlinked`);
  } catch (e: any) {
    await errorDlg(`unlink failed: ${errMsg(e)}`);
  }
  await renderLinkRows();
}

export function wireLinks(): void {
  $("btn-links-manage")?.addEventListener("click", () => {
    window.open(linkManagerUrl(), "_blank", "noopener");
  });
  $("btn-links-refresh")?.addEventListener("click", () => void renderLinkRows());
  $("cfg-paint-reminder-remote")?.addEventListener("change", (e: Event) => {
    cfg.paintReminderRemote = (e.target as HTMLInputElement).checked;
    saveCfg();
    const client = getActiveClient();
    if (!cfg.paintReminderRemote && client?.on) {
      // Cancel any pending reminder so the toggle means what it says.
      api(client).mailbox.deletePaintReminder().catch(() => {});
    }
    toast(t("linksLegend"), cfg.paintReminderRemote ? "refill DMs on" : "refill DMs off");
  });
  // Initial paint is lazy — the backend may attach a moment after boot.
  setTimeout(() => void renderLinkRows(), 1500);
  // Refresh when the user returns from the landing's OAuth dance.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void renderLinkRows();
  });
  // Re-render when the backend attaches/detaches (login can land after the
  // lazy initial paint showed "offline") and whenever Settings is opened.
  // Debounced: a login emits several state changes back-to-back (token, me)
  // and each render is a network fetch — coalesce the burst into one.
  let refetchTimer = 0;
  const refetchSoon = () => {
    window.clearTimeout(refetchTimer);
    refetchTimer = window.setTimeout(() => void renderLinkRows(), 300);
  };
  document.addEventListener("wd:backend-state", refetchSoon);
  document.addEventListener("wd:tab-open-se", refetchSoon);
  log("UI", "OK", "linked-accounts wired");
}
