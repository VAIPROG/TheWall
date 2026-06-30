//! V3 admin endpoints for user management and audit.
//!
//! Authorisation:
//!   - global moderator+ for ban/mute, reset-avatar, reset-username,
//!     remove-from-clan, admin audit log
//!   - global admin+ for admin user view/update and promote to moderator
//!   - global owner for promote to admin/owner and wipeout

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{
        auth::SessionSummary,
        moderation::{AuditLogEntry, AuditLogPage, AuditLogRow, RestrictionRow, RestrictionView},
        users::User,
    },
    routes::v3::utils::{audit, permissions::global_role_of},
};

use crate::routes::v3::utils::permissions::GlobalRole;

async fn require_role(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    min: GlobalRole,
) -> Result<GlobalRole, (StatusCode, String)> {
    let role = global_role_of(pool, user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if role < min {
        return Err((StatusCode::FORBIDDEN, "insufficient role".to_string()));
    }
    Ok(role)
}

async fn resolve_user_ref(
    pool: &sqlx::PgPool,
    user_ref: &str,
) -> Result<Uuid, (StatusCode, String)> {
    if let Ok(uid) = Uuid::parse_str(user_ref) {
        let exists: Option<bool> = sqlx::query_scalar("SELECT TRUE FROM users WHERE id = $1")
            .bind(uid)
            .fetch_optional(pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if exists.is_some() {
            return Ok(uid);
        }
    }
    let row: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE lower(username) = lower($1)")
        .bind(user_ref)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    row.map(|(id,)| id)
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))
}

async fn load_user(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Option<User>, (StatusCode, String)> {
    sqlx::query_as::<_, User>(
        r#"SELECT id, external_id, username, discord_id, discord_username, role,
                  global_role, source, preferred_lang, bio, social_links,
                  telemetry_opt_in, created_at, updated_at, display_name
             FROM users
            WHERE id = $1"#,
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/users/{userRef}
// ---------------------------------------------------------------------------

pub async fn admin_get_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<User>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;
    let user = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;
    Ok(Json(user))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/admin/users/{userRef}
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserUpdate {
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub role: Option<String>,
    pub lang: Option<String>,
    pub telemetry_opt_in: Option<bool>,
}

pub async fn admin_update_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<AdminUserUpdate>,
) -> Result<Json<User>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    if let Some(ref role) = body.role {
        if !matches!(role.as_str(), "member" | "moderator" | "admin" | "owner") {
            return Err((StatusCode::BAD_REQUEST, "invalid role".to_string()));
        }
    }

    sqlx::query(
        "UPDATE users SET
            username = COALESCE($1, username),
            display_name = COALESCE($2, display_name),
            bio = COALESCE($3, bio),
            global_role = COALESCE($4, global_role),
            preferred_lang = COALESCE($5, preferred_lang),
            telemetry_opt_in = COALESCE($6, telemetry_opt_in),
            updated_at = NOW()
         WHERE id = $7",
    )
    .bind(body.username.as_deref())
    .bind(body.display_name.as_deref())
    .bind(body.bio.as_deref())
    .bind(body.role.as_deref())
    .bind(body.lang.as_deref())
    .bind(body.telemetry_opt_in)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_user_updated",
        "user",
        &target_id.to_string(),
        json!({ "role": body.role, "username": body.username }),
    )
    .await;

    let user = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;
    Ok(Json(user))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/ban
// DELETE /api/v3/admin/users/{userRef}/ban
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BanRequest {
    pub reason: Option<String>,
    pub duration_minutes: Option<i64>,
}

pub async fn admin_ban_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<BanRequest>,
) -> Result<Json<RestrictionView>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    if target_id == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot ban yourself".to_string()));
    }

    let reason = body.reason.unwrap_or_else(|| "admin ban".to_string());
    let expires_at = body.duration_minutes.map(|m| Utc::now() + chrono::Duration::minutes(m));

    let row: RestrictionRow = sqlx::query_as(
        r#"INSERT INTO restrictions
               (id, user_id, scope, applied_by, reason, expires_at, s_ban)
           VALUES (gen_random_uuid(), $1, 'global', $2, $3, $4, TRUE)
           RETURNING id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                    reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                    s_send_reports, s_send_modmail, removed_at, removed_by, created_at"#,
    )
    .bind(target_id)
    .bind(auth.user_id)
    .bind(&reason)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_ban_applied",
        "user",
        &target_id.to_string(),
        json!({ "reason": reason, "expiresAt": expires_at }),
    )
    .await;

    Ok(Json(RestrictionView::from_row(row)))
}

