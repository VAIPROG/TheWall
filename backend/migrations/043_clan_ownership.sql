-- 043_clan_ownership.sql
-- Ownership verification for clans + a per-user site-clan suggestion cache
-- (replaces the login-time auto-create; see routes/auth.rs).

ALTER TABLE clans
    ADD COLUMN IF NOT EXISTS owner_verified      BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS owner_verified_via  TEXT,
    ADD COLUMN IF NOT EXISTS owner_verified_at   TIMESTAMPTZ;

-- One filianislost site-clan suggestion per user, refreshed on each site login.
-- The client turns a suggestion into a real (unverified) clan on demand.
CREATE TABLE IF NOT EXISTS clan_suggestions (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    source        TEXT NOT NULL,          -- 'filianislost'
    external_id   TEXT NOT NULL,
    name          TEXT NOT NULL,
    display_name  TEXT,
    discord_id    TEXT,
    icon          TEXT,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
