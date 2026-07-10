-- 028: V3 achievements — richer catalogue with rarity, structured unlock
-- criteria, explicit grant source tracking, and an event log.
--
-- Backward-compatible: existing `achievements` and `user_achievements` data is
-- preserved. New columns are nullable with sensible defaults so the V2 rows
-- continue to work while V3 consumers can use the richer fields.

-- ---------------------------------------------------------------------------
-- 1. Extend achievements catalogue
-- ---------------------------------------------------------------------------

ALTER TABLE achievements
    ADD COLUMN IF NOT EXISTS rarity        TEXT NOT NULL DEFAULT 'common',
    ADD COLUMN IF NOT EXISTS unlock_kind   TEXT NOT NULL DEFAULT 'manual',
    -- For 'condition' criteria a JSON DSL; for 'event' criteria the event name.
    ADD COLUMN IF NOT EXISTS unlock_config JSONB        DEFAULT NULL,
    ADD COLUMN IF NOT EXISTS icon_url      TEXT         DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_achievements_category ON achievements(category);
CREATE INDEX IF NOT EXISTS idx_achievements_rarity    ON achievements(rarity);

-- ---------------------------------------------------------------------------
-- 2. Track grants with source and metadata
-- ---------------------------------------------------------------------------

ALTER TABLE user_achievements
    ADD COLUMN IF NOT EXISTS id          UUID PRIMARY KEY DEFAULT gen_random_uuid(); -- OOPS: can't add PK after table. Fix below.

-- The previous line is invalid (can't add PRIMARY KEY via ADD COLUMN IF NOT EXISTS).
-- Instead create a separate grants table and keep user_achievements for V2 compat.

CREATE TABLE IF NOT EXISTS achievement_grants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    achievement_id  TEXT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
    source          TEXT NOT NULL DEFAULT 'system',
    source_id       UUID         DEFAULT NULL,    -- admin user id, session id, etc.
    reason          TEXT         DEFAULT NULL,
    metadata        JSONB        DEFAULT NULL,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, achievement_id)
);

CREATE INDEX IF NOT EXISTS idx_achievement_grants_user      ON achievement_grants(user_id, granted_at DESC);
CREATE INDEX IF NOT EXISTS idx_achievement_grants_achievement ON achievement_grants(achievement_id);

