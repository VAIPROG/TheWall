-- v2 schema: multi-site, two-axis roles, mailbox, rich profiles
-- Safe to re-run: every CREATE / ADD uses IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. multi-site: users can come from filianislost.com OR (in the future)
--    wplace.live. `source` identifies which game's identity each user maps to.
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'filianislost';
ALTER TABLE users ADD COLUMN IF NOT EXISTS global_role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telemetry_opt_in BOOLEAN NOT NULL DEFAULT FALSE;

-- Migrate the legacy `role` column → `global_role`.
-- 'admin'/'owner' carry over; everything else collapses to 'user'.
UPDATE users
   SET global_role = CASE
       WHEN role IN ('admin','owner') THEN role
       ELSE 'user'
   END
 WHERE global_role = 'user' AND role IS NOT NULL;

-- Force vai to owner (single operator) — idempotent.
UPDATE users SET global_role = 'owner' WHERE LOWER(username) = 'vai';

-- Old wall_id was UNIQUE; in the multi-site world we want (source, external_id) unique.
ALTER TABLE users RENAME COLUMN wall_id TO external_id;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_wall_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_source_external ON users(source, external_id);
CREATE INDEX IF NOT EXISTS idx_users_global_role ON users(global_role);

-- The legacy `role` column is left in place for v1 read-compat; v2 ignores it.

-- ============================================================================
-- 2. clans + memberships (many-to-many)
-- ============================================================================

CREATE TABLE IF NOT EXISTS clans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    name            TEXT NOT NULL,
    display_name    TEXT,
    discord_id      TEXT,
    icon            TEXT,
    stats           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_clans_name ON clans(name);

CREATE TABLE IF NOT EXISTS clan_memberships (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clan_id         UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    clan_role       TEXT NOT NULL DEFAULT 'member',  -- 'admin' | 'moderator' | 'member'
    active          BOOLEAN NOT NULL DEFAULT TRUE,
    joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, clan_id)
);
CREATE INDEX IF NOT EXISTS idx_clan_memberships_user ON clan_memberships(user_id, active);
CREATE INDEX IF NOT EXISTS idx_clan_memberships_clan ON clan_memberships(clan_id, active);
CREATE INDEX IF NOT EXISTS idx_clan_memberships_role ON clan_memberships(clan_id, clan_role) WHERE active;

-- ============================================================================
-- 3. mailbox — unified inbox for announcements / clan alerts / DMs / modmail /
--    template events. One table, polymorphic by `kind`.
-- ============================================================================

CREATE TABLE IF NOT EXISTS mailbox_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'announcement' (global from admin),
    -- 'clan_alert'   (clan_mod/admin → all clan members),
    -- 'clan_announcement' (clan_admin → pinned in clan),
    -- 'mod_alert'    (member → all mods of a clan),
    -- 'modmail'      (thread between member and clan mods),
    -- 'dm'           (1-to-1),
    -- 'template_event' (auto on approve/reject/report)
    kind                TEXT NOT NULL,
    sender_id           UUID REFERENCES users(id) ON DELETE SET NULL,
    -- One of these is set depending on kind:
    recipient_user_id   UUID REFERENCES users(id) ON DELETE CASCADE,
    recipient_clan_id   UUID REFERENCES clans(id) ON DELETE CASCADE,
    -- Thread root (NULL on the first message). modmail / dm use this for replies.
    thread_id           UUID REFERENCES mailbox_items(id) ON DELETE CASCADE,
    title               TEXT,
    body                TEXT NOT NULL DEFAULT '',
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Only meaningful for kinds that target a single user (dm, template_event, modmail reply).
    read_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mailbox_user ON mailbox_items(recipient_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_clan ON mailbox_items(recipient_clan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mailbox_thread ON mailbox_items(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mailbox_kind ON mailbox_items(kind);

-- For broadcast kinds (announcement / clan_alert) we track "read" per-user
-- separately because a single item belongs to many people.
CREATE TABLE IF NOT EXISTS mailbox_reads (
    item_id     UUID NOT NULL REFERENCES mailbox_items(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (item_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_mailbox_reads_user ON mailbox_reads(user_id);

-- ============================================================================
-- 4. modmail threads — surface a per-clan list of open conversations to mods.
-- ============================================================================

CREATE TABLE IF NOT EXISTS clan_modmail_threads (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id         UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    opener_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_modmail_clan ON clan_modmail_threads(clan_id, status, last_activity DESC);

-- ============================================================================
-- 5. profile extras
-- ============================================================================

CREATE TABLE IF NOT EXISTS pinned_templates (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    template_id UUID NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    slot        INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
    pinned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, slot),
    UNIQUE (user_id, template_id)
);

CREATE TABLE IF NOT EXISTS user_stats (
    user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    pixels_placed       BIGINT NOT NULL DEFAULT 0,
    templates_approved  INTEGER NOT NULL DEFAULT 0,
    last_pushed         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- 6. telemetry / error reports / audit log
-- ============================================================================

CREATE TABLE IF NOT EXISTS telemetry_events (
    day             DATE NOT NULL,
    event_type      TEXT NOT NULL,
    ext_version     TEXT NOT NULL,
    lang            TEXT NOT NULL DEFAULT 'en',
    source          TEXT NOT NULL DEFAULT 'filianislost',
    count           BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (day, event_type, ext_version, lang, source)
);

CREATE TABLE IF NOT EXISTS error_reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    ext_version         TEXT,
    source              TEXT,
    redacted_payload    TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ttl_at              TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '90 days'
);
CREATE INDEX IF NOT EXISTS idx_error_reports_ttl ON error_reports(ttl_at);

CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   UUID,
    payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id, created_at DESC);

-- ============================================================================
-- 7. templates: add 'rejected' status (was 'pending'/'approved' before)
--    This is purely additive — existing rows keep their values.
-- ============================================================================

-- Optional helpful index for the v2 list endpoint's WHERE scope = ? AND status = ?
CREATE INDEX IF NOT EXISTS idx_templates_scope_status ON templates(scope, status, created_at DESC);
