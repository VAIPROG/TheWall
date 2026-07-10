//! Moderation template-approval queue — list pending, approve, reject.
//!
//! Authorization: global moderator+ only. This is the global moderation
//! queue, distinct from the per-template `/templates/{id}/verify` endpoint
//! which also permits clan moderators for clan-scoped templates.
//!
//!   GET  /api/v3/moderation/queue
//!   POST /api/v3/moderation/queue/{templateId}/approve
//!   POST /api/v3/moderation/queue/{templateId}/reject

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
    models::{ModAction, TemplatePage, TemplateSummary, TemplateV3},
    routes::v3::utils::{audit, permissions},
};

/// Columns for a TemplateV3 RETURNING clause (mirrors templates/verify.rs).
const COLS: &str = r#"
    id, user_id, name, x, y, scale, scope, status,
    document, version, verified_by, verified_at,
    rejection_reason, clan_id, author, created_at
"#;

#[derive(Debug, Deserialize)]
pub struct QueueQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/moderation/queue — pending templates, oldest first
// ---------------------------------------------------------------------------

pub async fn get_queue(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<QueueQuery>,
) -> Result<Json<TemplatePage>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM templates WHERE status = 'pending'")
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, TemplateSummary>(
        r#"SELECT id, user_id, name, x, y, scale, scope, status,
                  version, clan_id, verified_at, created_at,
                  (document IS NOT NULL) AS has_document
             FROM templates
            WHERE status = 'pending'
            ORDER BY created_at ASC
            LIMIT $1 OFFSET $2"#,
    )
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(TemplatePage { items: rows, page, per_page, total, total_pages }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/moderation/queue/{templateId}/approve
// ---------------------------------------------------------------------------

pub async fn approve_template(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ModAction>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;
    set_template_decision(&state, id, auth.user_id, true, body.notes.as_deref()).await
}

// ---------------------------------------------------------------------------
// POST /api/v3/moderation/queue/{templateId}/reject
// ---------------------------------------------------------------------------

pub async fn reject_template(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ModAction>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    permissions::require_moderator(&auth, &state.pool).await?;
    set_template_decision(&state, id, auth.user_id, false, body.notes.as_deref()).await
}

// ---------------------------------------------------------------------------
// Shared approve/reject implementation
// ---------------------------------------------------------------------------

async fn set_template_decision(
    state: &AppState,
    id: Uuid,
    mod_id: Uuid,
    approve: bool,
    notes: Option<&str>,
) -> Result<Json<TemplateV3>, (StatusCode, String)> {
    // Load owner + current status (404 if absent).
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "SELECT user_id, status FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (owner_id, prev_status) =
        row.ok_or_else(|| (StatusCode::NOT_FOUND, "template not found".to_string()))?;

    let updated: Option<TemplateV3> = if approve {
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
        .bind(mod_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
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
        .bind(mod_id)
        .bind(notes)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    let template = updated.ok_or_else(|| (StatusCode::NOT_FOUND, "template not found".to_string()))?;

    // Best-effort mailbox notification to the template owner.
    let (title, body_text, event_name) = if approve {
        ("Template approved", "Your template was approved by moderation.", "approved")
    } else {
        (
            "Template rejected",
            "Your template was rejected by moderation.",
            "rejected",
        )
    };
    let _ = sqlx::query(
        r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_user_id, title, body, payload)
           VALUES (gen_random_uuid(), 'template_event', $1, $2, $3, $4,
                   jsonb_build_object('template_id', $5::text, 'event', $6))"#,
    )
    .bind(mod_id)
    .bind(owner_id)
    .bind(title)
    .bind(body_text)
    .bind(id)
    .bind(event_name)
    .execute(&state.pool)
    .await;

    let action = if approve { "template_approved" } else { "template_rejected" };
    let _ = audit::log_action(
        &state.pool,
        mod_id,
        action,
        "template",
        &id.to_string(),
        json!({ "previousStatus": prev_status, "notes": notes, "ownerId": owner_id }),
    )
    .await;

    Ok(Json(template))
}
