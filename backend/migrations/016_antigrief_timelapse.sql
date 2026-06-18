-- Scaffold tables for the anti-grief scanner and timelapse renderer.
--
-- Both modules ship as stubs in v4.3.0 (see `backend/src/anti_grief.rs` and
-- `backend/src/timelapse.rs`). We persist their state here so the
-- production implementations can drop in without touching the schema.
--
-- Every TIMESTAMPTZ column defaults to NOW() — the operator never has to
-- pass `created_at`. INSERTs leave it unset and Postgres fills it.

------------------------------------------------------------------------
-- anti_grief_scans
--
-- One row per (template_id, scan_time). The stub will eventually upsert
-- (template_id, last_scan_at) so the snapshot loop can skip templates that
-- were checked in the previous tick.
--
-- `damage` is the number of pixels that diverged from the template at the
-- scan moment; `alerted` records whether we DM'd / channel-pinged about
-- it, used to dedupe alerts across consecutive ticks.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS anti_grief_scans (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    template_id   UUID         NOT NULL REFERENCES protected_templates (template_id) ON DELETE CASCADE,
    damage        INTEGER      NOT NULL DEFAULT 0,
    alerted       BOOLEAN      NOT NULL DEFAULT FALSE,
    note          TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_anti_grief_scans_template_time
    ON anti_grief_scans (template_id, created_at DESC);

------------------------------------------------------------------------
-- timelapse_renders
--
-- Tracks every requested timelapse job so we can cache outputs (a 600-
-- frame render of large snapshots is expensive enough to be worth
-- skipping when an identical request lands again within the hour).
--
-- `output_url` is set when the encoder finishes; readers should treat a
-- NULL value as "still rendering" and poll. `status` follows the
-- canonical {pending, running, done, failed} state machine so cleanup
-- jobs can find stuck rows easily.
------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timelapse_renders (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by  UUID         REFERENCES users (id) ON DELETE SET NULL,
    from_ts       TIMESTAMPTZ  NOT NULL,
    to_ts         TIMESTAMPTZ  NOT NULL,
    size          TEXT         NOT NULL,
    fps           INTEGER      NOT NULL DEFAULT 4,
    frame_count   INTEGER      NOT NULL DEFAULT 0,
    status        TEXT         NOT NULL DEFAULT 'pending',
    output_url    TEXT,
    error         TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_timelapse_renders_status_time
    ON timelapse_renders (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timelapse_renders_requester
    ON timelapse_renders (requested_by);

------------------------------------------------------------------------
-- updated_at scaffolding for templates
--
-- The new `/json` and `/charity` endpoints expose template metadata to
-- third-party tools. Charity-style clients poll periodically; we want a
-- mtime they can `If-Modified-Since` against. A trigger keeps the column
-- in sync with every UPDATE.
------------------------------------------------------------------------
ALTER TABLE templates
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE OR REPLACE FUNCTION touch_templates_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_templates_touch_updated_at ON templates;
CREATE TRIGGER trg_templates_touch_updated_at
    BEFORE UPDATE ON templates
    FOR EACH ROW EXECUTE FUNCTION touch_templates_updated_at();
