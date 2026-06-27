-- 023: V3 identity model.
--
-- `users` becomes the canonical ACCOUNT (its id is `author.id` in stored
-- templates and the ACL UUIDs). The per-site connection is split out into
-- `site_identities`, OAuth providers become queryable `provider_links`, and a
-- mnemonic phrase backs account recovery. V3 is OAuth + site-cookie only — every
-- email pathway is removed.
--
-- Forward-only and idempotent (safe to re-run), matching the existing style.

-- 1. Normalise the global role vocabulary to V3's member|moderator|admin|owner.
--    (003 set global_role ∈ {user,admin,owner}; 'user' → 'member'.)
UPDATE users SET global_role = 'member' WHERE global_role IN ('user', '');

-- 2. SiteIdentity — one row per (source, external_id). `users` stays the
--    Account; these satellites hold each platform the account is connected to.
--    Backfilled from the existing users.(source, external_id).
CREATE TABLE IF NOT EXISTS site_identities (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source        TEXT NOT NULL,                 -- 'filianislost' | 'wplace' | …
    external_id   TEXT NOT NULL,                 -- the site's user id (old wall_id)
    site_username TEXT,
    linked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (source, external_id),                -- a site-user maps to exactly ONE account
    UNIQUE (account_id, source)                  -- an account holds ≤ 1 identity per site
);
CREATE INDEX IF NOT EXISTS idx_site_identities_account ON site_identities(account_id);

INSERT INTO site_identities (account_id, source, external_id, site_username, linked_at, last_seen_at)
SELECT id, source, external_id, username, created_at, updated_at
  FROM users
 WHERE external_id IS NOT NULL
ON CONFLICT (source, external_id) DO NOTHING;

-- 3. ProviderLink — OAuth identities (discord/telegram/github) as queryable rows
--    (needed for login-by-provider, account merge, and recovery). DISTINCT from
--    the free-form profile links in users.social_links, which stay as-is.
CREATE TABLE IF NOT EXISTS provider_links (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider     TEXT NOT NULL,                  -- 'discord' | 'telegram' | 'github'
    provider_uid TEXT NOT NULL,
    username     TEXT,
    is_verified  BOOLEAN NOT NULL DEFAULT TRUE,
    is_public    BOOLEAN NOT NULL DEFAULT FALSE,
    linked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, provider_uid)              -- one provider account → one Wall-Dev account
);
CREATE INDEX IF NOT EXISTS idx_provider_links_account ON provider_links(account_id);

-- Backfill from the legacy per-provider columns on users.
INSERT INTO provider_links (account_id, provider, provider_uid, username, is_verified)
SELECT id, 'discord', discord_id, discord_username, COALESCE(discord_linked_via_oauth, FALSE)
  FROM users
 WHERE discord_id IS NOT NULL AND discord_id <> ''
ON CONFLICT (provider, provider_uid) DO NOTHING;

INSERT INTO provider_links (account_id, provider, provider_uid, username, is_verified)
SELECT id, 'telegram', telegram_user_id, telegram_username, TRUE
  FROM users
 WHERE telegram_user_id IS NOT NULL AND telegram_user_id <> ''
ON CONFLICT (provider, provider_uid) DO NOTHING;

-- 4. Mnemonic recovery — a BIP-39-style 8-word phrase. We store ONLY a salted
--    hash (argon2id of the normalised phrase); the phrase itself is shown once.
CREATE TABLE IF NOT EXISTS account_recovery (
    account_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    phrase_hash TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. OAuth-center handshake state: the new flow carries an intent (login|link),
--    an optional post-callback redirect, and (for login) has no account yet.
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS intent       TEXT NOT NULL DEFAULT 'login';
ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS redirect_uri TEXT;
ALTER TABLE oauth_states ALTER COLUMN user_id DROP NOT NULL;  -- login mints an account in the callback

-- 6. Remove email pathways — V3 sends no mail (recovery = OAuth / site-cookie /
--    mnemonic phrase).
DROP TABLE IF EXISTS email_link_requests;
ALTER TABLE users DROP COLUMN IF EXISTS notifications_email;

-- NOTE: vai_accounts / vai_links (legacy email+password SSO) are intentionally
-- LEFT in place here for data preservation. V3 auth no longer uses them; cross-
-- site unification now happens via site_identities + the merge flow. A later
-- migration can drop them once any real groupings have been merged into accounts.
