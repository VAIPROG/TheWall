-- 020: animated-template configs reach feature parity with classic templates:
-- the same approval workflow (pending/approved/rejected via the shared
-- auto-approve bypass) and the same clan-board pinning.

ALTER TABLE anim_configs
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'approved';
DO $$ BEGIN
    ALTER TABLE anim_configs
        ADD CONSTRAINT anim_configs_status_chk
        CHECK (status IN ('pending', 'approved', 'rejected'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE anim_configs
    ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_anim_configs_status ON anim_configs(status);
