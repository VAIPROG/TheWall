//! GET /api/v3/clans/{id}/templates — paginated list of clan-scoped templates.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, models::TemplateSummary};

use super::load_clan;

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ClanTemplatesQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// Response shape (TemplatePage)
// ---------------------------------------------------------------------------

/// Paginated template list — matches `TemplatePage` in openapi/components/schemas/templates.yaml.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplatePage {
    pub items: Vec<TemplateSummary>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/templates
// ---------------------------------------------------------------------------

pub async fn list_clan_templates(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Query(q): Query<ClanTemplatesQuery>,
) -> Result<Json<TemplatePage>, (StatusCode, String)> {
    // ── clan existence check ──────────────────────────────────────────────────
    load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // ── pagination params ─────────────────────────────────────────────────────
    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    // ── total count ───────────────────────────────────────────────────────────
    // Visibility: owner's own templates, OR approved public, OR clan-scoped for
    // this clan if caller is a clan member. Same rule as the main templates list
    // but additionally filtered to clan_id = $cid AND scope = 'clan'.
    let total: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*)
             FROM templates
            WHERE clan_id = $1
              AND scope = 'clan'
              AND (
                  user_id = $2
                  OR status = 'approved'
                  OR clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      )
              )"#,
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    // ── fetch page ────────────────────────────────────────────────────────────
    let items = sqlx::query_as::<_, TemplateSummary>(
        r#"SELECT id, user_id, name, x, y, scale, scope, status,
                  version, clan_id, verified_at, created_at,
                  (document IS NOT NULL) AS has_document
             FROM templates
            WHERE clan_id = $1
              AND scope = 'clan'
              AND (
                  user_id = $2
                  OR status = 'approved'
                  OR clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      )
              )
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4"#,
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TemplatePage {
        items,
        page,
        per_page,
        total,
        total_pages,
    }))
}
