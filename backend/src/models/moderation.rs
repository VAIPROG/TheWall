//! Models for the V3 moderation subsystem — restrictions, sanctions, audit.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Sanctions (the six s_* flag columns)
// ---------------------------------------------------------------------------

/// Wire shape for the `sanctions` sub-object in RestrictionSet / RestrictionCreate.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sanctions {
    #[serde(default)]
    pub mute: bool,
    #[serde(default)]
    pub ban: bool,
    #[serde(default)]
    pub publish_templates: bool,
    #[serde(default)]
    pub invite_to_clan: bool,
    #[serde(default)]
    pub send_reports: bool,
    #[serde(default)]
    pub send_modmail: bool,
}

impl Default for Sanctions {
    fn default() -> Self {
        Self {
            mute: false,
            ban: false,
            publish_templates: false,
            invite_to_clan: false,
            send_reports: false,
            send_modmail: false,
        }
    }
}

// ---------------------------------------------------------------------------
// RestrictionRow — raw DB row from `restrictions`
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, FromRow)]
pub struct RestrictionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub scope: String,
    pub clan_id: Option<Uuid>,
    pub applied_by: Option<Uuid>,
    pub applied_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
    pub s_mute: bool,
    pub s_ban: bool,
    pub s_publish_templates: bool,
    pub s_invite_to_clan: bool,
    pub s_send_reports: bool,
    pub s_send_modmail: bool,
    pub removed_at: Option<DateTime<Utc>>,
    pub removed_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// RestrictionView — wire shape (RestrictionSet in openapi)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionView {
    pub id: Uuid,
    pub user_id: Uuid,
    pub scope: String,
    pub clan_id: Option<Uuid>,
    pub applied_by: Option<Uuid>,
    pub applied_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub reason: Option<String>,
    pub sanctions: Sanctions,
}

impl RestrictionView {
    pub fn from_row(r: RestrictionRow) -> Self {
        Self {
            id: r.id,
            user_id: r.user_id,
            scope: r.scope,
            clan_id: r.clan_id,
            applied_by: r.applied_by,
            applied_at: r.applied_at,
            expires_at: r.expires_at,
            reason: r.reason,
            sanctions: Sanctions {
                mute: r.s_mute,
                ban: r.s_ban,
                publish_templates: r.s_publish_templates,
                invite_to_clan: r.s_invite_to_clan,
                send_reports: r.s_send_reports,
                send_modmail: r.s_send_modmail,
            },
        }
    }
}

// ---------------------------------------------------------------------------
// RestrictionPage — paginated list response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionPage {
    pub items: Vec<RestrictionView>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

// ---------------------------------------------------------------------------
// RestrictionCreate — POST body
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionCreate {
    pub user_id: Uuid,
    pub scope: String,
    pub clan_id: Option<Uuid>,
    pub duration_minutes: Option<i64>,
    pub reason: Option<String>,
    pub sanctions: Sanctions,
}

// ---------------------------------------------------------------------------
// RestrictionUpdate — PATCH body
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionUpdate {
    /// New duration in minutes from now. None = make permanent (clear expires_at).
    pub duration_minutes: Option<i64>,
    pub reason: Option<String>,
    pub sanctions: Option<Sanctions>,
}

// ===========================================================================
// Reports — unified polymorphic report queue
// ===========================================================================

/// Raw DB row from `reports`.
#[derive(Debug, Clone, FromRow)]
pub struct ReportRow {
    pub id: Uuid,
    #[sqlx(rename = "type")]
    pub report_type: String,
    pub target_id: String,
    pub clan_id: Option<Uuid>,
    pub reporter_id: Option<Uuid>,
    pub reason: String,
    pub evidence: Option<String>,
    pub status: String,
    pub assigned_mod_id: Option<Uuid>,
    pub resolution: Option<String>,
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub resolved_by: Option<Uuid>,
    pub resolved_at: Option<DateTime<Utc>>,
    /// Joined from `users.username` (NULL when reporter deleted).
    #[sqlx(rename = "reporter_username")]
    pub reporter_username: Option<String>,
}

