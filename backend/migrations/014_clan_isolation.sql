-- 014: SECURITY — clan_messages and templates had no clan_id, so the v1
-- clan-chat / clan-templates routes leaked every clan's data to every
-- authenticated user regardless of their actual membership.
--
-- This migration:
--   1. Adds clan_id to both tables (nullable so the migration can roll out
--      while in-flight queries are still finishing).
--   2. Back-fills clan_id using the author's first active clan membership.
--      Rows whose author has no active membership are left NULL — the route
--      filters treat NULL as "not visible to anyone".
--   3. Creates indexes for the (clan_id, created_at) lookup pattern.

-- ---- clan_messages -------------------------------------------------------
ALTER TABLE clan_messages
    ADD COLUMN IF NOT EXISTS clan_id UUID REFERENCES clans(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_clan_messages_clan_id
    ON clan_messages (clan_id, created_at DESC);

UPDATE clan_messages cm
   SET clan_id = sub.clan_id
  FROM (
      SELECT DISTINCT ON (m.user_id) m.user_id, m.clan_id
        FROM clan_memberships m
       WHERE m.active = true
       ORDER BY m.user_id, m.joined_at ASC
  ) sub
 WHERE cm.user_id = sub.user_id
   AND cm.clan_id IS NULL;

-- ---- templates -----------------------------------------------------------
ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS clan_id UUID REFERENCES clans(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_templates_clan_id
    ON templates (clan_id) WHERE clan_id IS NOT NULL;

-- Backfill only scope='clan' rows; public templates don't need a clan owner.
UPDATE templates t
   SET clan_id = sub.clan_id
  FROM (
      SELECT DISTINCT ON (m.user_id) m.user_id, m.clan_id
        FROM clan_memberships m
       WHERE m.active = true
       ORDER BY m.user_id, m.joined_at ASC
  ) sub
 WHERE t.user_id = sub.user_id
   AND t.scope = 'clan'
   AND t.clan_id IS NULL;
