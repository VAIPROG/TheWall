use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    // Renamed in 003_v2.sql: wall_id → external_id. Legacy code paths can
    // still read it under the new name; the JSON shape stays `wall_id` so
    // existing v1 clients keep working.
    #[serde(rename = "wall_id")]
    pub external_id: String,
    pub username: String,
    pub discord_id: Option<String>,
    #[serde(default)]
    pub discord_username: Option<String>,
    pub role: String,
    #[serde(default)]
    pub global_role: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub preferred_lang: Option<String>,
    #[serde(default)]
    pub bio: Option<String>,
    #[serde(default)]
    pub social_links: serde_json::Value,
    #[serde(default)]
    pub telemetry_opt_in: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

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

/// Public account projection returned in V3 responses.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPublic {
    pub id: Uuid,
    pub username: String,
    pub display_name: Option<String>,
    pub role: String,
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