pub async fn admin_unban_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let result = sqlx::query(
        "UPDATE restrictions SET removed_at = NOW(), removed_by = $1
          WHERE user_id = $2 AND scope = 'global' AND s_ban = TRUE AND removed_at IS NULL",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "active ban not found".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_ban_removed",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "unbanned"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/mute
// DELETE /api/v3/admin/users/{userRef}/mute
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MuteRequest {
    pub reason: Option<String>,
    pub duration_minutes: Option<i64>,
}

pub async fn admin_mute_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<MuteRequest>,
) -> Result<Json<RestrictionView>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    if target_id == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot mute yourself".to_string()));
    }

    let reason = body.reason.unwrap_or_else(|| "admin mute".to_string());
    let expires_at = body.duration_minutes.map(|m| Utc::now() + chrono::Duration::minutes(m));

    let row: RestrictionRow = sqlx::query_as(
        r#"INSERT INTO restrictions
               (id, user_id, scope, applied_by, reason, expires_at, s_mute)
           VALUES (gen_random_uuid(), $1, 'global', $2, $3, $4, TRUE)
           RETURNING id, user_id, scope, clan_id, applied_by, applied_at, expires_at,
                    reason, s_mute, s_ban, s_publish_templates, s_invite_to_clan,
                    s_send_reports, s_send_modmail, removed_at, removed_by, created_at"#,
    )
    .bind(target_id)
    .bind(auth.user_id)
    .bind(&reason)
    .bind(expires_at)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_mute_applied",
        "user",
        &target_id.to_string(),
        json!({ "reason": reason, "expiresAt": expires_at }),
    )
    .await;

    Ok(Json(RestrictionView::from_row(row)))
}

pub async fn admin_unmute_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let result = sqlx::query(
        "UPDATE restrictions SET removed_at = NOW(), removed_by = $1
          WHERE user_id = $2 AND scope = 'global' AND s_mute = TRUE AND removed_at IS NULL",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "active mute not found".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_mute_removed",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "unmuted"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/promote
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromoteRequest {
    pub role: String,
}

pub async fn admin_promote_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<PromoteRequest>,
) -> Result<Json<User>, (StatusCode, String)> {
    let caller_role = require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let new_role = match body.role.as_str() {
        "member" | "user" => GlobalRole::User,
        "moderator" => GlobalRole::Moderator,
        "admin" => GlobalRole::Admin,
        "owner" => GlobalRole::Owner,
        _ => return Err((StatusCode::BAD_REQUEST, "invalid role".to_string())),
    };

    if new_role >= GlobalRole::Admin && caller_role != GlobalRole::Owner {
        return Err((StatusCode::FORBIDDEN, "only owner can promote to admin or owner".to_string()));
    }

    sqlx::query("UPDATE users SET global_role = $1, updated_at = NOW() WHERE id = $2")
        .bind(&body.role)
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_promote",
        "user",
        &target_id.to_string(),
        json!({ "role": body.role }),
    )
    .await;

    let user = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;
    Ok(Json(user))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/wipeout
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmationRequest {
    pub confirmation: String,
}

pub async fn admin_wipeout_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<ConfirmationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Owner).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    if body.confirmation != "WIPEOUT" {
        return Err((StatusCode::BAD_REQUEST, "confirmation required".to_string()));
    }

    sqlx::query("DELETE FROM templates WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    sqlx::query("DELETE FROM messages WHERE author_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_wipeout",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "wiped out"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/remove-from-clan
// ---------------------------------------------------------------------------

pub async fn admin_remove_from_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let result = sqlx::query("DELETE FROM clan_memberships WHERE user_id = $1 AND active = TRUE")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_remove_from_clan",
        "user",
        &target_id.to_string(),
        json!({ "membershipsRemoved": result.rows_affected() }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "removed from clan"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/reset-avatar
// ---------------------------------------------------------------------------

pub async fn admin_reset_avatar(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_reset_avatar",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "avatar reset"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/reset-username
// ---------------------------------------------------------------------------

pub async fn admin_reset_username(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let suffix: String = target_id.to_string().replace('-', "").chars().take(8).collect();
    let new_username = format!("user_{}", suffix);
    sqlx::query("UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2")
        .bind(&new_username)
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_reset_username",
        "user",
        &target_id.to_string(),
        json!({ "newUsername": new_username }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "username reset", "newUsername": new_username})))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/users/{userRef}/sessions
// DELETE /api/v3/admin/users/{userRef}/sessions
// ---------------------------------------------------------------------------

pub async fn admin_get_user_sessions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<Vec<SessionSummary>>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let rows: Vec<SessionSummary> = sqlx::query_as(
        r#"SELECT id AS session_id, ip::TEXT AS ip, user_agent, created_at, last_activity AS last_activity_at
             FROM sessions
            WHERE user_id = $1
         ORDER BY created_at DESC"#,
    )
    .bind(target_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

pub async fn admin_terminate_user_sessions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let result = sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_terminate_sessions",
        "user",
        &target_id.to_string(),
        json!({ "count": result.rows_affected() }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "sessions terminated", "count": result.rows_affected()})))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/users/{userRef}/notes
// POST /api/v3/admin/users/{userRef}/notes
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminNoteCreate {
    pub content: String,
}

