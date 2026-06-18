-- 021: OAuth sign-in on the landing + paint refill reminders.
--
-- oauth_states grows a `purpose`: 'link' rows attach a provider to an
-- existing signed-in account (user_id set), 'login' rows authenticate by
-- provider identity alone (user_id NULL until the exchange finds the match),
-- which is what lets someone open the landing cold and sign in with
-- Telegram/Discord.
--
-- paint_reminders backs the "ping me when my paint refills" service: the
-- extension files a row with a due time, the reminder worker sweeps every
-- ~10s and delivers to the user's linked Telegram/Discord DM.

ALTER TABLE oauth_states ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'link';
DO $$ BEGIN
    ALTER TABLE oauth_states
        ADD CONSTRAINT oauth_states_purpose_chk CHECK (purpose IN ('link', 'login'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS paint_reminders (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    due_at      TIMESTAMPTZ NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    -- 'auto' tries Telegram first, then Discord; or pin one explicitly.
    channel     TEXT NOT NULL DEFAULT 'auto'
                CHECK (channel IN ('auto', 'telegram', 'discord')),
    sent        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_paint_reminders_due ON paint_reminders(sent, due_at) WHERE NOT sent;
