-- 006: PKCE verifier storage for OIDC flows (Telegram + future).

ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS code_verifier TEXT;
