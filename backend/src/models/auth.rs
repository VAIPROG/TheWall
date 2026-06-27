use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use super::users::{AccountPublic, UserPublic};

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Session {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub refresh_hash: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub token: String,
    pub refresh_token: String,
    pub user: UserPublic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthSiteRequest {
    #[serde(alias = "siteToken")]
    pub site_token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RefreshRequest {
    #[serde(alias = "refreshToken")]
    pub refresh_token: String,
}

/// POST /api/v3/auth/site — attach-or-create via filianislost site token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V3AuthSiteRequest {
    pub site: String,
    pub token: String,
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
