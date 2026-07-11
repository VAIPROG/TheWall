//! POST /api/v3/templates/{id}/verify
//!
//! Approve or reject a V3 template. Authorisation:
//!   - Global admin/owner may verify any template.
//!   - For clan-scoped templates, a clan moderator+ of the template's clan may verify.
//!   - Anyone else gets 403.
//!
//! On success the updated TemplateV3 row is returned and a best-effort mailbox
//! `template_event` is inserted to notify the template owner.
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
    models::{TemplateV3, TemplateVerifyRequest},
    routes::v3::{notifications, utils::permissions},
};

/// Columns for every TemplateV3 RETURNING clause (mirrors read.rs).
const COLS: &str = r#"
    id, user_id, name, x, y, scale, scope, status,
    document, version, verified_by, verified_at,
    rejection_reason, clan_id, author, created_at
"#;

pub async fn verify(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<TemplateVerifyRequest>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    // ── 1. Validate decision ─────────────────────────────────────────────────
    if !matches!(body.decision.as_str(), "approve" | "reject") {
        return Err((
            StatusCode::BAD_REQUEST,
            "decision must be \"approve\" or \"reject\"".to_string(),
        ));
    }

    // ── 2. Load the template ─────────────────────────────────────────────────
    let row: Option<(Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT user_id, scope, clan_id FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;

    let (owner_id, scope, clan_id) = row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    // ── 3. Authorise ─────────────────────────────────────────────────────────
    let global_role = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .or_500()?;
    let is_global_admin = global_role.is_admin();

    let is_clan_mod = if !is_global_admin && scope == "clan" {
        if let Some(cid) = clan_id {
            permissions::effective_clan_role(&state.pool, auth.user_id, cid)
                .await
                .or_500()?
                .map(|r| r.is_moderator())
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    if !is_global_admin && !is_clan_mod {
        return Err((StatusCode::FORBIDDEN, "forbidden".into()));
    }

    // ── 4. Apply the decision ─────────────────────────────────────────────────
    let updated: Option<TemplateV3> = if body.decision == "approve" {
        sqlx::query_as::<_, TemplateV3>(&format!(
            r#"UPDATE templates
                  SET status = 'approved',
                      verified_by = $2,
                      verified_at = NOW(),
                      rejection_reason = NULL
                WHERE id = $1
            RETURNING {COLS}"#
        ))
        .bind(id)
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?
    } else {
        // "reject"
        sqlx::query_as::<_, TemplateV3>(&format!(
            r#"UPDATE templates
                  SET status = 'rejected',
                      verified_by = $2,
                      verified_at = NOW(),
                      rejection_reason = $3
                WHERE id = $1
            RETURNING {COLS}"#
        ))
        .bind(id)
        .bind(auth.user_id)
        .bind(body.reason.as_deref())
        .fetch_optional(&state.pool)
        .await
        .or_500()?
    };

    let template = updated.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    // ── 5. Mailbox + notification center (best-effort) ───────────────────────
    let (title, body_text, event_name) = if body.decision == "approve" {
        ("Template approved", "Your template was approved.", "approved")
    } else {
        ("Template rejected", "Your template was rejected.", "rejected")
    };

    sqlx::query(
        r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_user_id, title, body, payload)
           VALUES (gen_random_uuid(), 'template_event', $1, $2,
                   $3, $4,
                   jsonb_build_object('template_id', $5::text, 'event', $6))"#,
    )
    .bind(auth.user_id)
    .bind(owner_id)
    .bind(title)
    .bind(body_text)
    .bind(id)
    .bind(event_name)
    .execute(&state.pool)
    .await
    .ok();

    let action_url = format!("/templates/{id}");
    let metadata = serde_json::json!({
        "templateId": id.to_string(),
        "decision": body.decision,
        "rejectionReason": body.reason,
    });
    let _ = notifications::notify(
        &state.pool,
        owner_id,
        "template_status_change",
        title,
        Some(body_text),
        Some(&action_url),
        metadata,
    )
    .await;

    Ok(Json(template))
}
