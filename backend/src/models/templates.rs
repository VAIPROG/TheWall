use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

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

// ---------------------------------------------------------------------------
// V3 template models — the-wall-dev/2 canonical document format
// ---------------------------------------------------------------------------

/// Full V3 template row returned from the DB.
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TemplateV3 {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub document: Option<serde_json::Value>,
    pub version: i32,
    pub verified_by: Option<Uuid>,
    pub verified_at: Option<DateTime<Utc>>,
    pub rejection_reason: Option<String>,
    pub clan_id: Option<Uuid>,
    pub author: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// The source document supplied by the client when creating a V3 template.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSource {
    pub format: String,
    pub document: serde_json::Value,
}

/// Request body for POST /api/v3/templates/new.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreateV3 {
    pub scope: String,
    pub clan_id: Option<Uuid>,
    pub source: TemplateSource,
}

/// Response body for POST /api/v3/templates/new — wraps the created row
/// with any non-fatal conversion warnings emitted during ingest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCreated {
    pub template: TemplateV3,
    pub warnings: Vec<String>,
}

/// Light projection returned by GET /api/v3/templates (list).
/// Omits `document` to keep list payloads small; clients fetch the full
/// row or the /wall-dev export when they need the document.
#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct TemplateSummary {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub version: i32,
    pub clan_id: Option<Uuid>,
    pub verified_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// True when the `document` column is non-NULL (i.e. the row has been
    /// backfilled to the v2 format and export endpoints will work).
    pub has_document: bool,
}

/// Query parameters for GET /api/v3/templates.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateListQueryV3 {
    pub scope: Option<String>,
    pub status: Option<String>,
    pub author: Option<Uuid>,
    pub limit: Option<i64>,
    pub cursor: Option<DateTime<Utc>>,
}

/// Request body for POST /api/v3/templates/{id}/verify.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVerifyRequest {
    /// "approve" or "reject"
    pub decision: String,
    pub reason: Option<String>,
}
