-- v2.1.0 — DMs, account deletion, discord_username, account_deletions

ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_lang TEXT DEFAULT 'en';
ALTER TABLE users ADD COLUMN IF NOT EXISTS deletion_requested_at TIMESTAMPTZ;

-- Direct messages between two users
CREATE TABLE IF NOT EXISTS direct_messages (
    id UUID PRIMARY KEY,
    from_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_dm_to ON direct_messages(to_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dm_pair ON direct_messages(from_user_id, to_user_id, created_at);

-- Account deletion requests (GDPR-style)
CREATE TABLE IF NOT EXISTS account_deletions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ
);
