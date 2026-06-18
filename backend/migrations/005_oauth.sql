-- 005: OAuth / widget link tracking.

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_photo_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_auth_date TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_linked_via_oauth BOOLEAN NOT NULL DEFAULT FALSE;

-- Short-lived state tokens for Discord OAuth handshake.
CREATE TABLE IF NOT EXISTS oauth_states (
    state           TEXT PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,         -- 'discord' for now
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes'
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_exp ON oauth_states(expires_at);

-- Email-by-support requests: user gets a code, mails it to admin, admin
-- approves which fills users.notifications_email.
CREATE TABLE IF NOT EXISTS email_link_requests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    proposed_email TEXT NOT NULL,
    code        TEXT NOT NULL,         -- 6-char base32
    status      TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'rejected'
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_email_link_user ON email_link_requests(user_id, status);
