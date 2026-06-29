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

// ---------------------------------------------------------------------------
// Member wire shapes (slice 2)
// ---------------------------------------------------------------------------

/// Single member in the ClanMember wire response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanMemberView {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub role_rank: i32,
    pub permissions: Vec<String>,
    pub nickname: Option<String>,
    pub title: Option<String>,
    pub last_active_at: Option<DateTime<Utc>>,
}

/// Paginated list response for clan members.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanMemberPage {
    pub items: Vec<ClanMemberView>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

/// PATCH /api/v3/clans/{id}/members/{uid} body.
#[derive(Debug, Clone, Deserialize)]
pub struct ClanMemberRoleUpdate {
    pub role: String,
}

/// POST body for destructive confirmation actions.
/// Matches `admins.yaml#/ConfirmationRequest` — `{ confirm: bool }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ConfirmRequest {
    pub confirm: bool,
}

// ---------------------------------------------------------------------------
// Join-flow wire shapes (slice 3)
// ---------------------------------------------------------------------------

/// A single clan invite as returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanInviteView {
    pub id: Uuid,
    pub code: String,
    pub created_by: Option<Uuid>,
    pub target_user_id: Option<Uuid>,
    pub max_uses: Option<i32>,
    pub use_count: i32,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

/// POST /api/v3/clans/{id}/invites body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanInviteCreate {
    pub target_user_id: Option<Uuid>,
    pub max_uses: Option<i32>,
    pub expires_in_hours: Option<i64>,
}

/// POST /api/v3/clans/{id}/join body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanJoinRequest {
    pub invite_code: Option<String>,
}

/// POST /api/v3/clans/{cid}/apply/{role} body.
#[derive(Debug, Clone, Deserialize)]
pub struct ClanRoleApplicationReq {
    pub message: Option<String>,
}

/// Nested applicant info embedded in `ClanJoinApplicationView`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanJoinApplicationApplicant {
    pub user_id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

/// A join application as returned by the API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanJoinApplicationView {
    pub id: Uuid,
    pub clan_id: Uuid,
    pub applicant: ClanJoinApplicationApplicant,
    pub message: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
    pub reviewed_by: Option<Uuid>,
    pub reviewed_at: Option<DateTime<Utc>>,
}

/// POST /api/v3/clans/{cid}/applications/{aid}/review body.
#[derive(Debug, Clone, Deserialize)]
pub struct ApplicationReview {
    pub decision: String, // "approve" | "reject"
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Settings wire shapes (slice 4)
// ---------------------------------------------------------------------------

/// Fine-grained moderation configuration stored under settings["moderationPreferences"].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanModerationPreferences {
    pub auto_approve_joins: bool,
    pub require_approval_for_templates: bool,
    pub min_account_age_days: i32,
    pub block_reported_users: bool,
    pub members_can_delete_own_templates: bool,
}

impl Default for ClanModerationPreferences {
    fn default() -> Self {
        Self {
            auto_approve_joins: false,
            require_approval_for_templates: false,
            min_account_age_days: 0,
            block_reported_users: false,
            members_can_delete_own_templates: true,
        }
    }
}

/// Chat permission rules stored under settings["chatPermissions"].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanChatPermissions {
    pub who_can_post: String,
    pub slowmode_seconds: i32,
    pub who_can_invite: String,
    pub who_can_post_templates: String,
}

impl Default for ClanChatPermissions {
    fn default() -> Self {
        Self {
            who_can_post: "members".to_string(),
            slowmode_seconds: 0,
            who_can_invite: "moderators".to_string(),
            who_can_post_templates: "members".to_string(),
        }
    }
}

/// GET /api/v3/clans/{id}/settings response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanSettingsView {
    pub join_policy: String,
    pub template_scope_default: String,
    pub moderation_preferences: ClanModerationPreferences,
    pub chat_permissions: ClanChatPermissions,
    pub discoverable: bool,
    pub default_member_role: String,
    pub member_cap: i32,
}

/// PATCH /api/v3/clans/{id}/settings request body. All fields optional.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanSettingsUpdate {
    pub join_policy: Option<String>,
    pub template_scope_default: Option<String>,
    pub moderation_preferences: Option<ClanModerationPreferences>,
    pub chat_permissions: Option<ClanChatPermissions>,
    pub discoverable: Option<bool>,
    pub default_member_role: Option<String>,
    pub member_cap: Option<i32>,
}

/// POST /api/v3/clans/{id}/report request body.
#[derive(Debug, Clone, Deserialize)]
pub struct ClanReportCreate {
    pub reason: String,
    pub evidence: Option<String>,
}
