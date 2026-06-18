-- 022: classic templates gain the same password-share mechanism animated
-- configs already have (anim_configs.access_password_hash, migration 020):
-- the owner sets an optional password at publish time; anyone holding the
-- template id + password can fetch it via GET /v2/templates/{id}/shared
-- without any other visibility (works even for scope='private').

ALTER TABLE templates ADD COLUMN IF NOT EXISTS access_password_hash TEXT;