#[derive(Debug, Clone, Serialize, FromRow)]
#[serde(rename_all = "camelCase")]
pub struct AdminNote {
    pub id: Uuid,
    pub author_id: Uuid,
    pub author_username: Option<String>,
    pub content: String,
    pub created_at: DateTime<Utc>,
}

pub async fn admin_get_user_notes(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<Vec<AdminNote>>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let rows: Vec<AdminNote> = sqlx::query_as(
        r#"SELECT n.id, n.author_id, u.username AS author_username, n.content, n.created_at
             FROM admin_notes n
             LEFT JOIN users u ON u.id = n.author_id
            WHERE n.user_id = $1
         ORDER BY n.created_at DESC"#,
    )
    .bind(target_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}

pub async fn admin_add_user_note(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<AdminNoteCreate>,
) -> Result<Json<AdminNote>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let content = body.content.trim();
    if content.is_empty() || content.len() > 2000 {
        return Err((StatusCode::BAD_REQUEST, "content must be 1-2000 characters".to_string()));
    }

    let row: AdminNote = sqlx::query_as(
        r#"INSERT INTO admin_notes (user_id, author_id, content)
           VALUES ($1, $2, $3)
           RETURNING id, author_id,
                     (SELECT username FROM users WHERE id = $2) AS author_username,
                     content, created_at"#,
    )
    .bind(target_id)
    .bind(auth.user_id)
    .bind(content)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_note_added",
        "user",
        &target_id.to_string(),
        json!({ "noteId": row.id }),
    )
    .await;

    Ok(Json(row))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/users/{userRef}/impersonate
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImpersonateRequest {
    pub duration_minutes: Option<i64>,
}

pub async fn admin_impersonate_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<ImpersonateRequest>,
) -> Result<Json<crate::models::auth::V3AuthResponse>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let target = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let mins = body.duration_minutes.unwrap_or(60).clamp(1, 240);
    let expires = Utc::now() + chrono::Duration::minutes(mins);

    let token = crate::auth::create_token(&target_id, &state.jwt_secret, mins)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")))?;

    sqlx::query(
        r#"INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())"#,
    )
    .bind(Uuid::new_v4())
    .bind(target_id)
    .bind(crate::auth::hash_token(&token))
    .bind(None::<String>)
    .bind(expires)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_impersonate",
        "user",
        &target_id.to_string(),
        json!({ "durationMinutes": mins }),
    )
    .await;

    Ok(Json(crate::models::auth::V3AuthResponse {
        access_token: token,
        refresh_token: String::new(),
        expires_in: mins * 60,
        token_type: "Bearer".to_string(),
        user: crate::models::users::AccountPublic {
            id: target.id,
            username: target.username,
            display_name: target.display_name,
            role: target.role,
        },
    }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/audit
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AdminAuditQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
    pub action: Option<String>,
    pub target_type: Option<String>,
}

pub async fn admin_audit_log(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<AdminAuditQuery>,
) -> Result<Json<AuditLogPage>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(20).clamp(1, 100);
    let offset = (page - 1) * per_page;

    use sqlx::QueryBuilder;

    let mut count_qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        "SELECT COUNT(*) FROM mod_audit_log a WHERE 1=1",
    );
    if let Some(action) = &q.action {
        count_qb.push(" AND a.action ILIKE ");
        count_qb.push_bind(format!("%{}%", action));
    }
    if let Some(target_type) = &q.target_type {
        count_qb.push(" AND a.target_type ILIKE ");
        count_qb.push_bind(format!("%{}%", target_type));
    }

    let total: i64 = count_qb
        .build_query_scalar::<i64>()
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut rows_qb: QueryBuilder<sqlx::Postgres> = QueryBuilder::new(
        r#"SELECT a.id, a.moderator_id, a.action, a.target_type, a.target_id, a.details, a.created_at,
                  u.username AS moderator_username
             FROM mod_audit_log a
             LEFT JOIN users u ON u.id = a.moderator_id
            WHERE 1=1"#,
    );
    if let Some(action) = &q.action {
        rows_qb.push(" AND a.action ILIKE ");
        rows_qb.push_bind(format!("%{}%", action));
    }
    if let Some(target_type) = &q.target_type {
        rows_qb.push(" AND a.target_type ILIKE ");
        rows_qb.push_bind(format!("%{}%", target_type));
    }
    rows_qb.push(" ORDER BY a.created_at DESC LIMIT ");
    rows_qb.push_bind(per_page);
    rows_qb.push(" OFFSET ");
    rows_qb.push_bind(offset);

    let rows: Vec<AuditLogRow> = rows_qb
        .build_query_as::<AuditLogRow>()
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total_pages = (total + per_page - 1) / per_page;
    let items = rows.into_iter().map(AuditLogEntry::from_row).collect();

    Ok(Json(AuditLogPage {
        items,
        page,
        per_page,
        total,
        total_pages,
    }))
}
