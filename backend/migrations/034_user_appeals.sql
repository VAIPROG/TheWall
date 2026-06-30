-- V3 user appeals — banned users can submit an appeal to global moderators.

CREATE TABLE IF NOT EXISTS user_appeals (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason          TEXT NOT NULL,             -- user's explanation
    status          TEXT NOT NULL DEFAULT 'pending', -- pending | reviewing | granted | rejected
    moderator_notes TEXT,                      -- internal resolution notes
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_user_appeals_user ON user_appeals(user_id);
CREATE INDEX IF NOT EXISTS idx_user_appeals_status ON user_appeals(status) WHERE status = 'pending';

ALTER TABLE user_appeals
    ADD CONSTRAINT chk_user_appeals_status
    CHECK (status IN ('pending', 'reviewing', 'granted', 'rejected'));
