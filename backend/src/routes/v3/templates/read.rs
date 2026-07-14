//! GET /api/v3/templates        — paginated list with visibility filtering
//! GET /api/v3/templates/{id}   — single template with visibility check
use crate::http_error::ResultExt;

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

    // First attempt: full visibility (scope + whitelist/blocklist + co-editors)
    // + optional password flag. `$2` = the caller's user id. Global staff
    // bypass the blocklist/whitelist entirely.
    let privileged = super::acl::is_privileged(&state.pool, user_id).await;
    let visibility = super::acl::view_sql(2, privileged);
    let row = sqlx::query_as::<_, TemplateV3>(&format!(
        r#"SELECT {COLS} FROM templates WHERE id = $1 AND {visibility}"#
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let template = if let Some(row) = row {
        row
    } else if let Some(password) = access.context.password.as_deref() {
        // Fallback: per-template password bypasses scope checks.
        if super::access::verify_template_password(&state.pool, id, password).await {
            sqlx::query_as::<_, TemplateV3>(&format!(r#"SELECT {COLS} FROM templates WHERE id = $1"#))
                .bind(id)
                .fetch_optional(&state.pool)
                .await
                .or_500()?
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

    // Anonymity: when the author chose to be anonymous, a viewer who is neither
    // the owner nor global staff must not be able to recover the creator — so
    // redact the identity columns (`author` username + `user_id`, which is
    // otherwise resolvable to a username). The document's own author field is
    // already "anon"/null and carries no identity.
    let viewer_is_owner = user_id == Some(template.user_id);
    let mut body = serde_json::to_value(&template).unwrap_or(serde_json::Value::Null);
    if !viewer_is_owner && !privileged && super::acl::author_hidden(&template.document) {
        if let Some(obj) = body.as_object_mut() {
            obj.insert("author".into(), serde_json::Value::Null);
            obj.insert("userId".into(), serde_json::Value::Null);
        }
    }

    Ok((StatusCode::OK, resp_headers, Json(body)).into_response())
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

    // Light projection — no `document` column in the result. `has_document`
    // and `template_count` are derived from it; the WHERE still references the
    // `document` column (visibility). `$6` = the caller's user id.
    let privileged = super::acl::is_privileged(&state.pool, user_id).await;
    let visibility = super::acl::view_sql(6, privileged);
    let rows = sqlx::query_as::<_, TemplateSummary>(&format!(
        r#"SELECT id,
                  -- Anonymity: hide the creator id on anonymous templates from
                  -- anyone but the owner or global staff (`$7`). An anon row is
                  -- one whose document.author is not a full object.
                  CASE WHEN (document -> 'author' IS NULL
                             OR jsonb_typeof(document -> 'author') <> 'object')
                            AND NOT $7
                            AND ($6::uuid IS NULL OR user_id <> $6)
                       THEN NULL ELSE user_id END AS user_id,
                  name, x, y, scale, scope, status,
                  version, clan_id, verified_at, created_at,
                  (document IS NOT NULL) AS has_document,
                  COALESCE(jsonb_array_length(document -> 'templates'), 1) AS template_count,
                  COALESCE(document @? '$.templates[*].layers[*].animation', false) AS animated
             FROM templates
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::text IS NULL OR status = $2)
              AND ($3::uuid IS NULL OR user_id = $3)
              AND ($4::timestamptz IS NULL OR created_at < $4)
              AND {visibility}
            ORDER BY created_at DESC
            LIMIT $5"#
    ))
    .bind(q.scope.as_deref())
    .bind(q.status.as_deref())
    .bind(q.author)
    .bind(q.cursor)
    .bind(limit)
    .bind(user_id)
    .bind(privileged)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows))
}
