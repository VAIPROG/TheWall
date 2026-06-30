-- 026: V3 server-config flags (server_config is a key/value text store).
--   allow_public_template_publishing — when 'false', only global admin+ may
--     publish public-scope templates (default 'true' = anyone may).
--   auto_approve_moderator_templates — when 'true', a moderator+ at the
--     template's scope publishes as 'approved' instead of 'pending'.
-- Also bump the advertised extension version target to V3.
--
-- Forward-only and idempotent.

INSERT INTO server_config (key, value) VALUES
    ('allow_public_template_publishing', 'true'),
    ('auto_approve_moderator_templates', 'true')
ON CONFLICT (key) DO NOTHING;

UPDATE server_config SET value = '6.0.0', updated_at = NOW()
 WHERE key = 'extension_version' AND value <> '6.0.0';
