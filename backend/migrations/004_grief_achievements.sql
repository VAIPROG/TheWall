-- 004: anti-grief, achievements, notification prefs, VAI Account stub.
-- All adds are guarded with IF NOT EXISTS for safe re-runs.

-- ============================================================================
-- 1. Anti-grief: pin templates for monitoring.
-- ============================================================================

CREATE TABLE IF NOT EXISTS protected_templates (
    template_id     UUID PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
    clan_id         UUID REFERENCES clans(id) ON DELETE CASCADE,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    -- Damage threshold (pixels diverged from template) before we alert.
    -- 0 = alert on any change. We default to a tiny bit of grace to absorb
    -- legitimate touch-ups by clanmates.
    alert_threshold INTEGER NOT NULL DEFAULT 25,
    -- How often, in seconds, to recheck. Capped server-side.
    check_interval  INTEGER NOT NULL DEFAULT 600,
    last_checked_at TIMESTAMPTZ,
    last_damage     INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_protected_due ON protected_templates(enabled, last_checked_at);

-- Historical samples — useful for "damage trend" + dashboards.
CREATE TABLE IF NOT EXISTS protected_template_samples (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id     UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    damage          INTEGER NOT NULL,
    sampled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pt_samples_template ON protected_template_samples(template_id, sampled_at DESC);

-- ============================================================================
-- 2. Achievements
-- ============================================================================

-- Catalogue: editable from migrations / admin tools.
CREATE TABLE IF NOT EXISTS achievements (
    id          TEXT PRIMARY KEY,                 -- 'first_pixel', 'mod_apprentice', ...
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT 'star',     -- icon key our UI maps to an SVG
    category    TEXT NOT NULL DEFAULT 'general',  -- 'pixels'|'templates'|'social'|'clan'|'time'|'general'
    points      INTEGER NOT NULL DEFAULT 10,
    secret      BOOLEAN NOT NULL DEFAULT FALSE    -- hidden until unlocked
);

CREATE TABLE IF NOT EXISTS user_achievements (
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id  TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    unlocked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_user_ach_user ON user_achievements(user_id, unlocked_at DESC);

-- Seed the catalogue. ON CONFLICT keeps re-runs idempotent.
INSERT INTO achievements (id, name, description, icon, category, points) VALUES
    ('first_pixel',       'First pixel',                'Placed your first pixel via the assist.',     'spark',    'pixels',    5),
    ('pixels_100',        'Centurion',                  'Placed 100 pixels.',                          'medal',    'pixels',   10),
    ('pixels_1k',         'Pixel pusher',               'Placed 1 000 pixels.',                        'medal',    'pixels',   25),
    ('pixels_10k',        'Pixel master',               'Placed 10 000 pixels.',                       'crown',    'pixels',   75),
    ('first_template',    'Artisan',                    'Shared your first template.',                 'palette',  'templates', 10),
    ('approved_template', 'Curated',                    'Had a public template approved.',             'check',    'templates', 20),
    ('approved_5',        'Gallery regular',            'Had 5 public templates approved.',            'check',    'templates', 50),
    ('joined_clan',       'Squad up',                   'Joined a clan.',                              'shield',   'clan',      5),
    ('clan_mod',          'Moderator on duty',          'Became a clan moderator.',                    'shield',   'clan',     30),
    ('first_dm',          'Hello there',                'Sent your first DM.',                         'chat',     'social',    5),
    ('clan_chat_100',     'Group chatter',              'Posted 100 messages in clan chat.',           'chat',     'social',   20),
    ('protector',         'Guardian',                   'Protected a template from grief.',            'shield',   'clan',     30),
    ('grief_witnessed',   'Witness',                    'Received your first anti-grief alert.',       'bell',     'clan',      5),
    ('multilingual',      'Polyglot',                   'Changed your language at least once.',        'globe',    'general',   5),
    ('avatar_uploaded',   'Show your colours',          'Uploaded a custom avatar.',                   'user',     'general',   5),
    ('vai_linked',        'Connected',                  'Linked a VAI-PROG account.',                  'plug',     'general',  15),
    ('discord_linked',    'Discord ready',              'Linked your Discord for notifications.',      'discord',  'general',  10),
    ('telegram_linked',   'Telegram ready',             'Linked your Telegram for notifications.',     'telegram', 'general',  10),
    ('night_owl',         'Night owl',                  'Active between 2am and 5am.',                 'moon',     'time',     10),
    ('vai_secret',        '???',                        'Hidden achievement — keep exploring.',        'sparkle',  'general',  50)
ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        icon = EXCLUDED.icon,
        category = EXCLUDED.category,
        points = EXCLUDED.points;

UPDATE achievements SET secret = TRUE WHERE id = 'vai_secret';

-- ============================================================================
-- 3. Notification preferences — per-user, per-kind, per-channel.
--    channels: in_app | os_push | email | discord | telegram
-- ============================================================================

CREATE TABLE IF NOT EXISTS notification_prefs (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    channels    TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, kind)
);

-- ============================================================================
-- 4. Discord / Telegram linking (storage stub for now)
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_user_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notifications_email TEXT;

-- ============================================================================
-- 5. VAI Account System — stub.
--    A standalone identity (email + password) that will, eventually, become
--    the single sign-on across all VAI-PROG services. For The Wall it links
--    to a `users` row, so the same person can sign in via filianislost OR
--    via their VAI account and reach the same data.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vai_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT,                         -- display-cased original
    email_lc        TEXT NOT NULL UNIQUE,         -- lowercased lookup key
    password_hash   TEXT NOT NULL,
    display_name    TEXT,
    avatar_url      TEXT,
    verified        BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- citext may not exist on every box; skip gracefully.
-- (Previously attempted to enable the citext extension; removed because it
-- requires superuser privileges that the app's DB role usually doesn't have.
-- We use lowercased TEXT + UNIQUE on email_lc instead, which is portable and
-- equally performant for the look-ups we do.)

-- Link a VAI account to one or more service users.
CREATE TABLE IF NOT EXISTS vai_links (
    vai_account_id  UUID NOT NULL REFERENCES vai_accounts(id) ON DELETE CASCADE,
    service         TEXT NOT NULL,                -- 'the-wall' | future services
    -- Wall-side user row.
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vai_account_id, service, user_id)
);
CREATE INDEX IF NOT EXISTS idx_vai_links_user ON vai_links(user_id);

-- Add convenience back-reference on users.
ALTER TABLE users ADD COLUMN IF NOT EXISTS vai_account_id UUID REFERENCES vai_accounts(id) ON DELETE SET NULL;
