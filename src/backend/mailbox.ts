import { BackendClient } from "./client";
import type { LinkStatusWire } from "./link-status";
import type { NotificationView } from "./notifications";

export interface InboxItem extends NotificationView {}

/** @deprecated V2 mailbox has been replaced by V3 notifications and chats. */
export interface LegacyMailboxItem {
  id?: string;
  title?: string;
  body?: string;
  createdAt?: string;
}

export interface SendDmRequest {
  to: string;
  content: string;
}

export function buildMailboxApi(client: BackendClient) {
  return {
    // Notifications have replaced the legacy mailbox.
    notifications: () => client.get<{ items: NotificationView[] }>("/notifications", { perPage: 100 }),

    /** V3 DM send (auto-creates thread). */
    sendDm: (to: string, content: string) => client.post(`/dm/${encodeURIComponent(to)}`, { content }),

    /** V3 modmail send. */
    sendModmail: (content: string) => client.post("/chats/global/modmail", { content }),

    // -----------------------------------------------------------------------
    // Legacy compatibility aliases
    // ------------------------------------------------------------------------

    /** @deprecated use `api(client).chats.list()` and `api(client).chats.messages()`. */
    clanMessages: () => client.get<unknown[]>("/chats/global/messages"),

    /** @deprecated use `api(client).chats.send()`. */
    sendClanMessage: (_content: string) => {
      throw new Error("sendClanMessage is deprecated; use api(client).chats.send(chatId, {content})");
    },

    /** @deprecated use `api(client).chats.delete()`. */
    deleteClanMessage: (_messageId: string) => {
      throw new Error("deleteClanMessage is deprecated; use api(client).chats.delete(chatId, messageId)");
    },

    /** @deprecated use `api(client).chats.list()` to find the clan chat. */
    clanMembers: () => client.getRoot<unknown[]>("/clan/members"),

    /** @deprecated use `api(client).moderation.reports.create()`. */
    moderationApply: (_message: string) => {
      throw new Error("moderationApply is deprecated; use api(client).moderation.createReport()");
    },

    /** @deprecated use `api(client).templates.*`. */
    listClanTemplates: () => client.getRoot<unknown[]>("/clan/templates"),

    /** @deprecated notifications replaced mailbox announcements. */
    listMailbox: (_kind?: string) => {
      throw new Error("listMailbox is deprecated; use api(client).notifications.list()");
    },

    /** @deprecated use `api(client).notifications.ack()`. */
    markRead: (_id: string) => {
      throw new Error("markRead is deprecated; use api(client).notifications.ack([id])");
    },

    /** @deprecated use `api(client).notifications.ackAll()`. */
    readAll: (_kind?: string) => {
      throw new Error("readAll is deprecated; use api(client).notifications.ackAll()");
    },

    /** @deprecated use `api(client).chats.dm()` / `api(client).chats.sendDm()`. */
    reply: (_id: string, _body: string) => {
      throw new Error("reply is deprecated; use api(client).chats.sendDm(userRef, {content})");
    },

    /** @deprecated use `api(client).mailbox.setPaintReminder`. */
    setPaintReminder: (dueInSecs: number) => client.postRoot("/v2/me/paint-reminder", { due_in_secs: dueInSecs }),

    /** @deprecated use `api(client).mailbox.deletePaintReminder`. */
    deletePaintReminder: () => client.deleteRoot("/v2/me/paint-reminder"),

    /** Flat snake_case wire shape — feed through `mapLinkStatus()` for UI. */
    links: () => client.getRoot<LinkStatusWire>("/v2/me/links"),

    /** @deprecated use `api(client).users.unlink()`. */
    unlink: (provider: string) => client.deleteRoot(`/v2/me/links/${encodeURIComponent(provider)}`),

    /** @deprecated use `api(client).legacy.leaderboard()`. */
    leaderboard: () => client.getRoot("/stats/leaderboard"),

    /** @deprecated use `api(client).notifications.list()`. */
    announcements: () => client.getRoot<NotificationView[]>("/announcements"),

    /** @deprecated use `api(client).legacy.i18n()`. */
    i18n: (lng: string) => client.getRoot<Record<string, string>>(`/i18n/${encodeURIComponent(lng)}`),
  };
}
