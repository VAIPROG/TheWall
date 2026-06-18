CREATE TABLE IF NOT EXISTS server_config (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO server_config (key, value) VALUES ('extension_version', '4.0.0')
ON CONFLICT (key) DO NOTHING;
