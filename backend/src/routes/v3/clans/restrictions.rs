//! GET /api/v3/clans/{id}/restrictions — list clan-scoped restrictions.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};
use crate::models::{RestrictionPage, RestrictionRow, RestrictionView};
use crate::routes::v3::utils::permissions::effective_clan_role;

use super::load_clan;

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RestrictionsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/restrictions
// ---------------------------------------------------------------------------

pub async fn list_clan_restrictions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Query(q): Query<RestrictionsQuery>,
) -> Result<Json<RestrictionPage>, (StatusCode, String)> {
    // ── clan existence check ──────────────────────────────────────────────────
    load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // ── require clan moderator or higher ─────────────────────────────────────
    let effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !effective.map(|r| r.is_moderator()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM restrictions WHERE scope = 'clan' AND clan_id = $1",
    )
    .bind(clan_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, RestrictionRow>(
        r#"SELECT id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                  reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                  s_send_reports, s_send_modmail, removed_at, removed_by, created_at
             FROM restrictions
            WHERE scope = 'clan' AND clan_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3"#,
    )
    .bind(clan_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let items = rows.into_iter().map(RestrictionView::from_row).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(RestrictionPage { items, page, per_page, total, total_pages }))
}
