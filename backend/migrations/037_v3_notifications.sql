-- 037: V3 notifications — richer payload, action URL, metadata, dismissal, and settings.

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS type        TEXT NOT NULL DEFAULT 'system_announcement',
    ADD COLUMN IF NOT EXISTS action_url  TEXT,
    ADD COLUMN IF NOT EXISTS metadata    JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_type ON notifications(type);

CREATE TABLE IF NOT EXISTS notification_settings (
    user_id                   UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled              BOOLEAN NOT NULL DEFAULT FALSE,
    template_status_changes   BOOLEAN NOT NULL DEFAULT TRUE,
    clan_invites              BOOLEAN NOT NULL DEFAULT TRUE,
    restriction_updates       BOOLEAN NOT NULL DEFAULT TRUE,
    mod_actions               BOOLEAN NOT NULL DEFAULT TRUE,
    system_announcements      BOOLEAN NOT NULL DEFAULT TRUE,
    news_announcements        BOOLEAN NOT NULL DEFAULT TRUE,
    mentions                  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO notification_settings (user_id)
SELECT id FROM users
ON CONFLICT (user_id) DO NOTHING;
