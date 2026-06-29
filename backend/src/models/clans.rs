use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Raw DB row
// ---------------------------------------------------------------------------

/// Raw row from the `clans` table.
#[derive(Debug, Clone, FromRow)]
pub struct ClanV3 {
    pub id: Uuid,
    pub source: String,
    pub external_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub discord_id: Option<String>,
    pub icon: Option<String>,
    pub stats: serde_json::Value,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    // +025 governance columns
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    pub description: Option<String>,
    pub tag: Option<String>,
    pub verified: bool,
    pub discoverable: bool,
    pub lang: Option<String>,
    pub max_members: Option<i32>,
    pub owner_id: Option<Uuid>,
    pub join_policy: String,
    pub settings: serde_json::Value,
    pub moderation: serde_json::Value,
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

/// The `stats` sub-object in the Clan wire response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanStats {
    pub member_count: i64,
    pub template_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub online_count: Option<i64>,
}

/// Parsed from `clans.moderation` jsonb. Only present when `lockedFields` is non-empty.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanModerationState {
    pub locked_fields: Vec<String>,
    pub locked_by: Option<Uuid>,
    pub locked_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
}

/// The authenticated caller's relationship to the clan.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanViewerContext {
    pub role: Option<String>,
    pub membership_status: String,
    pub can_manage_members: bool,
    pub can_manage_settings: bool,
    pub can_moderate_chat: bool,
    pub can_post_templates: bool,
}

/// The `Clan` wire shape returned by list/get/create/update.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanView {
    pub id: Uuid,
    pub name: String,
    pub description: String,
    pub avatar_url: Option<String>,
    pub owner_id: Option<Uuid>,
    pub member_count: i64,
    pub chat_id: Option<Uuid>,
    pub join_policy: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub tag: Option<String>,
    pub banner_url: Option<String>,
    pub verified: bool,
    pub discoverable: bool,
    pub lang: Option<String>,
    pub links: Vec<serde_json::Value>,
    pub max_members: Option<i32>,
    pub stats: ClanStats,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viewer: Option<ClanViewerContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub moderation: Option<ClanModerationState>,
}

/// Paginated list response for clans.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanPage {
    pub items: Vec<ClanView>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/// POST /api/v3/clans/new body.
#[derive(Debug, Clone, Deserialize)]
pub struct ClanCreate {
    pub name: String,
    pub description: Option<String>,
}

/// PATCH /api/v3/clans/{id} body. All fields optional — presence = update.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanUpdate {
    pub name: Option<String>,
    pub description: Option<String>,
    pub avatar_url: Option<serde_json::Value>, // Value so null clears it
    pub banner_url: Option<serde_json::Value>,
    pub tag: Option<serde_json::Value>,
    pub discoverable: Option<bool>,
}

/// Query params for GET /api/v3/clans.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanListQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub search: Option<String>,
    pub sort_by: Option<String>,
    pub order: Option<String>,
}
