-- 007: server-side snapshots + signal mirror.

CREATE TABLE IF NOT EXISTS wall_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL DEFAULT 'filianislost',
    size            TEXT NOT NULL,           -- 'small' | 'medium' | 'large'
    bytes           BIGINT,
    width           INTEGER,
    height          INTEGER,
    -- Where we stashed the file. The DB never stores the bytes themselves.
    discord_url     TEXT,
    telegram_dm_url TEXT,
    telegram_channel_url TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_recent ON wall_snapshots(created_at DESC, size);

CREATE TABLE IF NOT EXISTS signals_cache (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL DEFAULT 'filianislost',
    -- Identifier the upstream signal carries (we use it for dedupe).
    external_id     TEXT,
    tag             TEXT,
    payload         JSONB NOT NULL,
    sampled_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_signals_recent ON signals_cache(sampled_at DESC);
