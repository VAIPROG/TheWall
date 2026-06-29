-- V3 message pins — pinned messages per chat.

CREATE TABLE IF NOT EXISTS pinned_messages (
    chat_id     UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by   UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_pinned_messages_message ON pinned_messages(message_id);
