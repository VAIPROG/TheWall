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
