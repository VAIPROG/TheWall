-- 008: nicer signals (per-lang notes) + Discord/Telegram CDN URLs + batching.

-- Per-language admin notes pinned to a mirrored signal.
CREATE TABLE IF NOT EXISTS signal_notes (
    signal_id   UUID NOT NULL REFERENCES signals_cache(id) ON DELETE CASCADE,
    lang        TEXT NOT NULL,
    note        TEXT NOT NULL,
    author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (signal_id, lang)
);

-- Snapshot rows now also carry the *direct* CDN URLs for embedding the PNG.
-- The pre-existing `*_url` columns now hold the message URLs (Discord:
-- "go to message" link; Telegram: t.me/<chan>/<id>). The new `*_cdn_url`
-- columns hold the raw image URL we can show inline on the site.
ALTER TABLE wall_snapshots ADD COLUMN IF NOT EXISTS discord_cdn_url         TEXT;
ALTER TABLE wall_snapshots ADD COLUMN IF NOT EXISTS telegram_dm_cdn_url     TEXT;
ALTER TABLE wall_snapshots ADD COLUMN IF NOT EXISTS telegram_channel_cdn_url TEXT;
-- A batch groups the three sizes (small/medium/large) that ship together in
-- one Discord message / Telegram media group.
ALTER TABLE wall_snapshots ADD COLUMN IF NOT EXISTS batch_id UUID;
CREATE INDEX IF NOT EXISTS idx_snapshots_batch ON wall_snapshots(batch_id);
