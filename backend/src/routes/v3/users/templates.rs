//! User templates endpoint:
//!   GET /api/v3/users/{user_ref}/templates

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::Deserialize;

use crate::{
    AppState,
    auth::AuthUser,
    models::{TemplatePage, TemplateSummary},
    routes::v3::utils::users::resolve_user_ref,
};

#[derive(Debug, Deserialize)]
pub struct UserTemplatesQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

pub async fn get_user_templates(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Query(q): Query<UserTemplatesQuery>,
) -> Result<Json<TemplatePage>, (StatusCode, String)> {
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    // Visibility: owner sees everything; others see only public approved templates
    // and clan templates they share a clan with.
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM templates
            WHERE user_id = $1
              AND (
                  user_id = $2
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      ))
              )"#,
    )
    .bind(target_id)
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, TemplateSummary>(
        r#"SELECT id, user_id, name, x, y, scale, scope, status,
                  version, clan_id, verified_at, created_at,
                  (document IS NOT NULL) AS has_document
             FROM templates
            WHERE user_id = $1
              AND (
                  user_id = $2
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      ))
              )
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4"#,
    )
    .bind(target_id)
    .bind(auth.user_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(TemplatePage { items: rows, page, per_page, total, total_pages }))
}
