-- Add cached scaled PNG support for the /png endpoint.
--
-- Previously the /png handler decoded the template and applied its
-- stored scale on every request. When scale differed significantly from
-- 1.0 this became expensive enough to hit cloud resource limits.
--
-- We now cache the final PNG (after nearest-neighbor scaling) in the
-- template_previews table. First request generates and stores it,
-- subsequent requests are simple byte serving.
--
-- Scale is clamped to the range [0.1, 16.0]. Values outside this range
-- are adjusted to prevent excessive memory usage.

------------------------------------------------------------------------
-- scaled_png column
------------------------------------------------------------------------
ALTER TABLE template_previews
    ADD COLUMN IF NOT EXISTS scaled_png BYTEA;

-- ----------------------------------------------------------------------
-- Comment for future maintainers
-- ----------------------------------------------------------------------
COMMENT ON COLUMN template_previews.scaled_png IS
    'PNG at the template''s stored scale (scale * native resolution). '
    'Populated on first access to /api/v2/templates/{id}/png. '
    'Uses Nearest neighbor scaling. NULL means not yet generated.';

UPDATE template_previews
SET scaled_png = NULL
WHERE scaled_png IS DISTINCT FROM NULL;