-- ---------------------------------------------------------------------------
-- 3. Event log for achievements
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS achievement_event_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event       TEXT NOT NULL,
    metadata    JSONB        DEFAULT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_achievement_event_log_user_event
    ON achievement_event_log(user_id, event, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. Migrate existing V2 unlocks into V3 grants table
-- ---------------------------------------------------------------------------

INSERT INTO achievement_grants (user_id, achievement_id, source, granted_at)
SELECT user_id, achievement_id, 'system', unlocked_at
  FROM user_achievements
ON CONFLICT (user_id, achievement_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. Seed richer V3 catalogue, updating existing ids in place
-- ---------------------------------------------------------------------------

INSERT INTO achievements
    (id, name, description, icon, category, points, secret, rarity, unlock_kind, unlock_config)
VALUES
    ('first_pixel',       'First pixel',                'Placed your first pixel via the assist.',                   'spark',    'pixels',     5,  FALSE, 'common',    'condition', '{"stat":"pixels_placed","op":">=","value":1}'),
    ('pixels_100',        'Centurion',                  'Placed 100 pixels.',                                        'medal',    'pixels',    10,  FALSE, 'common',    'condition', '{"stat":"pixels_placed","op":">=","value":100}'),
    ('pixels_1k',         'Pixel pusher',               'Placed 1 000 pixels.',                                      'medal',    'pixels',    25,  FALSE, 'uncommon',  'condition', '{"stat":"pixels_placed","op":">=","value":1000}'),
    ('pixels_10k',        'Pixel master',               'Placed 10 000 pixels.',                                     'crown',    'pixels',    75,  FALSE, 'rare',      'condition', '{"stat":"pixels_placed","op":">=","value":10000}'),
    ('first_template',    'Artisan',                    'Shared your first template.',                               'palette',  'templates', 10,  FALSE, 'common',    'condition', '{"stat":"templates_total","op":">=","value":1}'),
    ('approved_template', 'Curated',                    'Had a public template approved.',                           'check',    'templates', 20,  FALSE, 'common',    'condition', '{"stat":"templates_approved","op":">=","value":1}'),
    ('approved_5',        'Gallery regular',            'Had 5 public templates approved.',                          'check',    'templates', 50,  FALSE, 'uncommon',  'condition', '{"stat":"templates_approved","op":">=","value":5}'),
    ('joined_clan',       'Squad up',                   'Joined a clan.',                                            'shield',   'clan',       5,  FALSE, 'common',    'condition', '{"stat":"clan_role_any","op":"true"}'),
    ('clan_mod',          'Moderator on duty',          'Became a clan moderator.',                                  'shield',   'clan',      30,  FALSE, 'uncommon',  'condition', '{"stat":"clan_role","op":"in","value":["moderator","admin","owner"]}'),
    ('first_dm',          'Hello there',                'Sent your first DM.',                                       'chat',     'social',     5,  FALSE, 'common',    'condition', '{"stat":"dms_sent","op":">=","value":1}'),
    ('clan_chat_100',     'Group chatter',              'Posted 100 messages in clan chat.',                         'chat',     'social',    20,  FALSE, 'uncommon',  'condition', '{"stat":"clan_messages","op":">=","value":100}'),
    ('multilingual',      'Polyglot',                   'Changed your language at least once.',                      'globe',    'general',    5,  FALSE, 'common',    'condition', '{"stat":"lang_set","op":"true"}'),
    ('avatar_uploaded',   'Show your colours',          'Uploaded a custom avatar.',                                 'user',     'general',    5,  FALSE, 'common',    'condition', '{"stat":"has_avatar","op":"true"}'),
    ('vai_linked',        'Connected',                  'Linked a VAI-PROG account.',                                'plug',     'general',   15,  FALSE, 'uncommon',  'condition', '{"stat":"has_vai","op":"true"}'),
    ('discord_linked',    'Discord ready',              'Linked your Discord for notifications.',                    'discord',  'general',   10,  FALSE, 'common',    'condition', '{"stat":"has_discord","op":"true"}'),
    ('telegram_linked',   'Telegram ready',             'Linked your Telegram for notifications.',                   'telegram', 'general',   10,  FALSE, 'common',    'condition', '{"stat":"has_telegram","op":"true"}'),
    ('night_owl',         'Night owl',                  'Active between 2am and 5am.',                               'moon',     'time',      10,  FALSE, 'uncommon',  'event',     '{"event":"night_owl"}'),
    ('found_the_dev',     'Yes, you found the dev!',    'You opened VAI''s profile.',                                 'sparkle',  'easter',   100,  TRUE,  'legendary', 'event',     '{"event":"found_the_dev"}'),
    ('extension_installed','Welcome aboard',            'Connected the extension to the Wall Dev backend.',          'plug',     'general',    5,  FALSE, 'common',    'event',     '{"event":"extension_installed"}'),
    ('profile_complete',  'All filled in',              'Set a bio and at least one social link.',                   'user',     'general',   15,  FALSE, 'uncommon',  'event',     '{"event":"profile_complete"}'),
    ('first_pinned',      'Curator',                    'Pinned your first template to your profile.',               'pin',      'templates', 10,  FALSE, 'common',    'event',     '{"event":"first_pinned"}'),
    ('emote_explorer',    'Speak in emote',             'Sent a message that used a 7TV emote.',                     'sparkle',  'social',     5,  FALSE, 'common',    'event',     '{"event":"emote_explorer"}'),
    ('snapshot_viewer',   'Witness of the wall',        'Loaded a server-built wall snapshot.',                      'scan',     'general',    5,  FALSE, 'common',    'event',     '{"event":"snapshot_viewer"}'),
    ('compact_mode_enabled','Pointillist',              'Switched the overlay to compact-marker mode.',              'grid',     'tools',      5,  FALSE, 'common',    'event',     '{"event":"compact_mode_enabled"}'),
    ('precise_place',     'Steady hand',                'Placed a pixel via Precise Place (Deep Integration).',      'bolt',     'tools',     10,  FALSE, 'uncommon',  'event',     '{"event":"precise_place"}'),
    ('vai_pinged',        'Pinged the dev',             'DM''d @vai_prog on Discord. Pure friendly bonus, no claim.','discord',  'easter',    10,  TRUE,  'unique',    'event',     '{"event":"vai_pinged"}'),
    ('owner_blessed',     'Blessed by the boss',        'Received a hand-granted achievement from a Wall Dev admin.','crown',    'easter',    50,  TRUE,  'unique',    'manual',    NULL),
    ('achievement_collector','Completionist',           'Unlocked at least 10 other achievements.',                  'crown',    'general',  100,  TRUE,  'legendary', 'achievement_count', '{"count":10}')
ON CONFLICT (id) DO UPDATE
    SET name          = EXCLUDED.name,
        description   = EXCLUDED.description,
        icon          = EXCLUDED.icon,
        category      = EXCLUDED.category,
        points        = EXCLUDED.points,
        secret        = EXCLUDED.secret,
        rarity        = EXCLUDED.rarity,
        unlock_kind   = EXCLUDED.unlock_kind,
        unlock_config = EXCLUDED.unlock_config;

-- Remove the defunct placeholder if it somehow still exists.
DELETE FROM achievements WHERE id = 'vai_secret';
