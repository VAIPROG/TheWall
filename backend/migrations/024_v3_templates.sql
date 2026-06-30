-- 024: V3 templates — canonical the-wall-dev/2 document + verification metadata.
--
-- The image and full layer data currently live encoded inside `share`. The new
-- `document` jsonb holds the canonical the-wall-dev/2 representation. It is
-- backfilled by a Rust one-shot (decode `share` → v2), NOT in SQL, because the
-- decode (base64 image extraction, palette/animation parsing) isn't expressible
-- in SQL. `share` is RETAINED as the source of truth until every row's
-- `document` is populated; the `/templates/{id}/wall-dev` and `/charity`
-- endpoints can fall back to `share` while the backfill runs.
--
-- Forward-only and idempotent.

ALTER TABLE templates ADD COLUMN IF NOT EXISTS document         JSONB;  -- the-wall-dev/2
ALTER TABLE templates ADD COLUMN IF NOT EXISTS verified_by      UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS verified_at      TIMESTAMPTZ;
ALTER TABLE templates ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Optimistic-concurrency token for the flexible PATCH editing flow (V3 spec:
-- TemplatePatch.expectedVersion → 409 on mismatch).
ALTER TABLE templates ADD COLUMN IF NOT EXISTS version          INTEGER NOT NULL DEFAULT 1;

-- Rows still awaiting the Rust document backfill.
CREATE INDEX IF NOT EXISTS idx_templates_needs_document ON templates(id) WHERE document IS NULL;

-- Best-effort: mark already-approved rows as verified (original approver is
-- unknown for historical rows, so verified_by stays NULL).
UPDATE templates SET verified_at = created_at WHERE status = 'approved' AND verified_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- RUST BACKFILL (run once, after this migration):
--   FOR each template WHERE document IS NULL:
--     decode `share` (same logic as the extension's src/formats: wall-dev v1/v2
--     or charity → canonical the-wall-dev/2), then:
--       UPDATE templates SET document = $doc WHERE id = $id;
--   The v2 doc's templates[0] takes x/y/scale from the row; author.id = user_id;
--   width/height/imageSources come from the decoded share. v1 payloads migrate
--   to v2; charity payloads assemble to v2. Charity stays DERIVED on read.
-- ─────────────────────────────────────────────────────────────────────────────
