-- 045_templates_trgm.sql — trigram fuzzy search for template names
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_templates_name_trgm ON templates USING gin (name gin_trgm_ops);
