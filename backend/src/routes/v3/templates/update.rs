//! PATCH /api/v3/templates/{id}
//!
//! Flexible partial edit of a stored V3 template. Supports:
//!   - doc-level metadata (notes, contacts, access, authorVisibility, name)
//!   - layer operations (add, remove, move, update) on document.templates[]
//!   - scope / clan_id changes (owner only, same membership rules as create)
//!   - optimistic concurrency via expectedVersion → 409 on mismatch
//!
//! Authorization:
//!   - Owner (user_id == auth.user_id) always allowed.
//!   - Global admin/owner (global_role_of().is_admin()) always allowed.
//!   - Anyone else → 403.
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{TemplatePatchV3, TemplateV3},
    routes::templates::validate_template_scale,
    routes::v3::utils::permissions,
};

use super::patch_apply::apply_patch;

/// Columns for every TemplateV3 RETURNING clause (mirrors read.rs / verify.rs).
const COLS: &str = r#"
    id, user_id, name, x, y, scale, scope, status,
    document, version, verified_by, verified_at,
    rejection_reason, clan_id, author, created_at
"#;

pub async fn update(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<TemplatePatchV3>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    // ── 1. Load row ──────────────────────────────────────────────────────────
    let row: Option<(Uuid, i32, Option<serde_json::Value>, String, Option<Uuid>, i32, i32, f64, String)> =
        sqlx::query_as(
            "SELECT user_id, version, document, scope, clan_id, x, y, scale, name \
             FROM templates WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?;

    let (owner_id, version, document_opt, row_scope, row_clan_id, row_x, row_y, row_scale, row_name) =
        row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    // ── 2. Authz ─────────────────────────────────────────────────────────────
    let is_owner = owner_id == auth.user_id;
    let is_global_admin = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .or_500()?
        .is_admin();

    if !is_owner && !is_global_admin {
        return Err((StatusCode::FORBIDDEN, "forbidden".into()));
    }

    // ── 3. Optimistic concurrency ────────────────────────────────────────────
    if let Some(ev) = body.expected_version {
        if ev != version {
            return Err((StatusCode::CONFLICT, "version mismatch".into()));
        }
    }

    // ── 4. Document must be present ──────────────────────────────────────────
    let mut doc = document_opt.ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "template has no v2 document yet — run backfill".to_string(),
        )
    })?;

    // ── 5. Apply patch ───────────────────────────────────────────────────────
    apply_patch(
        &mut doc,
        &body.doc,
        &body.layer_ops,
        &chrono::Utc::now().to_rfc3339(),
    )
    .map_err(|msg| (StatusCode::BAD_REQUEST, msg))?;

    // ── 6. Derive updated flat columns from templates[0] ────────────────────
    let layer0 = doc
        .get("templates")
        .and_then(|t| t.as_array())
        .and_then(|arr| arr.first());

    let new_name: String = layer0
        .and_then(|l| l.get("name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or(row_name);

    let new_x: i32 = layer0
        .and_then(|l| l.get("x"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(row_x);

    let new_y: i32 = layer0
        .and_then(|l| l.get("y"))
        .and_then(|v| v.as_i64())
        .map(|v| v as i32)
        .unwrap_or(row_y);

    let raw_scale: f64 = layer0
        .and_then(|l| l.get("scale"))
        .and_then(|v| v.as_f64())
        .unwrap_or(row_scale);

    let new_scale = validate_template_scale(raw_scale)
        .map_err(|(st, msg)| (st, msg.to_string()))?;

    // ── 7. Resolve scope / clan_id changes ───────────────────────────────────
    // Only the owner may change scope/clan (admins editing another user's
    // template do not get to re-scope it on their behalf).
    let (new_scope, new_clan_id) = if let Some(ref requested_scope) = body.scope {
        if !is_owner && !is_global_admin {
            return Err((
                StatusCode::FORBIDDEN,
                "only the owner may change scope".into(),
            ));
        }
        if !matches!(requested_scope.as_str(), "private" | "clan" | "public") {
            return Err((
                StatusCode::BAD_REQUEST,
                "scope must be private|clan|public".to_string(),
            ));
        }

        let clan_id: Option<Uuid> = if requested_scope == "clan" {
            let resolved = if let Some(c) = body.clan_id {
                Some(c)
            } else if row_scope == "clan" {
                row_clan_id
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
                .or_500()?
            };

            let cid = resolved.ok_or_else(|| {
                (
                    StatusCode::FORBIDDEN,
                    "clan scope requires the caller to be a clan member".to_string(),
                )
            })?;

            // Verify membership (unless global admin)
            if !is_global_admin {
                let member: Option<bool> = sqlx::query_scalar(
                    r#"SELECT TRUE FROM clan_memberships
                        WHERE user_id = $1 AND clan_id = $2 AND active = true"#,
                )
                .bind(auth.user_id)
                .bind(cid)
                .fetch_optional(&state.pool)
                .await
                .or_500()?;

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

        (requested_scope.clone(), clan_id)
    } else {
        // No scope change requested — keep current values.
        (row_scope, row_clan_id)
    };

    // ── 8. UPDATE ────────────────────────────────────────────────────────────
    let raw_password = body.access_password.as_deref().map(str::trim);
    let clear_password = raw_password == Some("");
    let pass_hash = raw_password
        .filter(|p| !p.is_empty())
        .map(crate::auth::hash_token);

    let updated: Option<TemplateV3> = sqlx::query_as::<_, TemplateV3>(&format!(
        r#"UPDATE templates
              SET document  = $2,
                  version   = version + 1,
                  name      = $3,
                  x         = $4,
                  y         = $5,
                  scale     = $6,
                  scope     = $7,
                  clan_id   = $8,
                  access_password_hash = CASE
                      WHEN $9 = TRUE THEN NULL
                      WHEN $10 IS NOT NULL THEN $10
                      ELSE access_password_hash
                  END
            WHERE id = $1
        RETURNING {COLS}"#
    ))
    .bind(id)
    .bind(&doc)
    .bind(&new_name)
    .bind(new_x)
    .bind(new_y)
    .bind(new_scale)
    .bind(&new_scope)
    .bind(new_clan_id)
    .bind(clear_password)
    .bind(pass_hash)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let template = updated.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    Ok(Json(template))
}
