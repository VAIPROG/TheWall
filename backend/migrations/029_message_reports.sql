-- 029: message reports — users flag chat messages for moderator review.
-- Forward-only, idempotent.

CREATE TABLE IF NOT EXISTS message_reports (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id   UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chat_id      UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    reporter_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    reason       TEXT NOT NULL,
    evidence     TEXT,
    status       TEXT NOT NULL DEFAULT 'open',   -- open | reviewed | dismissed | actioned
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_message_reports_status  ON message_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_reports_message ON message_reports (message_id);
