//! GET /api/v3/templates        — paginated list with visibility filtering
//! GET /api/v3/templates/{id}   — single template with visibility check

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{TemplateListQueryV3, TemplateV3},
};

/// Columns selected for every TemplateV3 query.
const COLS: &str = r#"
    id, user_id, name, x, y, scale, scope, status,
    document, version, verified_by, verified_at,
    rejection_reason, clan_id, author, created_at
"#;

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}
// ---------------------------------------------------------------------------

pub async fn get(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    // Visibility mirrors v2 shared (session path):
    //   owner  OR  (public AND approved)  OR  (clan member of the template's clan)
    let row = sqlx::query_as::<_, TemplateV3>(&format!(
        r#"SELECT {COLS}
             FROM templates
            WHERE id = $2
              AND (
                  user_id = $1
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $1 AND active = TRUE
                      ))
              )"#
    ))
    .bind(auth.user_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    row.map(Json)
        .ok_or((StatusCode::NOT_FOUND, "not found".into()))
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates
// ---------------------------------------------------------------------------

pub async fn list(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<TemplateListQueryV3>,
) -> Result<Json<Vec<TemplateV3>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).min(200);

    // Visibility: same three-clause rule as the single-get, plus optional
    // filters for scope / status / author and cursor-based pagination.
    let rows = sqlx::query_as::<_, TemplateV3>(&format!(
        r#"SELECT {COLS}
             FROM templates
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR user_id = $3)
              AND ($4::timestamptz IS NULL OR created_at < $4)
              AND (
                  user_id = $6
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $6 AND active = TRUE
                      ))
              )
            ORDER BY created_at DESC
            LIMIT $5"#
    ))
    .bind(q.scope.as_deref())
    .bind(q.status.as_deref())
    .bind(q.author)
    .bind(q.cursor)
    .bind(limit)
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}
