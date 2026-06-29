//! POST /api/v3/templates/new
//!
//! Creates a new V3 template. Accepts the-wall-dev/2 (native), the-wall-dev/1,
//! and charity payloads. Non-native formats are converted server-side to
//! the-wall-dev/2 before storage; conversion warnings are returned in the
//! response alongside the created template.
//!
//! Mirrors v2 create logic: scope validation, clan_id resolution, membership
//! check, auto-approval via permissions::publish_auto_approved, scale
//! validation, and the allow_public_template_publishing server_config gate.

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{TemplateCreateV3, TemplateCreated, TemplateV3},
    routes::v3::utils::{permissions, sanctions},
    routes::templates::validate_template_scale,
};

pub async fn create(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<TemplateCreateV3>,
) -> Result<Json<TemplateCreated>, (StatusCode, String)> {
    // Enforcement: bans block all writes; PublishTemplates blocks template creation.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[
            (sanctions::Sanction::Ban, None),
            (sanctions::Sanction::PublishTemplates, body.clan_id),
        ],
    )
    .await?;

    // ── 1. Validate scope ────────────────────────────────────────────────────
    if !matches!(body.scope.as_str(), "private" | "clan" | "public") {
        return Err((
            StatusCode::BAD_REQUEST,
            "scope must be private|clan|public".to_string(),
        ));
    }

    // ── 2. Convert input to the-wall-dev/2 (passthrough for native v2) ───────
    let crate::formats::Converted { document: doc, warnings } =
        crate::formats::to_v2(
            &body.source.format,
            &body.source.document,
            auth.user_id,
            chrono::Utc::now(),
        )
        .map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;

    // ── 3. Extract primary layer from document.templates[0] ─────────────────
    let layer = doc
        .get("templates")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first())
        .ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "document.templates[0] is missing or invalid".to_string(),
            )
        })?;

    let name: String = layer
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "Untitled".to_string());

    let x: i32 = layer
        .get("x")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(0);

    let y: i32 = layer
        .get("y")
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(0);

    let scale_raw: f64 = layer
        .get("scale")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);

    // ── 4. Resolve clan_id (mirrors v2 create) ───────────────────────────────
    let is_global_admin = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .is_admin();

    let clan_id: Option<Uuid> = if body.scope == "clan" {
        let resolved = if let Some(c) = body.clan_id {
            Some(c)
        } else {
            sqlx::query_scalar(
                r#"SELECT clan_id FROM clan_memberships
                    WHERE user_id = $1 AND active = true
                    ORDER BY joined_at ASC
                    LIMIT 1"#,
            )
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        };

        let cid = resolved.ok_or_else(|| {
            (
                StatusCode::FORBIDDEN,
                "clan scope requires the caller to be a clan member".to_string(),
            )
        })?;

        // Verify membership unless global admin
        if !is_global_admin {
            let member: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM clan_memberships
                    WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
            )
            .bind(auth.user_id)
            .bind(cid)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            if member.is_none() {
                return Err((
                    StatusCode::FORBIDDEN,
                    "You are not a member of that clan".to_string(),
                ));
            }
        }

        Some(cid)
    } else {
        None
    };

    // ── 5a. Public publishing gate (allow_public_template_publishing) ────────
    if body.scope == "public" && !is_global_admin {
        let flag: Option<String> = sqlx::query_scalar(
            "SELECT value FROM server_config WHERE key = 'allow_public_template_publishing'",
        )
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        // Default is 'true' — only block when explicitly set to 'false'
        if flag.as_deref() == Some("false") {
            return Err((
                StatusCode::FORBIDDEN,
                "Public template publishing is currently disabled".to_string(),
            ));
        }
    }

    // ── 5b. Auto-approval ────────────────────────────────────────────────────
    let auto_approve = body.scope == "private"
        || permissions::publish_auto_approved(&state.pool, auth.user_id, &body.scope, clan_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let status = if auto_approve { "approved" } else { "pending" };

    // ── 6. Validate scale ────────────────────────────────────────────────────
    let scale = validate_template_scale(scale_raw)
        .map_err(|(st, msg)| (st, msg.to_string()))?;

    // ── 7. Fetch author username ─────────────────────────────────────────────
    let username: String = sqlx::query_scalar("SELECT username FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // ── 8. INSERT ────────────────────────────────────────────────────────────
    // `share` is NOT NULL in the schema (legacy column); v3 stores truth in
    // `document`. We write an empty string as a sentinel so the constraint
    // is satisfied without inventing fake legacy data.
    let row = sqlx::query_as::<_, TemplateV3>(
        r#"INSERT INTO templates
               (id, user_id, name, x, y, scale, scope, status, share,
                author, clan_id, document, version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '',
                   $9, $10, $11, 1, NOW())
           RETURNING id, user_id, name, x, y, scale, scope, status,
                     document, version, verified_by, verified_at,
                     rejection_reason, clan_id, author, created_at"#,
    )
    .bind(Uuid::new_v4())
    .bind(auth.user_id)
    .bind(&name)
    .bind(x)
    .bind(y)
    .bind(scale)
    .bind(&body.scope)
    .bind(status)
    .bind(&username)
    .bind(clan_id)
    .bind(doc)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(TemplateCreated { template: row, warnings }))
}
