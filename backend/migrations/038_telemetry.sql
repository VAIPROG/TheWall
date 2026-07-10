-- 038: V3 telemetry tables for client events, logs, and server-side metrics.

-- A legacy V2 aggregate table named telemetry_events (day/event_type/count/...)
-- has an incompatible schema and shadows the V3 per-event table below, so a bare
-- CREATE TABLE IF NOT EXISTS would silently keep the wrong shape. Drop it first
-- (it only ever held rolled-up counters, safe to discard).
DROP TABLE IF EXISTS telemetry_events;

CREATE TABLE IF NOT EXISTS telemetry_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type    TEXT NOT NULL,
    client_ts     TIMESTAMPTZ NOT NULL,
    data          JSONB NOT NULL DEFAULT '{}',
    session_id    UUID,
    page_url      TEXT,
    client_version TEXT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_user ON telemetry_events(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_type ON telemetry_events(event_type);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id);

CREATE TABLE IF NOT EXISTS telemetry_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
    level         TEXT NOT NULL,
    message       TEXT NOT NULL,
    client_ts     TIMESTAMPTZ NOT NULL,
    source        TEXT,
    session_id    UUID,
    context       JSONB,
    stack         TEXT,
    tags          TEXT[],
    client_version TEXT,
    ip            INET,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_user ON telemetry_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_level ON telemetry_logs(level);
CREATE INDEX IF NOT EXISTS idx_telemetry_logs_ts ON telemetry_logs(client_ts);

CREATE TABLE IF NOT EXISTS telemetry_rate_limits (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    last_log_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
