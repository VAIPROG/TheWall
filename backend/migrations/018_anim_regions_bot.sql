-- 018: animated-template configs, protected wall regions, bot admin registry.
--
-- anim_configs    — WallAnim v1 JSON configs uploaded from the extension.
--                   scope: private (owner only), clan (members of clan_id),
--                   public (everyone). The config column is the wall-anim/1
--                   document verbatim; the server treats it as opaque apart
--                   from size validation, so the format can evolve client-side.
--
-- protected_regions — "fix this wall state as stable" references. ref_png is
--                   a PNG data URL of the captured region (the clean tile
--                   composite, no watermark). The region guard loop re-reads
--                   the live tiles and flips last_ok when the broken-cell
--                   percentage exceeds tolerance_pct.
--
-- bot_admins      — Telegram/Discord principals allowed to run admin bot
--                   commands (/logs, /snapshot, …). Seeded from the
--                   TELEGRAM_ADMIN_IDS / DISCORD_ADMIN_IDS env on boot;
--                   rows added at runtime survive restarts.

CREATE TABLE IF NOT EXISTS anim_configs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clan_id     UUID REFERENCES clans(id) ON DELETE SET NULL,
    scope       TEXT NOT NULL DEFAULT 'private'
                CHECK (scope IN ('private', 'clan', 'public')),
    name        TEXT NOT NULL,
    config      JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anim_configs_user ON anim_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_anim_configs_clan ON anim_configs(clan_id) WHERE clan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_anim_configs_scope ON anim_configs(scope);

CREATE TABLE IF NOT EXISTS protected_regions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    clan_id         UUID REFERENCES clans(id) ON DELETE SET NULL,
    scope           TEXT NOT NULL DEFAULT 'private'
                    CHECK (scope IN ('private', 'clan', 'public')),
    name            TEXT NOT NULL,
    x               INT NOT NULL,
    y               INT NOT NULL,
    w               INT NOT NULL CHECK (w > 0),
    h               INT NOT NULL CHECK (h > 0),
    tolerance_pct   REAL NOT NULL DEFAULT 0,
    ref_png         TEXT NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    check_interval  INT NOT NULL DEFAULT 120,        -- seconds between guard passes
    last_checked_at TIMESTAMPTZ,
    last_broken_pct REAL NOT NULL DEFAULT 0,
    last_ok         BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS idx_protected_regions_user ON protected_regions(user_id);
CREATE INDEX IF NOT EXISTS idx_protected_regions_clan ON protected_regions(clan_id) WHERE clan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_protected_regions_enabled ON protected_regions(enabled) WHERE enabled;

CREATE TABLE IF NOT EXISTS bot_admins (
    platform     TEXT NOT NULL CHECK (platform IN ('telegram', 'discord')),
    external_id  TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, external_id)
);
