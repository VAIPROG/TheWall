-- 027: V3 chats — unified chat + message model with editing, soft-delete,
-- threads (reply_to), reactions, and per-user read state. Replaces the bare
-- clan_messages / direct_messages model for V3 (those stay for v2 read-compat).
-- Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS chats (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type             TEXT NOT NULL,                 -- 'global' | 'clan' | 'dm' | 'modmail'
    clan_id          UUID REFERENCES clans(id) ON DELETE CASCADE,
    dm_key           TEXT,                          -- sorted "uuidA:uuidB" for dm chats
    topic            TEXT,
    slowmode_seconds INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One global chat, one per clan, one per dm pair, one modmail per clan.
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_global  ON chats(type)    WHERE type = 'global';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_clan    ON chats(clan_id) WHERE type = 'clan';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_modmail ON chats(clan_id) WHERE type = 'modmail';
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_dm      ON chats(dm_key)  WHERE type = 'dm';

CREATE TABLE IF NOT EXISTS messages (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    author_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    content      TEXT NOT NULL,
    reply_to_id  UUID REFERENCES messages(id) ON DELETE SET NULL,
    edited_at    TIMESTAMPTZ,
    edit_count   INTEGER NOT NULL DEFAULT 0,
    deleted_at   TIMESTAMPTZ,
    deleted_by   UUID REFERENCES users(id) ON DELETE SET NULL,  -- who soft-deleted (author or a mod)
    is_system    BOOLEAN NOT NULL DEFAULT FALSE,
    version      INTEGER NOT NULL DEFAULT 1,                    -- optimistic concurrency for edits
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_messages_chat       ON messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_chat_id    ON messages(chat_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_reply      ON messages(reply_to_id) WHERE reply_to_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_reactions (
    message_id  UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    account_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, account_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_message_reactions_msg ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS chat_reads (
    chat_id              UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    account_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (chat_id, account_id)
);

-- Seed the singleton global chat.
INSERT INTO chats (type)
SELECT 'global' WHERE NOT EXISTS (SELECT 1 FROM chats WHERE type = 'global');