/// Wire shape — `Report` in the OpenAPI spec.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportView {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub report_type: String,
    pub target_id: String,
    /// Entity type of the target — mirrors `type` (template/message/user/clan).
    pub target_type: String,
    pub reporter_id: Option<Uuid>,
    pub reporter_username: String,
    pub reason: String,
    pub evidence: Option<String>,
    pub status: String,
    pub assigned_mod_id: Option<Uuid>,
    pub resolution: Option<String>,
    /// Internal moderator notes (additive — not in the frozen spec but stored).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl ReportView {
    pub fn from_row(r: ReportRow) -> Self {
        Self {
            id: r.id,
            report_type: r.report_type.clone(),
            target_id: r.target_id,
            target_type: r.report_type,
            reporter_id: r.reporter_id,
            reporter_username: r.reporter_username.unwrap_or_else(|| "unknown".to_string()),
            reason: r.reason,
            evidence: r.evidence,
            status: r.status,
            assigned_mod_id: r.assigned_mod_id,
            resolution: r.resolution,
            notes: r.notes,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

/// Paginated report list response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportPage {
    pub items: Vec<ReportView>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

/// PATCH /moderation/reports/{id} body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportUpdate {
    pub status: Option<String>,
    pub assigned_mod_id: Option<Uuid>,
    pub notes: Option<String>,
}

/// POST /moderation/reports/{id}/resolve body.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResolve {
    pub resolution: String,
    pub notes: Option<String>,
    #[serde(default)]
    pub create_restriction: bool,
}

/// POST /moderation/reports/{id}/dismiss body.
#[derive(Debug, Clone, Deserialize)]
pub struct ReportDismiss {
    pub reason: Option<String>,
}

/// POST /moderation/queue/{id}/approve|reject body (ModAction).
#[derive(Debug, Clone, Deserialize)]
pub struct ModAction {
    pub notes: Option<String>,
}

// ===========================================================================
// Clan moderation actions (takedown / unlock)
// ===========================================================================

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanTakedownRequest {
    pub fields: Vec<String>,
    #[serde(default = "default_takedown_action")]
    pub action: String,
    pub reason: String,
}

fn default_takedown_action() -> String {
    "strip_and_lock".to_string()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClanUnlockRequest {
    pub fields: Vec<String>,
    pub reason: Option<String>,
}

// ===========================================================================
// Audit log
// ===========================================================================

/// Raw DB row from `mod_audit_log` with the moderator username joined.
#[derive(Debug, Clone, FromRow)]
pub struct AuditLogRow {
    pub id: Uuid,
    pub moderator_id: Option<Uuid>,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub details: serde_json::Value,
    pub created_at: DateTime<Utc>,
    #[sqlx(rename = "moderator_username")]
    pub moderator_username: Option<String>,
}

/// Row from `clan_bans`.
#[derive(Debug, Clone, FromRow)]
pub struct ClanBanRow {
    pub id: Uuid,
    pub clan_id: Uuid,
    pub user_id: Uuid,
    pub banned_by: Uuid,
    pub reason: Option<String>,
    pub banned_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
    pub removed_at: Option<DateTime<Utc>>,
    pub removed_by: Option<Uuid>,
}

/// Wire shape — `AuditLogEntry` in the OpenAPI spec.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogEntry {
    pub id: Uuid,
    pub moderator_id: Option<Uuid>,
    pub moderator_username: String,
    pub action: String,
    pub target_type: String,
    pub target_id: String,
    pub details: Option<serde_json::Value>,
    pub created_at: DateTime<Utc>,
}

impl AuditLogEntry {
    pub fn from_row(r: AuditLogRow) -> Self {
        Self {
            id: r.id,
            moderator_id: r.moderator_id,
            moderator_username: r.moderator_username.unwrap_or_else(|| "system".to_string()),
            action: r.action,
            target_type: r.target_type,
            target_id: r.target_id,
            details: if r.details.is_null() { None } else { Some(r.details) },
            created_at: r.created_at,
        }
    }
}

/// Paginated audit-log response.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditLogPage {
    pub items: Vec<AuditLogEntry>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

// ===========================================================================
// User appeals
// ===========================================================================

/// Request body for POST /api/v3/users/me/appeal.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAppealCreate {
    pub reason: String,
}

/// Row from `user_appeals`.
#[derive(Debug, Clone, FromRow)]
pub struct UserAppealRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub reason: String,
    pub status: String,
    pub moderator_notes: Option<String>,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
    pub resolved_by: Option<Uuid>,
}

/// Wire shape for a submitted appeal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserAppeal {
    pub id: Uuid,
    pub user_id: Uuid,
    pub reason: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}
