-- 040: Add optional metadata columns to sessions for admin visibility.

ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS ip            INET,
    ADD COLUMN IF NOT EXISTS user_agent    TEXT,
    ADD COLUMN IF NOT EXISTS last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_sessions_user_active
    ON sessions (user_id, expires_at DESC);
