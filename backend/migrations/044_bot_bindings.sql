-- 044_bot_bindings.sql
CREATE TABLE IF NOT EXISTS clan_bindings (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clan_id      UUID NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
    platform     TEXT NOT NULL,           -- 'discord' | 'telegram'
    chat_id      TEXT NOT NULL,
    verified_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    verified_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (platform, chat_id)
);
CREATE TABLE IF NOT EXISTS bot_subscriptions (
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform  TEXT NOT NULL,
    chat_id   TEXT NOT NULL,
    kind      TEXT NOT NULL,              -- 'paint' | 'region'
    PRIMARY KEY (user_id, platform, kind)
);
