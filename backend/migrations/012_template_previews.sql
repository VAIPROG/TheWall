CREATE TABLE IF NOT EXISTS template_previews (
    template_id UUID PRIMARY KEY REFERENCES templates(id) ON DELETE CASCADE,
    preview_64  BYTEA NOT NULL,
    preview_128 BYTEA NOT NULL,
    preview_256 BYTEA NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
