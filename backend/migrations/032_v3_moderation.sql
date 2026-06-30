-- 032: V3 moderation subsystem — unified reports, granular restrictions
-- (sanctions), and a moderation audit log. Forward-only, idempotent.
--
-- The earlier message_reports (029) and clan_reports (031) tables were
-- unshipped stubs; they are folded into one polymorphic `reports` table so the
-- moderation queue sees every report type in one place.

DROP TABLE IF EXISTS message_reports;
DROP TABLE IF EXISTS clan_reports;

-- ---- Unified reports ------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type            TEXT NOT NULL,              -- template | message | user | clan
    target_id       TEXT NOT NULL,              -- id of the reported entity (uuid as text)
    clan_id         UUID REFERENCES clans(id) ON DELETE SET NULL,  -- context clan, when relevant
    reporter_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    reason          TEXT NOT NULL,
    evidence        TEXT,
    status          TEXT NOT NULL DEFAULT 'open',  -- open | reviewing | resolved | dismissed
    assigned_mod_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resolution      TEXT,                       -- content_removed | no_action_needed | user_warned | user_restricted | other
    notes           TEXT,                       -- internal moderator notes
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_type   ON reports (type, status);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (type, target_id);

-- ---- Restrictions (granular sanctions) ------------------------------------
CREATE TABLE IF NOT EXISTS restrictions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope               TEXT NOT NULL,          -- global | clan
    clan_id             UUID REFERENCES clans(id) ON DELETE CASCADE,  -- required when scope='clan'
    applied_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    applied_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ,            -- NULL = permanent
    reason              TEXT,
    s_mute              BOOLEAN NOT NULL DEFAULT FALSE,  -- block chat messages
    s_ban               BOOLEAN NOT NULL DEFAULT FALSE,  -- block platform access
    s_publish_templates BOOLEAN NOT NULL DEFAULT FALSE,  -- block template create/publish
    s_invite_to_clan    BOOLEAN NOT NULL DEFAULT FALSE,  -- block clan invites
    s_send_reports      BOOLEAN NOT NULL DEFAULT FALSE,  -- block submitting reports
    s_send_modmail      BOOLEAN NOT NULL DEFAULT FALSE,  -- block modmail
    removed_at          TIMESTAMPTZ,            -- soft-remove (history kept for audit)
    removed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Active = not removed and not expired. This index serves the hot enforcement
-- lookup "all live restrictions for a user".
CREATE INDEX IF NOT EXISTS idx_restrictions_active
    ON restrictions (user_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_restrictions_scope ON restrictions (scope, clan_id);

-- ---- Moderation audit log -------------------------------------------------
CREATE TABLE IF NOT EXISTS mod_audit_log (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    moderator_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,    -- restriction_created | restriction_updated | restriction_removed
                                    -- | report_resolved | report_dismissed | clan_takedown | clan_unlock
                                    -- | template_approved | template_rejected
    target_type   TEXT NOT NULL,    -- user | clan | template | message | report | restriction
    target_id     TEXT NOT NULL,
    details       JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mod_audit_created ON mod_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mod_audit_mod     ON mod_audit_log (moderator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mod_audit_target  ON mod_audit_log (target_type, target_id);
