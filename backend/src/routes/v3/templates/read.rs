//! GET /api/v3/templates        — paginated list with visibility filtering
//! GET /api/v3/templates/{id}   — single template with visibility check

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use crate::{
    AppState,
    models::{TemplateListQueryV3, TemplateSummary, TemplateV3},
};

use super::access::TemplateAccess;

/// Columns selected for a full TemplateV3 row.
const COLS: &str = r#"
    id, user_id, name, x, y, scale, scope, status,
    document, version, verified_by, verified_at,
    rejection_reason, clan_id, author, created_at
"#;

// ---------------------------------------------------------------------------
// GET /api/v3/templates/{id}
// ---------------------------------------------------------------------------

pub async fn get(
    access: TemplateAccess,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    let user_id = access.context.user_id;
    let has_password = access.context.password.is_some();

    // First attempt: normal visibility + optional password flag.
    let row = sqlx::query_as::<_, TemplateV3>(&format!(
        r#"SELECT {COLS}
             FROM templates
            WHERE id = $1
              AND (
                  (scope = 'public' AND status = 'approved')
                  OR user_id = $2
                  OR (scope = 'clan' AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $2 AND active = TRUE
                      ))
                  OR ($3 = TRUE)
              )"#
    ))
    .bind(id)
    .bind(user_id)
    .bind(has_password)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let template = if let Some(row) = row {
        row
    } else if let Some(password) = access.context.password.as_deref() {
        // Fallback: per-template password bypasses scope checks.
        if super::access::verify_template_password(&state.pool, id, password).await {
            sqlx::query_as::<_, TemplateV3>(&format!(r#"SELECT {COLS} FROM templates WHERE id = $1"#))
                .bind(id)
                .fetch_optional(&state.pool)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .ok_or((StatusCode::NOT_FOUND, "not found".into()))?
        } else {
            return Err((StatusCode::NOT_FOUND, "not found".into()));
        }
    } else {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    };

    // ETag: "<id>-v<version>"
    let etag_value = format!("\"{}-v{}\"", template.id, template.version);

    // Conditional GET — return 304 if client already has this version.
    if let Some(inm) = headers.get("if-none-match") {
        if inm.as_bytes() == etag_value.as_bytes() {
            let mut resp_headers = HeaderMap::new();
            resp_headers.insert(
                "etag",
                HeaderValue::from_str(&etag_value)
                    .unwrap_or_else(|_| HeaderValue::from_static("")),
            );
            return Ok((StatusCode::NOT_MODIFIED, resp_headers).into_response());
        }
    }

    let mut resp_headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&etag_value) {
        resp_headers.insert("etag", v);
    }
    resp_headers.insert(
        "cache-control",
        HeaderValue::from_static("private, must-revalidate"),
    );

    Ok((StatusCode::OK, resp_headers, Json(template)).into_response())
}

// ---------------------------------------------------------------------------
// GET /api/v3/templates
// ---------------------------------------------------------------------------

pub async fn list(
    access: TemplateAccess,
    State(state): State<AppState>,
    Query(q): Query<TemplateListQueryV3>,
) -> Result<Json<Vec<TemplateSummary>>, (StatusCode, String)> {
    let limit = q.limit.unwrap_or(50).min(200);
    let user_id = access.context.user_id;

    // Light projection — no `document` column.  `has_document` lets the
    // client know whether the /wall-dev export endpoint will work.
    let rows = sqlx::query_as::<_, TemplateSummary>(
        r#"SELECT id, user_id, name, x, y, scale, scope, status,
                  version, clan_id, verified_at, created_at,
                  (document IS NOT NULL) AS has_document
             FROM templates
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR user_id = $3)
              AND ($4::timestamptz IS NULL OR created_at < $4)
              AND (
                  user_id = $6
                  OR (scope = 'public' AND status = 'approved')
                  OR (scope = 'clan' AND $6 IS NOT NULL AND clan_id IN (
                        SELECT clan_id FROM clan_memberships
                         WHERE user_id = $6 AND active = TRUE
                      ))
              )
            ORDER BY created_at DESC
            LIMIT $5"#,
    )
    .bind(q.scope.as_deref())
    .bind(q.status.as_deref())
    .bind(q.author)
    .bind(q.cursor)
    .bind(limit)
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}
