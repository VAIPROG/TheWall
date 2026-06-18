-- 010: purge accumulated signal duplicates and make dedup actually fire.
--
-- The old (source, external_id) UNIQUE constraint did nothing for rows
-- where external_id was NULL (Postgres treats NULL != NULL in UNIQUE).
-- New writers always compute a non-null key (num_id → id → content hash),
-- so we can SET NOT NULL after truncating.

TRUNCATE signals_cache RESTART IDENTITY CASCADE;
ALTER TABLE signals_cache ALTER COLUMN external_id SET NOT NULL;
