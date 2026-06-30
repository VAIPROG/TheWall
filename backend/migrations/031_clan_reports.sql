-- 031: clan reports — users flag a clan for global-moderator review.
-- Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS clan_reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id      UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    reporter_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    reason       TEXT NOT NULL,
    evidence     TEXT,
    status       TEXT NOT NULL DEFAULT 'open',   -- open | reviewed | dismissed | actioned
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_clan_reports_status ON clan_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clan_reports_clan   ON clan_reports (clan_id);
