import { $, errMsg } from "../helpers";
import { t } from "../i18n";
import { toast } from "../notify";
import { errorDlg, promptDlg } from "../dialog";
import { Backend } from "../backend";
import { sendClanMessage } from "../data";
import { openEmojiPicker } from "../emoji-picker";
import { attachMentions } from "../mentions";

export function wireChats(_win: HTMLElement): void {
  // DM mention autocomplete
  const dmTa = $("dm-body") as HTMLTextAreaElement | null;
  const dmMention = $("dm-mention-suggest");
  if (dmTa && dmMention) {
    attachMentions(dmTa, dmMention, async () => {
      try {
        const roster = (await Backend.req("GET", "/clan/members")) as any[];
        return (roster || []).map((r) => ({ username: r.username, id: r.id }));
      } catch {
        return [];
      }
    });
  }

  // clan tab
  $("btn-clan-send")!.addEventListener("click", sendClanMessage);

  // Announcement send (admin/mod only)
  $("btn-announce-send")?.addEventListener("click", async () => {
    const title = ($("announce-title") as HTMLInputElement)?.value.trim();
    const body = ($("announce-body") as HTMLTextAreaElement)?.value.trim();
    if (!title || !body) {
      toast("Announce", "Title and body required");
      return;
    }
    try {
      const clanId = (window as any).__wallClanId;
      if (!clanId) {
        toast("Announce", "No clan found");
        return;
      }
      await Backend.req("POST", `/v2/clans/${clanId}/announcements`, {
        title,
        body,
      });
      ($("announce-title") as HTMLInputElement).value = "";
      ($("announce-body") as HTMLTextAreaElement).value = "";
      toast("Announce", "Sent!");
    } catch (e: any) {
      toast("Announce", "Failed: " + errMsg(e));
    }
  });

  // Emoji picker — delegate to the shared module so the same UI works for the
  // clan chat and the site chat injection.
  $("btn-emoji")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const btn = $("btn-emoji");
    const ta = $("clan-chat-input") as HTMLTextAreaElement | null;
    if (!btn || !ta) return;
    btn.setAttribute("data-wd-emoji-anchor", "1");
    openEmojiPicker(ta, btn);
  });

  // Mentions autocomplete in clan chat textarea
  const chatTa = $("clan-chat-input") as HTMLTextAreaElement | null;
  const mentionEl = $("mention-suggest");
  if (chatTa && mentionEl) {
    attachMentions(chatTa, mentionEl, async () => {
      try {
        const roster = (await Backend.req("GET", "/clan/members")) as any[];
        return (roster || []).map((r) => ({
          username: r.username,
          id: r.id,
          avatar_url: r.id
            ? `${Backend.base}/avatar?userId=${encodeURIComponent(r.id)}`
            : undefined,
        }));
      } catch {
        return [];
      }
    });
  }
  // Click @mention or username → open public profile
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const u = t.dataset?.user;
    if (
      u &&
      (t.classList.contains("wp-mention") || t.classList.contains("au"))
    ) {
      e.preventDefault();
      (window as any).__wallOpenProfile?.(u);
    }
  });

  $("btn-mod-apply")!.addEventListener("click", async () => {
    if (!Backend.on) {
      await errorDlg("Connect to VAI-PROG backend first (Settings)");
      return;
    }
    const msg = await promptDlg(
      t("modApplyPrompt"),
      "",
      "Moderator Application",
    );
    if (msg == null || !String(msg).trim()) return;
    try {
      await Backend.moderationApply(String(msg).trim());
      toast("moderation", t("modSubmittedToast"));
    } catch (e: any) {
      await errorDlg("Apply failed: " + errMsg(e));
    }
  });
}
