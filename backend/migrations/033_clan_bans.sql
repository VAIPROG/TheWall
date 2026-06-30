-- V3 clan bans — explicit membership-level ban for clan-scoped restrictions.
--
-- When a moderator creates a clan-scoped restriction with s_ban=TRUE, the
-- user is removed from the clan and a row is inserted here. The row is kept
-- in sync with the restriction lifecycle (removed when the restriction is
-- removed or the ban flag is cleared).

CREATE TABLE IF NOT EXISTS clan_bans (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id     UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    banned_by   UUID NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    reason      TEXT,
    banned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,                   -- mirrors restrictions.expires_at
    removed_at  TIMESTAMPTZ,
    removed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (clan_id, user_id) WHERE removed_at IS NULL
);

CREATE INDEX IF NOT EXISTS idx_clan_bans_user_clan ON clan_bans(user_id, clan_id);
CREATE INDEX IF NOT EXISTS idx_clan_bans_active ON clan_bans(clan_id, user_id) WHERE removed_at IS NULL;
