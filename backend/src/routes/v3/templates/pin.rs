//! Pin / unpin / list pinned templates.
//!
//!   POST   /api/v3/templates/{id}/pin
//!   DELETE /api/v3/templates/{id}/pin
//!   GET    /api/v3/templates/pinned

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{TemplatePage, TemplateSummary},
    routes::v3::utils::audit,
};

const SUMMARY_COLS: &str = r#"
    t.id, t.user_id, t.name, t.x, t.y, t.scale, t.scope, t.status,
    t.version, t.clan_id, t.verified_at, t.created_at,
    (t.document IS NOT NULL) AS has_document
"#;

#[derive(Debug, Deserialize)]
pub struct PinnedQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn pin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Verify the template exists and caller can see it.
    let visible: Option<bool> = sqlx::query_scalar(
        r#"SELECT TRUE FROM templates
            WHERE id = $1
              AND (
                  user_id = $2
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      ))
              )"#,
    )
    .bind(id)
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if visible.is_none() {
        return Err((StatusCode::NOT_FOUND, "template not found".to_string()));
    }

    // Assign the next available slot (V3 keeps slots internal for ordering).
    let slot: i32 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(slot) + 1, 0) FROM pinned_templates WHERE user_id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let result = sqlx::query(
        r#"INSERT INTO pinned_templates (user_id, template_id, slot)
           VALUES ($1, $2, $3)
           ON CONFLICT (user_id, template_id) DO UPDATE SET pinned_at = NOW()"#,
    )
    .bind(auth.user_id)
    .bind(id)
    .bind(slot)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::CONFLICT, "already pinned".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "template_pinned",
        "template",
        &id.to_string(),
        json!({ "slot": slot }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "pinned"})))
}

pub async fn unpin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let result = sqlx::query(
        "DELETE FROM pinned_templates WHERE user_id = $1 AND template_id = $2",
    )
    .bind(auth.user_id)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "not pinned".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "template_unpinned",
        "template",
        &id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "unpinned"})))
}

pub async fn list_pinned(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<PinnedQuery>,
) -> Result<Json<TemplatePage>, (StatusCode, String)> {
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pinned_templates WHERE user_id = $1",
    )
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, TemplateSummary>(
        &format!(
            r#"SELECT {SUMMARY_COLS}
                 FROM pinned_templates p
                 JOIN templates t ON t.id = p.template_id
                WHERE p.user_id = $1
                ORDER BY p.slot ASC, p.pinned_at DESC
                LIMIT $2 OFFSET $3"#
        ),
    )
    .bind(auth.user_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(TemplatePage { items: rows, page, per_page, total, total_pages }))
}
