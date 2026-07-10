-- 042: unified V3 feed.
-- (Was mis-numbered 029 — collided with 029_message_reports and never applied,
--  so `feed_events` was missing on prod; renumbered to a unique trailing
--  version. Idempotent: IF NOT EXISTS + ON CONFLICT DO NOTHING throughout.)
--
-- Replaces the split `wall_snapshots` + `signals_cache` tables with a single
-- `feed_events` stream. Every entry has a uniform shape:
--   event_type  — 'snapshot', 'signal', 'announcement', 'milestone', ...
--   source      — who produced the event ('filianislost', 'system', ...)
--   external_id — stable id used for deduplication
--   title / description / payload / media — rendered by the frontend based on type
--   occurred_at — wall-clock time the event happened
--
-- Legacy V2 read endpoints are rewritten to project rows from this table so
-- existing clients keep working without knowing the new schema.

BEGIN;

CREATE TABLE IF NOT EXISTS feed_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type    TEXT NOT NULL,
    source        TEXT NOT NULL DEFAULT 'system',
    external_id   TEXT NOT NULL,
    title         TEXT,
    description   TEXT,
    payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
    media         JSONB NOT NULL DEFAULT '[]'::jsonb,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_events_recent ON feed_events(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_feed_events_type   ON feed_events(event_type);
CREATE INDEX IF NOT EXISTS idx_feed_events_source ON feed_events(source, external_id);

-- Per-language admin notes pinned to a feed event (replaces signal_notes).
CREATE TABLE IF NOT EXISTS feed_event_notes (
    event_id    UUID NOT NULL REFERENCES feed_events(id) ON DELETE CASCADE,
    lang        TEXT NOT NULL,
    note        TEXT NOT NULL,
    author_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (event_id, lang)
);

-- ---------------------------------------------------------------------------
-- Migrate snapshots: group rows by batch_id into one 'snapshot' event.
-- ---------------------------------------------------------------------------
INSERT INTO feed_events (event_type, source, external_id, title, description, payload, media, occurred_at, created_at)
SELECT
    'snapshot' AS event_type,
    'filianislost' AS source,
    COALESCE(batch_id::text, id::text) AS external_id,
    NULL AS title,
    NULL AS description,
    jsonb_build_object(
        'batchId', batch_id,
        'sizes', jsonb_object_agg(
            size,
            jsonb_build_object(
                'bytes', bytes,
                'width', width,
                'height', height,
                'discordUrl', discord_url,
                'telegramUrl', telegram_url
            )
        )
    ) AS payload,
    COALESCE(jsonb_agg(
        jsonb_build_object(
            'type', 'image',
            'url', COALESCE(discord_url, telegram_url),
            'label', size
        ) ORDER BY size
    ) FILTER (WHERE discord_url IS NOT NULL OR telegram_url IS NOT NULL), '[]'::jsonb) AS media,
    MAX(created_at) AS occurred_at,
    MIN(created_at) AS created_at
FROM wall_snapshots
GROUP BY batch_id, id
ON CONFLICT (source, external_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Migrate signals: one 'signal' event per cached signal.
-- ---------------------------------------------------------------------------
INSERT INTO feed_events (event_type, source, external_id, title, description, payload, media, occurred_at, created_at)
SELECT
    'signal' AS event_type,
    'filianislost' AS source,
    external_id,
    payload->>'name' AS title,
    payload->>'location' AS description,
    payload AS payload,
    CASE
        WHEN payload->>'image_file' IS NOT NULL THEN
            jsonb_build_array(
                jsonb_build_object(
                    'type', 'image',
                    'url', 'https://signal.filianislost.com/static/uploads/' || (payload->>'image_file')
                )
            )
        ELSE '[]'::jsonb
    END AS media,
    sampled_at AS occurred_at,
    sampled_at AS created_at
FROM signals_cache
ON CONFLICT (source, external_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Migrate signal notes to the new feed_event_notes table.
-- ---------------------------------------------------------------------------
INSERT INTO feed_event_notes (event_id, lang, note, author_id, updated_at)
SELECT fe.id, sn.lang, sn.note, sn.author_id, sn.updated_at
FROM signal_notes sn
JOIN feed_events fe
  ON fe.source = 'filianislost'
 AND fe.event_type = 'signal'
 AND fe.external_id = (
     SELECT external_id FROM signals_cache sc WHERE sc.id = sn.signal_id
 )
ON CONFLICT (event_id, lang) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Drop legacy tables. Their data now lives in feed_events.
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS signal_notes;
DROP TABLE IF EXISTS signals_cache;
DROP TABLE IF EXISTS wall_snapshots;

COMMIT;
