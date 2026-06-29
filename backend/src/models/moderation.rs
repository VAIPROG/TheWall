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
