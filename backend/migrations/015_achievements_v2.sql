-- 015: refresh / extend the achievements catalogue.
--
--   * `vai_secret` was a placeholder; rename it to `found_the_dev` so the
--     extension can trigger it explicitly when someone opens VAI's profile.
--   * Reseed text in case the prior insert ran with the older copy.
--   * Add new social/exploration ones the extension knows how to trigger.

-- ---- rename vai_secret -> found_the_dev (keeps any pre-granted unlocks) ----
INSERT INTO achievements (id, name, description, icon, category, points, secret)
VALUES (
    'found_the_dev',
    'Yes, you found the dev!',
    'You opened VAI''s profile. As a one-time prize you may DM @vai_prog on Discord to claim 0.5 paint can. Don''t waste it!',
    'sparkle',
    'easter',
    100,
    TRUE
)
ON CONFLICT (id) DO UPDATE
    SET name        = EXCLUDED.name,
        description = EXCLUDED.description,
        icon        = EXCLUDED.icon,
        category    = EXCLUDED.category,
        points      = EXCLUDED.points,
        secret      = EXCLUDED.secret;

-- Carry over any prior unlocks of the placeholder id onto the new one.
UPDATE user_achievements
   SET achievement_id = 'found_the_dev'
 WHERE achievement_id = 'vai_secret'
   AND NOT EXISTS (
       SELECT 1 FROM user_achievements ua2
        WHERE ua2.user_id = user_achievements.user_id
          AND ua2.achievement_id = 'found_the_dev'
   );
DELETE FROM user_achievements WHERE achievement_id = 'vai_secret';
DELETE FROM achievements      WHERE id             = 'vai_secret';

-- ---- new extension-flavoured achievements --------------------------------
INSERT INTO achievements (id, name, description, icon, category, points, secret) VALUES
    ('extension_installed', 'Welcome aboard',     'Connected the extension to the Wall Dev backend.',          'plug',     'general',  5,  FALSE),
    ('profile_complete',    'All filled in',      'Set a bio and at least one social link.',                   'user',     'general', 15,  FALSE),
    ('first_pinned',        'Curator',            'Pinned your first template to your profile.',               'pin',      'templates', 10, FALSE),
    ('emote_explorer',      'Speak in emote',     'Sent a message that used a 7TV emote.',                     'sparkle',  'social',   5,  FALSE),
    ('snapshot_viewer',     'Witness of the wall','Loaded a server-built wall snapshot.',                      'scan',     'general',  5,  FALSE),
    ('compact_mode_enabled','Pointillist',        'Switched the overlay to compact-marker mode.',              'grid',     'tools',    5,  FALSE),
    ('precise_place',       'Steady hand',        'Placed a pixel via Precise Place (Deep Integration).',      'bolt',     'tools',   10,  FALSE),
    ('grief_rescuer',       'Restorer',           'Resolved an anti-grief alert by repainting the diff.',      'shield',   'clan',    25,  FALSE),
    ('vai_pinged',          'Pinged the dev',     'DM''d @vai_prog on Discord. Pure friendly bonus, no claim.', 'discord',  'easter',  10,  TRUE),
    ('owner_blessed',       'Blessed by the boss','Received a hand-granted achievement from a Wall Dev admin.', 'crown',    'easter',  50,  TRUE)
ON CONFLICT (id) DO UPDATE
    SET name        = EXCLUDED.name,
        description = EXCLUDED.description,
        icon        = EXCLUDED.icon,
        category    = EXCLUDED.category,
        points      = EXCLUDED.points,
        secret      = EXCLUDED.secret;
