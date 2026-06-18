-- 019: protected-region approval workflow + password-shared anim configs.
--
-- Regions come in three scopes (private / clan / public-global). Publishing
-- beyond yourself now needs an approval: clan-scoped regions are approved by
-- the clan's moderators or admins, public ones by global admins. Private
-- regions are auto-approved (they're only yours). Existing rows predate the
-- workflow and stay approved.
--
-- anim_configs gain an optional access password: a private config can be
-- opened by a non-owner if the share link carries the password (the server
-- stores only the SHA-256 hash).

ALTER TABLE protected_regions
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
DO $$ BEGIN
    ALTER TABLE protected_regions
        ADD CONSTRAINT protected_regions_status_chk
        CHECK (status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS idx_protected_regions_status ON protected_regions(status);

ALTER TABLE anim_configs
    ADD COLUMN IF NOT EXISTS access_password_hash TEXT;
