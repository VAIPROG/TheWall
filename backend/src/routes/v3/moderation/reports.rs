//! Moderation report queue — list/get/update/resolve/dismiss.
//!
//! Authorization: global moderator+ for every operation. Regular users
//! submit reports via the resource-specific endpoints (chats/.../report,
//! clans/.../report, templates/.../report); this module is the
//! moderator-facing review surface.
//!
//!   GET   /api/v3/moderation/reports
//!   GET   /api/v3/moderation/reports/{id}
//!   PATCH /api/v3/moderation/reports/{id}
//!   POST  /api/v3/moderation/reports/{id}/resolve
//!   POST  /api/v3/moderation/reports/{id}/dismiss

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
    models::{ReportDismiss, ReportPage, ReportResolve, ReportRow, ReportUpdate, ReportView},
    routes::v3::utils::{audit, permissions::global_role_of},
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Moderator+ gate. Returns 403 for anyone below global moderator.
async fn require_moderator(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    let role = global_role_of(pool, user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if role.is_moderator() {
        Ok(())
    } else {
        Err((StatusCode::FORBIDDEN, "moderator required".to_string()))
    }
}

/// Column list shared by every report SELECT.
const REPORT_COLS: &str = r#"
    r.id, r.type, r.target_id, r.clan_id, r.reporter_id, r.reason, r.evidence,
    r.status, r.assigned_mod_id, r.resolution, r.notes, r.created_at, r.updated_at,
    r.resolved_by, r.resolved_at, u.username AS reporter_username
"#;

/// Load a single report by id (with reporter username joined).
async fn load_report(
    pool: &sqlx::PgPool,
    id: Uuid,
) -> Result<ReportRow, (StatusCode, String)> {
    let sql = format!(
        r#"SELECT {REPORT_COLS}
             FROM reports r
             LEFT JOIN users u ON u.id = r.reporter_id
            WHERE r.id = $1"#
    );
    sqlx::query_as::<_, ReportRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "report not found".to_string()))
}

