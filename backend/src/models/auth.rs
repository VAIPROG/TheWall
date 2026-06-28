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

// ---------------------------------------------------------------------------
// V3 OAuth center DTOs
// ---------------------------------------------------------------------------

/// GET /api/v3/auth/oauth/{provider}/start — query params.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartQuery {
    pub intent: String,
    pub redirect_uri: Option<String>,
}

/// Response for the start endpoint — the client redirects the user to
/// `authorize_url` and stores `state` to correlate the callback.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthStartResponse {
    pub authorize_url: String,
    pub state: String,
}

/// POST /api/v3/auth/oauth/{provider}/callback — body.
#[derive(Debug, Clone, Deserialize)]
pub struct OAuthCallbackBody {
    pub code: String,
    pub state: String,
}

// ---------------------------------------------------------------------------
// V3 account merge DTOs
// ---------------------------------------------------------------------------

/// Response from POST /api/v3/auth/merge/initiate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeInitiateResponse {
    pub merge_token: String,
    pub expires_in: u32,
}

/// Request body for POST /api/v3/users/me/merge.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub merge_token: String,
}

/// Response from POST /api/v3/users/me/merge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    /// The account that now owns all of B's data (= account A).
    pub merged_account_id: Uuid,
    /// Fresh auth tokens for account A so the client stays authenticated.
    #[serde(flatten)]
    pub auth: V3AuthResponse,
}

// ---------------------------------------------------------------------------
// V3 mnemonic recovery DTOs
// ---------------------------------------------------------------------------

/// Response from POST /api/v3/users/me/recovery/phrase — phrase shown ONCE.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPhraseResponse {
    pub phrase: String,
    pub word_count: i32,
    pub created_at: DateTime<Utc>,
}

/// Request body for POST /api/v3/auth/recover.
#[derive(Debug, Clone, Deserialize)]
pub struct RecoverRequest {
    pub phrase: String,
}
