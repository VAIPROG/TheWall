-- 030: V3 clan join flows — invites, join applications, staff-role applications.
-- Forward-only, idempotent.

-- ---- Invites --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clan_invites (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id        UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    code           TEXT NOT NULL UNIQUE,
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,  -- direct invite (optional)
    max_uses       INTEGER,                                       -- NULL = unlimited
    use_count      INTEGER NOT NULL DEFAULT 0,
    expires_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clan_invites_clan ON clan_invites (clan_id);
CREATE INDEX IF NOT EXISTS idx_clan_invites_target
    ON clan_invites (target_user_id) WHERE target_user_id IS NOT NULL;

-- ---- Join applications (approval_required clans) --------------------------
CREATE TABLE IF NOT EXISTS clan_join_applications (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id       UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    applicant_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message       TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMPTZ
);
-- At most one pending application per (clan, applicant).
CREATE UNIQUE INDEX IF NOT EXISTS idx_clan_join_app_pending
    ON clan_join_applications (clan_id, applicant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_clan_join_app_clan
    ON clan_join_applications (clan_id, status);

-- ---- Staff-role applications (apply for admin / moderator) ----------------
CREATE TABLE IF NOT EXISTS clan_role_applications (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id        UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    applicant_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    requested_role TEXT NOT NULL,                     -- admin | moderator
    message        TEXT,
    status         TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at    TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_clan_role_app_pending
    ON clan_role_applications (clan_id, applicant_id, requested_role) WHERE status = 'pending';