/// Resolve a `target_id` to the user account that should be restricted when a
/// report is resolved with `createRestriction: true`.
///
/// - `user`   → the target_id itself is the user UUID.
/// - `message`→ the message author.
/// - `template`→ the template owner.
/// - `clan`   → None (clans are actioned via takedown, not user restrictions).
async fn resolve_restriction_target(
    pool: &sqlx::PgPool,
    report_type: &str,
    target_id: &str,
) -> Result<Option<Uuid>, (StatusCode, String)> {
    let uid = match report_type {
        "user" => Uuid::parse_str(target_id).ok(),
        "message" => {
            sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT author_id FROM messages WHERE id = $1",
            )
            .bind(target_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .flatten()
        }
        "template" => {
            sqlx::query_scalar::<_, Option<Uuid>>(
                "SELECT user_id FROM templates WHERE id = $1",
            )
            .bind(target_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .flatten()
        }
        _ => None, // clan — no user restriction
    };
    Ok(uid)
}

// ---------------------------------------------------------------------------
// Query structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ListReportsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub status: Option<String>,
    #[serde(rename = "type")]
    pub report_type: Option<String>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/moderation/reports
// ---------------------------------------------------------------------------

pub async fn list_reports(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListReportsQuery>,
) -> Result<Json<ReportPage>, (StatusCode, String)> {
    require_moderator(&state.pool, auth.user_id).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let count_sql = r#"SELECT COUNT(*) FROM reports
                        WHERE ($1::text IS NULL OR status = $1)
                          AND ($2::text IS NULL OR type = $2)"#;
    let total: i64 = sqlx::query_scalar(count_sql)
        .bind(q.status.as_deref())
        .bind(q.report_type.as_deref())
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows_sql = format!(
        r#"SELECT {REPORT_COLS}
             FROM reports r
             LEFT JOIN users u ON u.id = r.reporter_id
            WHERE ($1::text IS NULL OR r.status = $1)
              AND ($2::text IS NULL OR r.type = $2)
            ORDER BY r.created_at DESC
            LIMIT $3 OFFSET $4"#
    );
    let rows = sqlx::query_as::<_, ReportRow>(&rows_sql)
        .bind(q.status.as_deref())
        .bind(q.report_type.as_deref())
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let items = rows.into_iter().map(ReportView::from_row).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(ReportPage { items, page, per_page, total, total_pages }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/moderation/reports/{id}
// ---------------------------------------------------------------------------

pub async fn get_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<ReportView>, (StatusCode, String)> {
    require_moderator(&state.pool, auth.user_id).await?;
    let row = load_report(&state.pool, id).await?;
    Ok(Json(ReportView::from_row(row)))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/moderation/reports/{id}
// ---------------------------------------------------------------------------

pub async fn update_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReportUpdate>,
) -> Result<Json<ReportView>, (StatusCode, String)> {
    require_moderator(&state.pool, auth.user_id).await?;
    load_report(&state.pool, id).await?; // 404 if absent

    if let Some(ref s) = body.status {
        if !matches!(s.as_str(), "open" | "reviewing" | "resolved" | "dismissed") {
            return Err((StatusCode::BAD_REQUEST, "invalid status".to_string()));
        }
    }
    if let Some(ref n) = body.notes {
        if n.len() > 1000 {
            return Err((StatusCode::BAD_REQUEST, "notes must be \u{2264}1000 characters".to_string()));
        }
    }

    use sqlx::QueryBuilder;
    let mut qb: QueryBuilder<sqlx::Postgres> =
        QueryBuilder::new("UPDATE reports SET updated_at = NOW()");
    if let Some(ref s) = body.status {
        qb.push(", status = ").push_bind(s.clone());
        if s == "reviewing" && body.assigned_mod_id.is_none() {
            // Auto-assign the acting moderator when moving to reviewing
            // without an explicit assignment.
            qb.push(", assigned_mod_id = ").push_bind(auth.user_id);
        }
    }
    if let Some(uid) = body.assigned_mod_id {
        qb.push(", assigned_mod_id = ").push_bind(uid);
    }
    if let Some(ref n) = body.notes {
        qb.push(", notes = ").push_bind(n.clone());
    }
    qb.push(" WHERE id = ").push_bind(id);

    qb.build()
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let row = load_report(&state.pool, id).await?;
    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "report_updated",
        "report",
        &id.to_string(),
        json!({ "status": body.status, "assignedModId": body.assigned_mod_id }),
    )
    .await;

    Ok(Json(ReportView::from_row(row)))
}

// ---------------------------------------------------------------------------
// POST /api/v3/moderation/reports/{id}/resolve
// ---------------------------------------------------------------------------

pub async fn resolve_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReportResolve>,
) -> Result<Json<ReportView>, (StatusCode, String)> {
    require_moderator(&state.pool, auth.user_id).await?;
    let existing = load_report(&state.pool, id).await?;

    if !matches!(
        body.resolution.as_str(),
        "content_removed" | "no_action_needed" | "user_warned" | "user_restricted" | "other"
    ) {
        return Err((StatusCode::BAD_REQUEST, "invalid resolution".to_string()));
    }
    if let Some(ref n) = body.notes {
        if n.len() > 1000 {
            return Err((StatusCode::BAD_REQUEST, "notes must be \u{2264}1000 characters".to_string()));
        }
    }

    // Optionally create a restriction on the reported user.
    let mut restriction_id: Option<Uuid> = None;
    if body.create_restriction {
        if let Some(target_uid) =
            resolve_restriction_target(&state.pool, &existing.report_type, &existing.target_id)
                .await?
        {
            let reason_text = format!(
                "resolved report {} as {}",
                existing.id,
                body.resolution
            );
            let new_id: Uuid = sqlx::query_scalar(
                r#"INSERT INTO restrictions
                       (id, user_id, scope, applied_by, reason, s_ban)
                   VALUES (gen_random_uuid(), $1, 'global', $2, $3, TRUE)
                   RETURNING id"#,
            )
            .bind(target_uid)
            .bind(auth.user_id)
            .bind(reason_text)
            .fetch_one(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            restriction_id = Some(new_id);
        }
        // clan reports: no user restriction — takedown is the clan path.
    }

    sqlx::query(
        r#"UPDATE reports
              SET status = 'resolved',
                  resolution = $2,
                  notes = COALESCE($3, notes),
                  resolved_by = $4,
                  resolved_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1"#,
    )
    .bind(id)
    .bind(&body.resolution)
    .bind(body.notes.as_deref())
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let row = load_report(&state.pool, id).await?;
    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "report_resolved",
        "report",
        &id.to_string(),
        json!({
            "resolution": body.resolution,
            "restrictionId": restriction_id,
            "reportType": existing.report_type,
            "targetId": existing.target_id,
        }),
    )
    .await;

    Ok(Json(ReportView::from_row(row)))
}

// ---------------------------------------------------------------------------
// POST /api/v3/moderation/reports/{id}/dismiss
// ---------------------------------------------------------------------------

pub async fn dismiss_report(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<ReportDismiss>,
) -> Result<Json<ReportView>, (StatusCode, String)> {
    require_moderator(&state.pool, auth.user_id).await?;
    let existing = load_report(&state.pool, id).await?;

    if let Some(ref r) = body.reason {
        if !matches!(r.as_str(), "duplicate" | "false_report" | "not_actionable" | "other") {
            return Err((StatusCode::BAD_REQUEST, "invalid dismiss reason".to_string()));
        }
    }

    let dismiss_note = body.reason.unwrap_or_else(|| "other".to_string());
    sqlx::query(
        r#"UPDATE reports
              SET status = 'dismissed',
                  resolution = $2,
                  resolved_by = $3,
                  resolved_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1"#,
    )
    .bind(id)
    .bind(&dismiss_note)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let row = load_report(&state.pool, id).await?;
    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "report_dismissed",
        "report",
        &id.to_string(),
        json!({ "reason": dismiss_note, "reportType": existing.report_type }),
    )
    .await;

    Ok(Json(ReportView::from_row(row)))
}
