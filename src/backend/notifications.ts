import { BackendClient } from "./client";

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body?: string;
  isRead: boolean;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface NotificationPage {
  items: NotificationView[];
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
}

export interface NotificationSettings {
  userId: string;
  pushEnabled: boolean;
  templateStatusChanges: boolean;
  clanInvites: boolean;
  restrictionUpdates: boolean;
  modActions: boolean;
  systemAnnouncements: boolean;
  newsAnnouncements: boolean;
  mentions: boolean;
  updatedAt: string;
}

export interface NotificationListQuery {
  page?: number;
  perPage?: number;
  read?: boolean;
}

export function buildNotificationsApi(client: BackendClient) {
  return {
    list: (query?: NotificationListQuery) =>
      client.get<NotificationPage>("/notifications", query as Record<string, unknown>),

    get: (id: string) =>
      client.get<NotificationView>(`/notifications/${encodeURIComponent(id)}`),

    dismiss: (id: string) => client.delete(`/notifications/${encodeURIComponent(id)}`),

    ack: (ids: string[]) => client.post("/notifications/ack", { ids }),

    ackAll: () => client.post("/notifications/ack/all"),

    settings: () => client.get<NotificationSettings>("/notifications/settings"),

    updateSettings: (settings: Partial<NotificationSettings>) =>
      client.patch<NotificationSettings>("/notifications/settings", settings),
  };
}
