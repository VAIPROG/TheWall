-- 046_clan_media.sql
-- Managed clan avatar/banner uploads. The encoded image bytes (as data: URLs)
-- live here instead of bloating the frequently-listed `clans` row; the existing
-- `clans.avatar_url` / `clans.banner_url` columns stay as pointers to the
-- serving endpoint (or an external URL). A NULL pointer means "no custom media"
-- (never set, deleted, or moderation-locked) and the serving endpoint then
-- returns a generated fallback. Forward-only and idempotent.
CREATE TABLE IF NOT EXISTS clan_media (
    clan_id    UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('avatar', 'banner')),
    image      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (clan_id, kind)
);
