-- 041: V3 chats — pins, mentions, per-opener modmail threads, send idempotency.
-- (Was mis-numbered 028 — collided with 028_v3_achievements and never applied;
--  renumbered to a unique trailing version so sqlx runs it. Idempotent.)
-- Forward-only, idempotent. Builds on 027.

-- ---- Pins -----------------------------------------------------------------
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_messages_pinned
    ON messages (chat_id) WHERE pinned_at IS NOT NULL;

-- ---- Mentions -------------------------------------------------------------
-- Account UUIDs explicitly referenced in the message body.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions UUID[] NOT NULL DEFAULT '{}';

-- ---- Send idempotency -----------------------------------------------------
-- Client-supplied nonce; a repeat send with the same (chat, author, nonce)
-- returns the existing message instead of inserting a duplicate.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS client_nonce TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce
    ON messages (chat_id, author_id, client_nonce)
    WHERE client_nonce IS NOT NULL;

-- ---- Per-opener modmail ---------------------------------------------------
-- Modmail is a private thread between one user (the opener) and the mod team.
-- Each user has at most one global modmail thread; mods/admins/owners may read
-- ALL modmail threads, a regular user only their own.  Replaces the previous
-- one-modmail-per-clan model.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS opener_id UUID REFERENCES users(id) ON DELETE CASCADE;
DROP INDEX IF EXISTS idx_chats_modmail;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_modmail_opener
    ON chats (opener_id) WHERE type = 'modmail';
