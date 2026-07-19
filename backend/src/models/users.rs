use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: Uuid,
    // Renamed in 003_v2.sql: wall_id → external_id. Legacy code paths can
    // still read it under the new name; the JSON shape stays `wall_id` so
    // existing v1 clients keep working.
    #[serde(rename = "wall_id")]
    pub external_id: String,
    pub username: String,
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(rename = "lang")]
    pub preferred_lang: Option<String>,
    #[serde(default)]
    pub telemetry_opt_in: bool,
    pub role: String,
    #[serde(default)]
    pub global_role: String,
    #[serde(default)]
    pub source: String,
    pub discord_id: Option<String>,
    #[serde(default)]
    pub discord_username: Option<String>,
    #[serde(default)]
    pub social_links: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// One free-form (unverified) social link — `users.social_links` jsonb entry.
/// Distinct from `ProviderLink`, which is an OAuth-verified connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SocialLinkEntry {
    pub label: String,
    pub url: String,
}

/// Wire shape for `UserSelf` — full account profile.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSelf {
    pub id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub lang: Option<String>,
    pub telemetry_opt_in: bool,
    pub role: String,
    pub global_role: String,
    pub avatar_url: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub site_identities: Vec<SiteIdentity>,
    pub linked_accounts: Vec<ProviderLink>,
    /// Free-form (unverified) label/url links — `users.social_links`.
    pub social_links: Vec<SocialLinkEntry>,
    pub api_key_count: i64,
    pub block_list_count: i64,
}

/// Request body for PATCH /api/v3/users/me.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdate {
    pub display_name: Option<String>,
    pub username: Option<String>,
    pub bio: Option<String>,
    pub lang: Option<String>,
    pub telemetry_opt_in: Option<bool>,
    /// Free-form (unverified) social links; replaces the whole set when present.
    pub social_links: Option<Vec<SocialLinkEntry>>,
}

/// Public account projection returned in V3 responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPublic {
    pub id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub role: String,
}

/// V2 legacy public user projection (kept for old auth routes).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPublic {
    pub id: Uuid,
    pub username: String,
    pub discord_id: Option<String>,
    pub discord_username: Option<String>,
    pub role: String,
    pub clan_role: Option<String>,
    #[serde(default)]
    pub has_custom_avatar: bool,
}

/// Wire shape for V3 public profile of another user.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfilePublic {
    pub id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
    pub clan_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub social_accounts: Vec<SocialAccountPublic>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SocialAccountPublic {
    pub provider: String,
    pub username: Option<String>,
    pub is_verified: bool,
    pub linked_at: DateTime<Utc>,
}

/// Row from `api_keys`.
#[derive(Debug, Clone, FromRow)]
pub struct ApiKeyRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub prefix: String,
    pub token_hash: String,
    pub permissions: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyMeta {
    pub id: Uuid,
    pub name: String,
    pub prefix: String,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCreate {
    pub name: String,
    pub permissions: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyCreated {
    #[serde(flatten)]
    pub meta: ApiKeyMeta,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyUpdate {
    pub name: Option<String>,
    pub permissions: Option<Vec<String>>,
}

/// One row from `site_identities` — a per-site connection for an account.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct SiteIdentity {
    pub id: Uuid,
    pub account_id: Uuid,
    pub source: String,
    pub external_id: String,
    pub site_username: Option<String>,
    pub linked_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
}

/// One row from `provider_links` — an OAuth provider connection.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct ProviderLink {
    pub id: Uuid,
    pub account_id: Uuid,
    pub provider: String,
    pub provider_uid: String,
    pub username: Option<String>,
    pub is_verified: bool,
    pub is_public: bool,
    pub linked_at: DateTime<Utc>,
}
