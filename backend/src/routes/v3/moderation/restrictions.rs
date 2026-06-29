//! Restrictions CRUD — granular per-user sanctions.
//!
//! Authorization:
//!   - scope='global' → caller must be global moderator+
//!   - scope='clan'   → caller must be global moderator+ OR clan moderator+
//!
//! GET  /api/v3/restrictions                   list_restrictions   (global mod+)
//! POST /api/v3/restrictions                   create_restriction
//! GET  /api/v3/restrictions/{id}              get_restriction
//! PATCH /api/v3/restrictions/{id}             update_restriction
//! DELETE /api/v3/restrictions/{id}            delete_restriction
//! GET  /api/v3/users/{user_ref}/restrictions  user_restrictions

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
    models::{RestrictionCreate, RestrictionPage, RestrictionRow, RestrictionUpdate, RestrictionView},
    routes::v3::utils::{
        audit,
        permissions::{effective_clan_role, global_role_of},
        sanctions,
    },
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Load a restriction row by id; returns `(404, ...)` if absent.
async fn load_restriction(
    pool: &sqlx::PgPool,
    id: Uuid,
) -> Result<RestrictionRow, (StatusCode, String)> {
    sqlx::query_as::<_, RestrictionRow>(
        r#"SELECT id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                  reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                  s_send_reports, s_send_modmail, removed_at, removed_by, created_at
             FROM restrictions WHERE id = $1"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "restriction not found".to_string()))
}

/// Authorization check: may the caller manage a restriction of the given scope?
/// - global scope → caller must be global mod+
/// - clan scope   → caller must be global mod+ OR clan mod+ in the restriction's clan
async fn authorize_restriction(
    pool: &sqlx::PgPool,
    caller_id: Uuid,
    scope: &str,
    clan_id: Option<Uuid>,
) -> Result<(), (StatusCode, String)> {
    let global = global_role_of(pool, caller_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if global.is_moderator() {
        return Ok(());
    }

    if scope == "clan" {
        if let Some(cid) = clan_id {
            let effective = effective_clan_role(pool, caller_id, cid)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            if effective.map(|r| r.is_moderator()).unwrap_or(false) {
                return Ok(());
            }
        }
    }

    Err((StatusCode::FORBIDDEN, "moderator required".to_string()))
}


// ---------------------------------------------------------------------------
// Clan-ban sync helper
// ---------------------------------------------------------------------------

/// When a clan-scoped restriction carries the `ban` flag, the user is removed
/// from the clan and an explicit `clan_bans` row is kept so that later
/// join/apply attempts can be rejected with a clear message.
async fn apply_clan_ban(
    pool: &sqlx::PgPool,
    caller_id: Uuid,
    clan_id: Uuid,
    user_id: Uuid,
    reason: Option<&str>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        r#"INSERT INTO clan_bans (clan_id, user_id, banned_by, reason, banned_at, expires_at)
           VALUES ($1, $2, $3, $4, NOW(), $5)
           ON CONFLICT (clan_id, user_id) WHERE removed_at IS NULL
           DO UPDATE SET
               banned_by = EXCLUDED.banned_by,
               reason = EXCLUDED.reason,
               banned_at = NOW(),
               expires_at = EXCLUDED.expires_at,
               removed_at = NULL,
               removed_by = NULL"#,
    )
    .bind(clan_id)
    .bind(user_id)
    .bind(caller_id)
    .bind(reason)
    .bind(expires_at)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    sqlx::query(
        "DELETE FROM clan_memberships WHERE clan_id = $1 AND user_id = $2",
    )
    .bind(clan_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(())
}

async fn remove_clan_ban(
    pool: &sqlx::PgPool,
    caller_id: Uuid,
    clan_id: Uuid,
    user_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        r#"UPDATE clan_bans
              SET removed_at = NOW(), removed_by = $1
            WHERE clan_id = $2 AND user_id = $3 AND removed_at IS NULL"#,
    )
    .bind(caller_id)
    .bind(clan_id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Query structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct ListRestrictionsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub scope: Option<String>,
    pub user_id: Option<Uuid>,
    pub active: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct UserRestrictionsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/restrictions
// ---------------------------------------------------------------------------

pub async fn list_restrictions(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ListRestrictionsQuery>,
) -> Result<Json<RestrictionPage>, (StatusCode, String)> {
    let global = global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !global.is_moderator() {
        return Err((StatusCode::FORBIDDEN, "moderator required".to_string()));
    }

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let active_clause = match q.active {
        Some(true) => "AND removed_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())",
        Some(false) => "AND (removed_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= NOW()))",
        None => "",
    };

    let scope_filter = q.scope.as_deref();
    let user_filter = q.user_id;

    let count_sql = format!(
        r#"SELECT COUNT(*) FROM restrictions
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::uuid IS NULL OR user_id = $2)
              {active_clause}"#
    );
    let total: i64 = sqlx::query_scalar(&count_sql)
        .bind(scope_filter)
        .bind(user_filter)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows_sql = format!(
        r#"SELECT id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                  reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                  s_send_reports, s_send_modmail, removed_at, removed_by, created_at
             FROM restrictions
            WHERE ($1::text IS NULL OR scope = $1)
              AND ($2::uuid IS NULL OR user_id = $2)
              {active_clause}
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4"#
    );
    let rows = sqlx::query_as::<_, RestrictionRow>(&rows_sql)
        .bind(scope_filter)
        .bind(user_filter)
        .bind(per_page)
        .bind(offset)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let items = rows.into_iter().map(RestrictionView::from_row).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(RestrictionPage { items, page, per_page, total, total_pages }))
}

// ---------------------------------------------------------------------------
// POST /api/v3/restrictions
// ---------------------------------------------------------------------------

pub async fn create_restriction(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<RestrictionCreate>,
) -> Result<(StatusCode, Json<RestrictionView>), (StatusCode, String)> {
    if body.scope != "global" && body.scope != "clan" {
        return Err((StatusCode::BAD_REQUEST, "scope must be 'global' or 'clan'".to_string()));
    }
    if body.scope == "clan" && body.clan_id.is_none() {
        return Err((StatusCode::BAD_REQUEST, "clan_id required for clan scope".to_string()));
    }
    if let Some(ref r) = body.reason {
        if r.len() > 1000 {
            return Err((StatusCode::BAD_REQUEST, "reason must be \u{2264}1000 characters".to_string()));
        }
    }

    authorize_restriction(&state.pool, auth.user_id, &body.scope, body.clan_id).await?;

    // Use parameterized expires_at: bind an Option<chrono::DateTime<Utc>> directly.
    // expires_at = NOW() + duration when Some(mins > 0), else NULL.
    let expires_at: Option<chrono::DateTime<chrono::Utc>> = match body.duration_minutes {
        Some(mins) if mins > 0 => {
            let dur = chrono::Duration::minutes(mins);
            Some(chrono::Utc::now() + dur)
        }
        _ => None,
    };

    let row = sqlx::query_as::<_, RestrictionRow>(
        r#"INSERT INTO restrictions
               (id, user_id, scope, clan_id, applied_by, expires_at, reason,
                s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                s_send_reports, s_send_modmail)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5,
                   $6, $7, $8, $9, $10, $11, $12)
           RETURNING id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                     reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                     s_send_reports, s_send_modmail, removed_at, removed_by, created_at"#,
    )
    .bind(body.user_id)
    .bind(&body.scope)
    .bind(body.clan_id)
    .bind(auth.user_id)
    .bind(expires_at)
    .bind(body.reason.as_deref())
    .bind(body.sanctions.mute)
    .bind(body.sanctions.ban)
    .bind(body.sanctions.publish_templates)
    .bind(body.sanctions.invite_to_clan)
    .bind(body.sanctions.send_reports)
    .bind(body.sanctions.send_modmail)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if body.scope == "clan" && body.sanctions.ban {
        if let Some(cid) = body.clan_id {
            apply_clan_ban(&state.pool, auth.user_id, cid, body.user_id, body.reason.as_deref(), expires_at).await?;
        }
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "restriction_created",
        "user",
        &body.user_id.to_string(),
        json!({
            "scope": body.scope,
            "sanctions": {
                "mute": body.sanctions.mute,
                "ban": body.sanctions.ban,
                "publishTemplates": body.sanctions.publish_templates,
                "inviteToClan": body.sanctions.invite_to_clan,
                "sendReports": body.sanctions.send_reports,
                "sendModmail": body.sanctions.send_modmail,
            },
            "expiresAt": row.expires_at,
        }),
    )
    .await;

    Ok((StatusCode::CREATED, Json(RestrictionView::from_row(row))))
}

