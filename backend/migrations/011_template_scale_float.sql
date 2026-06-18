-- Store template scale as a fractional value. Existing integer values cast
-- losslessly; new writes are constrained to the public API contract.
ALTER TABLE templates
    ALTER COLUMN scale TYPE DOUBLE PRECISION USING scale::double precision,
    ALTER COLUMN scale SET DEFAULT 1.0;

ALTER TABLE templates DROP CONSTRAINT IF EXISTS templates_scale_range;
ALTER TABLE templates
    ADD CONSTRAINT templates_scale_range CHECK (scale >= 0.01 AND scale <= 10000.0);
