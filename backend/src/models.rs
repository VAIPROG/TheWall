use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Database models
// ---------------------------------------------------------------------------

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

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub refresh_hash: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}


#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Template {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub share: String,
    pub author: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Notification {
    pub id: Uuid,
    pub user_id: Uuid,
    pub title: String,
    pub body: Option<String>,
    pub read: bool,
    pub created_at: DateTime<Utc>,
}



// ---------------------------------------------------------------------------
// API request / response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSiteRequest {
    #[serde(alias = "siteToken")]
    pub site_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub refresh_token: String,
    pub user: UserPublic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRequest {
    #[serde(alias = "refreshToken")]
    pub refresh_token: String,
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


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareTemplateRequest {
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: Option<f64>,
    pub scope: String,
    pub share: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReportRequest {
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AckRequest {
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AvatarRequest {
    pub image: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModApplyRequest {
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRelayRequest {
    pub markdown: String,
}

// ---------------------------------------------------------------------------
// V3 identity models
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// V3 API request / response types
// ---------------------------------------------------------------------------

/// POST /api/v3/auth/site — attach-or-create via filianislost site token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V3AuthSiteRequest {
    pub site: String,
    pub token: String,
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

/// V3 auth response (JWT pair + account info).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub token_type: String,
    pub user: AccountPublic,
}

/// POST /api/v3/auth/refresh
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3RefreshRequest {
    pub refresh_token: String,
}