// ---------------------------------------------------------------------------
// GET /api/v3/restrictions/{id}
// ---------------------------------------------------------------------------

pub async fn get_restriction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<RestrictionView>, (StatusCode, String)> {
    let row = load_restriction(&state.pool, id).await?;
    authorize_restriction(&state.pool, auth.user_id, &row.scope, row.clan_id).await?;
    Ok(Json(RestrictionView::from_row(row)))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/restrictions/{id}
// ---------------------------------------------------------------------------

pub async fn update_restriction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(body): Json<RestrictionUpdate>,
) -> Result<Json<RestrictionView>, (StatusCode, String)> {
    let existing = load_restriction(&state.pool, id).await?;
    authorize_restriction(&state.pool, auth.user_id, &existing.scope, existing.clan_id).await?;

    if let Some(ref r) = body.reason {
        if r.len() > 1000 {
            return Err((StatusCode::BAD_REQUEST, "reason must be \u{2264}1000 characters".to_string()));
        }
    }

    // Only update if at least one field is provided
    if body.duration_minutes.is_some() || body.reason.is_some() || body.sanctions.is_some() {
        use sqlx::QueryBuilder;
        let mut qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new("UPDATE restrictions SET ");
        let mut first = true;

        if let Some(mins) = body.duration_minutes {
            if !first { qb.push(", "); }
            first = false;
            if mins > 0 {
                // Compute the new expiry and bind it as a parameter
                let new_expires = chrono::Utc::now() + chrono::Duration::minutes(mins);
                qb.push("expires_at = ");
                qb.push_bind(new_expires);
            } else {
                qb.push("expires_at = NULL");
            }
        }

        if let Some(ref reason) = body.reason {
            if !first { qb.push(", "); }
            first = false;
            qb.push("reason = ");
            qb.push_bind(reason.clone());
        }

        if let Some(ref s) = body.sanctions {
            if !first { qb.push(", "); }
            qb.push("s_mute = ");
            qb.push_bind(s.mute);
            qb.push(", s_ban = ");
            qb.push_bind(s.ban);
            qb.push(", s_publish_templates = ");
            qb.push_bind(s.publish_templates);
            qb.push(", s_invite_to_clan = ");
            qb.push_bind(s.invite_to_clan);
            qb.push(", s_send_reports = ");
            qb.push_bind(s.send_reports);
            qb.push(", s_send_modmail = ");
            qb.push_bind(s.send_modmail);
        }

        qb.push(" WHERE id = ");
        qb.push_bind(id);

        qb.build()
            .execute(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    let updated = load_restriction(&state.pool, id).await?;

    // Sync clan_ban state when the ban flag or scope changes.
    if updated.scope == "clan" {
        let had_ban = existing.s_ban;
        let now_ban = updated.s_ban;
        if let Some(cid) = updated.clan_id {
            if !had_ban && now_ban {
                apply_clan_ban(&state.pool, auth.user_id, cid, updated.user_id, updated.reason.as_deref(), updated.expires_at).await?;
            } else if had_ban && !now_ban {
                remove_clan_ban(&state.pool, auth.user_id, cid, updated.user_id).await?;
            } else if now_ban && body.duration_minutes.is_some() {
                // Expiry changed while ban remains active — refresh clan_bans.
                apply_clan_ban(&state.pool, auth.user_id, cid, updated.user_id, updated.reason.as_deref(), updated.expires_at).await?;
            }
        }
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "restriction_updated",
        "restriction",
        &id.to_string(),
        json!({ "changes": { "durationMinutes": body.duration_minutes, "reason": body.reason } }),
    )
    .await;

    Ok(Json(RestrictionView::from_row(updated)))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/restrictions/{id}
// ---------------------------------------------------------------------------

pub async fn delete_restriction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let existing = load_restriction(&state.pool, id).await?;
    authorize_restriction(&state.pool, auth.user_id, &existing.scope, existing.clan_id).await?;

    sqlx::query(
        "UPDATE restrictions SET removed_at = NOW(), removed_by = $1 WHERE id = $2",
    )
    .bind(auth.user_id)
    .bind(id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if existing.scope == "clan" && existing.s_ban {
        if let Some(cid) = existing.clan_id {
            remove_clan_ban(&state.pool, auth.user_id, cid, existing.user_id).await?;
        }
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "restriction_removed",
        "restriction",
        &id.to_string(),
        json!({ "userId": existing.user_id }),
    )
    .await;

    Ok(Json(json!({ "ok": true, "message": "restriction removed" })))
}

// ---------------------------------------------------------------------------
// GET /api/v3/users/{user_ref}/restrictions
// ---------------------------------------------------------------------------

pub async fn user_restrictions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Query(q): Query<UserRestrictionsQuery>,
) -> Result<Json<RestrictionPage>, (StatusCode, String)> {
    let target_id = if let Ok(uid) = Uuid::parse_str(&user_ref) {
        let exists: Option<bool> = sqlx::query_scalar("SELECT TRUE FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if exists.is_none() {
            return Err((StatusCode::NOT_FOUND, "user not found".to_string()));
        }
        uid
    } else {
        let row: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM users WHERE lower(username) = lower($1)")
                .bind(&user_ref)
                .fetch_optional(&state.pool)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        row.map(|(id,)| id)
            .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?
    };

    if target_id != auth.user_id {
        let global = global_role_of(&state.pool, auth.user_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if !global.is_moderator() {
            return Err((StatusCode::FORBIDDEN, "moderator required to view another user's restrictions".to_string()));
        }
    }

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM restrictions WHERE user_id = $1",
    )
    .bind(target_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let rows = sqlx::query_as::<_, RestrictionRow>(
        r#"SELECT id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                  reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                  s_send_reports, s_send_modmail, removed_at, removed_by, created_at
             FROM restrictions
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2 OFFSET $3"#,
    )
    .bind(target_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let items = rows.into_iter().map(RestrictionView::from_row).collect();
    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(RestrictionPage { items, page, per_page, total, total_pages }))
}
