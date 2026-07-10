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
import type { LinkStatus } from "./backend/mailbox";

const LANDING_BASE = "https://the-wall.vai-rice.space";

function linkManagerUrl(): string {
  const tok = cfg.backendToken || "";
  return `${LANDING_BASE}/me.html${tok ? `#wd_jwt=${encodeURIComponent(tok)}` : ""}`;
}

interface ProviderRow {
  key: "telegram" | "discord";
  label: string;
  linked: boolean;
  detail: string;
}

function providerRows(s: LinkStatus): ProviderRow[] {
  return [
    {
      key: "telegram",
      label: "✈️ Telegram",
      linked: !!(s.telegram?.username),
      detail: s.telegram?.username
        ? `@${s.telegram.username}`
        : "",
    },
    {
      key: "discord",
      label: "🎮 Discord",
      linked: !!(s.discord?.username),
      detail: s.discord?.username
        ? `${s.discord.username}`
        : "",
    },
  ];
}

async function renderLinkRows(): Promise<void> {
  const el = $("links-rows");
  if (!el) return;
  const client = getActiveClient();
  if (!client?.on) {
    el.innerHTML = noteBox(t("offline"));
    return;
  }
  let s: LinkStatus;
  try {
    s = await api(client).mailbox.links();
  } catch (e) {
    el.innerHTML = noteBox("load failed: " + errMsg(e), "err");
    return;
  }
  el.innerHTML = "";
  for (const p of providerRows(s)) {
    const row = document.createElement("div");
    row.className = "wp-link-row";
    const name = document.createElement("span");
    name.className = "wp-link-name";
    name.textContent = p.label;
    const status = document.createElement("span");
    status.className = "wp-link-status";
    if (p.linked) {
      const b = document.createElement("b");
      b.className = "ok";
      b.textContent = `✅ ${p.detail}`;
      status.title = p.detail;
      status.appendChild(b);
    } else {
      const s2 = document.createElement("span");
      s2.className = "off";
      s2.textContent = t("linksNotLinked");
      status.appendChild(s2);
    }
    const btn = document.createElement("button");
    btn.className = "wp-btn" + (p.linked ? "" : " primary");
    btn.textContent = p.linked ? t("linksUnlink") : t("linksConnect");
    btn.title = p.linked
      ? `${t("linksUnlink")} ${p.label}`
      : t("linksManageTip");
    btn.addEventListener("click", () => {
      if (p.linked) void unlink(p.key);
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
  log("UI", "OK", "linked-accounts wired");
}
