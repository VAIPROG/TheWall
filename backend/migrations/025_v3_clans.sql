-- 025: V3 clans — native presentation, governance, and global-moderation locks
-- on top of the site-mirrored clan rows (003 created clans as mirrors keyed by
-- (source, external_id)). These columns let clan owners manage presentation and
-- let GLOBAL moderators strip + LOCK fields (avatar/banner/description/tag/
-- discoverable) so clan-level roles can't restore them.
--
-- Forward-only and idempotent.

ALTER TABLE clans ADD COLUMN IF NOT EXISTS avatar_url   TEXT;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS banner_url   TEXT;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS description  TEXT;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS tag          TEXT;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS verified     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS discoverable BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS lang         TEXT;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS max_members  INTEGER;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS owner_id     UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE clans ADD COLUMN IF NOT EXISTS join_policy  TEXT NOT NULL DEFAULT 'invite_only';
ALTER TABLE clans ADD COLUMN IF NOT EXISTS settings     JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Global-moderation field locks:
--   { "lockedFields": ["avatar","banner","description","tag","discoverable"],
--     "lockedBy": "<account uuid>", "lockedAt": "<ts>", "reason": "<text>" }
-- A clan-level role's update to any listed field is rejected with 423 Locked;
-- only a global moderator+ can unlock.
ALTER TABLE clans ADD COLUMN IF NOT EXISTS moderation   JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Clan tags are unique (case-insensitive) when set.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clans_tag ON clans(LOWER(tag)) WHERE tag IS NOT NULL;

-- Discoverable clan lookups.
CREATE INDEX IF NOT EXISTS idx_clans_discoverable ON clans(discoverable) WHERE discoverable;

-- Best-effort owner backfill: the active top-role ('admin') member of each clan.
-- (clan_memberships.clan_role ∈ admin|moderator|member; the clan 'owner' concept
-- is new — map from the highest existing role.)
UPDATE clans c
   SET owner_id = m.user_id
  FROM clan_memberships m
 WHERE m.clan_id = c.id
   AND m.active
   AND m.clan_role = 'admin'
   AND c.owner_id IS NULL;
