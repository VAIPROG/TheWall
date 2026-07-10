//! Moderation audit log — list endpoint.
//!
//!   GET /api/v3/moderation/audit-log
//!
//! Authorization: global moderator+.

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{AuditLogEntry, AuditLogPage, AuditLogRow},
    routes::v3::utils::permissions,
};

#[derive(Debug, Deserialize)]
pub struct AuditLogQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn get_audit_log(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<AuditLogQuery>,
) -> Result<Json<AuditLogPage>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM mod_audit_log")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, AuditLogRow>(
        r#"SELECT a.id, a.moderator_id, a.action, a.target_type, a.target_id,
                  a.details, a.created_at, u.username AS moderator_username
             FROM mod_audit_log a
             LEFT JOIN users u ON u.id = a.moderator_id
            ORDER BY a.created_at DESC
            LIMIT $1 OFFSET $2"#,
    )
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let items = rows.into_iter().map(AuditLogEntry::from_row).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(AuditLogPage { items, page, per_page, total, total_pages }))
}
