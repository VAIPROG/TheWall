import { BackendClient } from "./client";

export interface Reaction {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}

export interface MessageView {
  id: string;
  chatId: string;
  authorId?: string;
  authorUsername?: string;
  content: string;
  replyToId?: string;
  editedAt?: string;
  editCount: number;
  deletedAt?: string;
  deletedBy?: string;
  isSystem: boolean;
  isDeleted: boolean;
  version: number;
  createdAt: string;
  reactions: Reaction[];
}

export interface ChatSummary {
  id: string;
  type: string;
  clanId?: string;
  dmKey?: string;
  topic?: string;
  slowmodeSeconds: number;
  createdAt: string;
  unreadCount: number;
  lastMessageAt?: string;
}

export interface ParticipantView {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  role?: string;
  roleRank?: number;
  lastReadMessageId?: string;
  joinedAt?: string;
  isMuted: boolean;
}

export interface ChatViewerContext {
  role?: string;
  canPost: boolean;
  isMuted: boolean;
  lastReadMessageId?: string;
}

export interface LastMessagePreview {
  id: string;
  authorUsername?: string;
  contentPreview: string;
  createdAt: string;
}

export interface ChatDetail {
  id: string;
  type: string;
  clanId?: string;
  dmKey?: string;
  topic?: string;
  slowmodeSeconds: number;
  createdAt: string;
  participantCount: number;
  unreadCount: number;
  lastMessageAt?: string;
  lastMessage?: LastMessagePreview;
  viewer: ChatViewerContext;
  participants: ParticipantView[];
  recentMessages: MessageView[];
  pinnedMessageIds: string[];
}

export interface SendMessageRequest {
  content: string;
  replyToId?: string;
}

export interface EditMessageRequest {
  content: string;
  expectedVersion?: number;
}

export interface MessageListQuery {
  before?: string;
  after?: string;
  limit?: number;
}

export function buildChatsApi(client: BackendClient) {
  const chatPath = (id: string) => `/chats/${encodeURIComponent(id)}`;

  return {
    /** List all chats visible to the caller. */
    list: () => client.get<ChatSummary[]>("/chats"),

    /** Get the singleton global chat detail. */
    global: () => client.get<ChatDetail>("/chats/global"),

    /** Get full chat detail. */
    get: (id: string) => client.get<ChatDetail>(chatPath(id)),

    /** List messages in a chat (newest first). */
    messages: (id: string, params?: MessageListQuery) =>
      client.get<MessageView[]>(`${chatPath(id)}/messages`, params as Record<string, unknown>),

    /** Send a message to a chat. */
    send: (id: string, body: SendMessageRequest) =>
      client.post<MessageView>(`${chatPath(id)}/messages`, body),

    /** Edit a message. */
    edit: (chatId: string, messageId: string, body: EditMessageRequest) =>
      client.patch<MessageView>(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}`, body),

    /** Soft-delete a message. */
    delete: (chatId: string, messageId: string) =>
      client.delete(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}`),

    /** Mark messages in a chat as read. */
    markRead: (chatId: string, messageId?: string) =>
      client.post(`${chatPath(chatId)}/read`, { messageId }),

    /** Add a reaction to a message. */
    react: (chatId: string, messageId: string, emoji: string) =>
      client.post(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`, { emoji }),

    /** Remove a reaction from a message. */
    unreact: (chatId: string, messageId: string, emoji: string) =>
      client.delete(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`),

    /** Pin a message. */
    pin: (chatId: string, messageId: string) =>
      client.post(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}/pin`),

    /** Unpin a message. */
    unpin: (chatId: string, messageId: string) =>
      client.delete(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}/pin`),

    /** Report a message. */
    report: (chatId: string, messageId: string, reason: string, evidence?: string) =>
      client.post(`${chatPath(chatId)}/messages/${encodeURIComponent(messageId)}/report`, { reason, evidence }),

    /** Open or create a DM thread with a user. */
    dm: (userRef: string) => client.get<ChatDetail>(`/dm/${encodeURIComponent(userRef)}`),

    /** Send a DM to a user (auto-creates thread). */
    sendDm: (userRef: string, body: SendMessageRequest) =>
      client.post<MessageView>(`/dm/${encodeURIComponent(userRef)}`, body),

    /** Open or create the caller's modmail thread. */
    modmail: () => client.get<ChatDetail>("/chats/global/modmail"),

    /** Send a modmail message. */
    sendModmail: (body: SendMessageRequest) =>
      client.post<MessageView>("/chats/global/modmail", body),
  };
}
