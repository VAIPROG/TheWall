-- 009: simplify snapshot URL columns.
--
-- New shape (matches reality):
--   discord_url   — direct cdn.discordapp.com attachment URL (clickable PNG)
--   telegram_url  — public Telegram channel post URL (t.me/<channel>/<msg_id>)
--
-- DM is still sent as an out-of-band notification but isn't persisted.
-- The split `*_cdn_url` columns are gone — for Discord the original URL IS
-- the CDN URL; for Telegram we don't try to resolve attachment CDN.

ALTER TABLE wall_snapshots DROP COLUMN IF EXISTS discord_cdn_url;
ALTER TABLE wall_snapshots DROP COLUMN IF EXISTS telegram_dm_url;
ALTER TABLE wall_snapshots DROP COLUMN IF EXISTS telegram_dm_cdn_url;
ALTER TABLE wall_snapshots DROP COLUMN IF EXISTS telegram_channel_cdn_url;

-- Rename for clarity; the channel URL is the only Telegram link we care about.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'wall_snapshots' AND column_name = 'telegram_channel_url'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'wall_snapshots' AND column_name = 'telegram_url'
  ) THEN
    ALTER TABLE wall_snapshots RENAME COLUMN telegram_channel_url TO telegram_url;
  END IF;
END $$;
