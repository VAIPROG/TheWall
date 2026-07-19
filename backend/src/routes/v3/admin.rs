//! V3 admin endpoints for user management and audit.
//!
//! Authorisation:
//!   - global moderator+ for ban/mute, reset-avatar, reset-username,
//!     remove-from-clan, admin audit log
//!   - global admin+ for admin user view/update and promote to moderator
//!   - global owner for promote to admin/owner and wipeout
use crate::http_error::ResultExt;

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
    config::RuntimeConfig,
    models::{
        auth::SessionSummary,
        moderation::{AuditLogEntry, AuditLogPage, AuditLogRow, RestrictionRow, RestrictionView},
        users::User,
    },
    routes::v3::utils::{audit, permissions::global_role_of, users::resolve_user_ref},
};

use crate::routes::v3::utils::permissions::GlobalRole;

async fn require_role(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    min: GlobalRole,
) -> Result<GlobalRole, (StatusCode, String)> {
    let role = global_role_of(pool, user_id)
        .await
        .or_500()?;
    if role < min {
        return Err((StatusCode::FORBIDDEN, "insufficient role".to_string()));
    }
    Ok(role)
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
    .or_500()
}

/// Active clan memberships for a user, shaped for the admin console: the clan
/// UUID (copyable — needed for the clan role/transfer-owner admin endpoints),
/// its name + tag, and the user's role in it. Empty when the user is in no clan.
async fn load_user_clans(
    pool: &sqlx::PgPool,
    user_id: Uuid,
) -> Result<Vec<serde_json::Value>, (StatusCode, String)> {
    let rows: Vec<(Uuid, String, Option<String>, String, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT c.id, c.name, c.tag, cm.clan_role, cm.joined_at
             FROM clan_memberships cm
             JOIN clans c ON c.id = cm.clan_id
            WHERE cm.user_id = $1 AND cm.active = TRUE
            ORDER BY cm.joined_at"#,
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .or_500()?;

    Ok(rows
        .into_iter()
        .map(|(id, name, tag, clan_role, joined_at)| {
            json!({
                "clanId": id,
                "name": name,
                "tag": tag,
                "role": clan_role,
                "joinedAt": joined_at,
            })
        })
        .collect())
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/users/{userRef}
// ---------------------------------------------------------------------------

pub async fn admin_get_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;
    let user = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;
    // Merge the user's active clan memberships onto the base user payload so the
    // admin console can show which clan they're in (and copy the clan UUID).
    let clans = load_user_clans(&state.pool, target_id).await?;
    let mut body = serde_json::to_value(&user).or_500()?;
    body["clans"] = serde_json::Value::Array(clans);
    Ok(Json(body))
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
    let caller_role = require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    // Normalise + gate role changes like /promote: only the owner may grant
    // admin/owner, and the stored value is always a canonical global_role.
    let normalized_role: Option<&'static str> = match body.role.as_deref() {
        None => None,
        Some(role) => {
            let new_role = match role {
                "member" | "user" => GlobalRole::User,
                "moderator" => GlobalRole::Moderator,
                "admin" => GlobalRole::Admin,
                "owner" => GlobalRole::Owner,
                _ => return Err((StatusCode::BAD_REQUEST, "invalid role".to_string())),
            };
            if new_role >= GlobalRole::Admin && caller_role != GlobalRole::Owner {
                return Err((
                    StatusCode::FORBIDDEN,
                    "only owner can grant admin or owner".to_string(),
                ));
            }
            Some(new_role.as_str())
        }
    };

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
    .bind(normalized_role)
    .bind(body.lang.as_deref())
    .bind(body.telemetry_opt_in)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

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
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let result = sqlx::query(
        "UPDATE restrictions SET removed_at = NOW(), removed_by = $1
          WHERE user_id = $2 AND scope = 'global' AND s_ban = TRUE AND removed_at IS NULL",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

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
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let result = sqlx::query(
        "UPDATE restrictions SET removed_at = NOW(), removed_by = $1
          WHERE user_id = $2 AND scope = 'global' AND s_mute = TRUE AND removed_at IS NULL",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

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
        .bind(new_role.as_str())
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    if body.confirmation != "WIPEOUT" {
        return Err((StatusCode::BAD_REQUEST, "confirmation required".to_string()));
    }

    sqlx::query("DELETE FROM templates WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    sqlx::query("DELETE FROM messages WHERE author_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let result = sqlx::query("DELETE FROM clan_memberships WHERE user_id = $1 AND active = TRUE")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let suffix: String = target_id.to_string().replace('-', "").chars().take(8).collect();
    let new_username = format!("user_{}", suffix);
    sqlx::query("UPDATE users SET username = $1, updated_at = NOW() WHERE id = $2")
        .bind(&new_username)
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let rows: Vec<SessionSummary> = sqlx::query_as(
        r#"SELECT id AS session_id, ip::TEXT AS ip, user_agent, created_at, last_activity AS last_activity_at
             FROM sessions
            WHERE user_id = $1
         ORDER BY created_at DESC"#,
    )
    .bind(target_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(rows))
}

pub async fn admin_terminate_user_sessions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let result = sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(target_id)
        .execute(&state.pool)
        .await
        .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

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
    .or_500()?;

    Ok(Json(rows))
}

pub async fn admin_add_user_note(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
    Json(body): Json<AdminNoteCreate>,
) -> Result<Json<AdminNote>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

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
    .or_500()?;

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
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    let target = load_user(&state.pool, target_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "user not found".to_string()))?;

    let mins = body.duration_minutes.unwrap_or(60).clamp(1, 240);
    let expires = Utc::now() + chrono::Duration::minutes(mins);
    let session_id = Uuid::new_v4();
    let (token, token_hash) = crate::auth::create_token(&target_id, &session_id, &state.config.jwt_secret, mins)
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("{e:?}")))?;

    sqlx::query(
        r#"INSERT INTO sessions (id, user_id, token_hash, refresh_hash, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())"#,
    )
    .bind(session_id)
    .bind(target_id)
    .bind(token_hash)
    .bind(None::<String>)
    .bind(expires)
    .execute(&state.pool)
    .await
    .or_500()?;

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
        .or_500()?;

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
        .or_500()?;

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

// ===========================================================================
// Admin system endpoints: config, maintenance, broadcast, shutdown, restart
// ===========================================================================

/// Wire shape for `ServerConfig`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    pub max_users_per_clan: i32,
    pub max_templates_per_user: i32,
    pub max_api_keys_per_user: i32,
    pub max_file_size_mb: i32,
    pub rate_limit_per_minute: i32,
    pub maintenance_mode: bool,
    pub feature_flags: std::collections::HashMap<String, bool>,
    pub allow_public_template_publishing: bool,
    pub auto_approve_moderator_templates: bool,
}

impl From<RuntimeConfig> for ServerConfig {
    fn from(r: RuntimeConfig) -> Self {
        Self {
            max_users_per_clan: r.max_users_per_clan,
            max_templates_per_user: r.max_templates_per_user,
            max_api_keys_per_user: r.max_api_keys_per_user,
            max_file_size_mb: r.max_file_size_mb,
            rate_limit_per_minute: r.rate_limit_per_minute,
            maintenance_mode: r.maintenance_mode,
            feature_flags: r.feature_flags,
            allow_public_template_publishing: r.allow_public_template_publishing,
            auto_approve_moderator_templates: r.auto_approve_moderator_templates,
        }
    }
}

/// Partial update body for `ServerConfig`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfigUpdate {
    pub max_users_per_clan: Option<i32>,
    pub max_templates_per_user: Option<i32>,
    pub max_api_keys_per_user: Option<i32>,
    pub max_file_size_mb: Option<i32>,
    pub rate_limit_per_minute: Option<i32>,
    pub maintenance_mode: Option<bool>,
    pub feature_flags: Option<std::collections::HashMap<String, bool>>,
    pub allow_public_template_publishing: Option<bool>,
    pub auto_approve_moderator_templates: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceStatus {
    pub enabled: bool,
    pub reason: Option<String>,
    pub estimated_end_time: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceRequest {
    pub enabled: bool,
    pub reason: Option<String>,
    pub estimated_duration_minutes: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastRequest {
    pub message: String,
    pub target_role: Option<String>,
    pub target_user_ids: Option<Vec<Uuid>>,
    /// Optional notification title (defaults to "Broadcast").
    pub title: Option<String>,
    /// Optional notification kind (defaults to "system_announcement").
    /// Accepts the canonical V3 notification types plus the legacy
    /// news/announcement/alert aliases used by the old /admin/broadcast.
    pub kind: Option<String>,
}

/// Normalise a requested broadcast kind to a canonical V3 notification type.
/// Returns None for unknown values.
fn normalize_broadcast_kind(kind: &str) -> Option<&'static str> {
    match kind {
        // canonical V3 notification types (see notifications::notify)
        "system_announcement" => Some("system_announcement"),
        "news_announcement" => Some("news_announcement"),
        "mod_action" => Some("mod_action"),
        "restriction_update" => Some("restriction_update"),
        "mention" => Some("mention"),
        // legacy aliases from the V1 mailbox taxonomy
        "news" => Some("news_announcement"),
        "announcement" | "alert" => Some("system_announcement"),
        _ => None,
    }
}

pub async fn admin_get_config(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ServerConfig>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let rt = state.config.runtime.read().await;
    Ok(Json(ServerConfig::from(rt.clone())))
}

pub async fn admin_update_config(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ServerConfigUpdate>,
) -> Result<Json<ServerConfig>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Owner).await?;

    {
        let mut rt = state.config.runtime.write().await;
        if let Some(v) = body.max_users_per_clan {
            rt.max_users_per_clan = v.max(1);
        }
        if let Some(v) = body.max_templates_per_user {
            rt.max_templates_per_user = v.max(1);
        }
        if let Some(v) = body.max_api_keys_per_user {
            rt.max_api_keys_per_user = v.max(1);
        }
        if let Some(v) = body.max_file_size_mb {
            rt.max_file_size_mb = v.max(1);
        }
        if let Some(v) = body.rate_limit_per_minute {
            rt.rate_limit_per_minute = v.max(1);
        }
        if let Some(v) = body.maintenance_mode {
            rt.maintenance_mode = v;
        }
        if let Some(v) = body.feature_flags {
            rt.feature_flags = v;
        }
        if let Some(v) = body.allow_public_template_publishing {
            rt.allow_public_template_publishing = v;
        }
        if let Some(v) = body.auto_approve_moderator_templates {
            rt.auto_approve_moderator_templates = v;
        }
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_config_updated",
        "server",
        "config",
        json!({}),
    )
    .await;

    let rt = state.config.runtime.read().await;
    Ok(Json(ServerConfig::from(rt.clone())))
}

pub async fn admin_get_maintenance(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<MaintenanceStatus>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let rt = state.config.runtime.read().await;
    Ok(Json(MaintenanceStatus {
        enabled: rt.maintenance_mode,
        reason: rt.maintenance_reason.clone(),
        estimated_end_time: rt.maintenance_estimated_end,
    }))
}

pub async fn admin_set_maintenance(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<MaintenanceRequest>,
) -> Result<Json<MaintenanceStatus>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Owner).await?;

    {
        let mut rt = state.config.runtime.write().await;
        rt.maintenance_mode = body.enabled;
        rt.maintenance_reason = body.reason.clone();
        rt.maintenance_estimated_end = body
            .estimated_duration_minutes
            .map(|m| Utc::now() + chrono::Duration::minutes(m));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        if body.enabled { "admin_maintenance_enabled" } else { "admin_maintenance_disabled" },
        "server",
        "maintenance",
        json!({ "reason": body.reason }),
    )
    .await;

    let rt = state.config.runtime.read().await;
    Ok(Json(MaintenanceStatus {
        enabled: rt.maintenance_mode,
        reason: rt.maintenance_reason.clone(),
        estimated_end_time: rt.maintenance_estimated_end,
    }))
}

pub async fn admin_broadcast(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<BroadcastRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;

    let message = body.message.trim();
    if message.is_empty() || message.len() > 2000 {
        return Err((StatusCode::BAD_REQUEST, "message must be 1-2000 characters".to_string()));
    }

    let title = match body.title.as_deref().map(str::trim) {
        Some(t) if !t.is_empty() => {
            if t.len() > 200 {
                return Err((StatusCode::BAD_REQUEST, "title must be \u{2264}200 characters".to_string()));
            }
            t.to_string()
        }
        _ => "Broadcast".to_string(),
    };

    let kind = match body.kind.as_deref().map(str::trim) {
        Some(k) if !k.is_empty() => normalize_broadcast_kind(k).ok_or_else(|| {
            (
                StatusCode::BAD_REQUEST,
                "kind must be one of: system_announcement, news_announcement, mod_action, restriction_update, mention, news, announcement, alert".to_string(),
            )
        })?,
        _ => "system_announcement",
    };

    let target_ids: Vec<Uuid> = if let Some(ids) = body.target_user_ids {
        ids
    } else {
        let role_filter = body.target_role.as_deref().unwrap_or("all");
        let rows: Vec<(Uuid,)> = if role_filter == "all" {
            sqlx::query_as("SELECT id FROM users")
                .fetch_all(&state.pool)
                .await
                .or_500()?
        } else {
            sqlx::query_as("SELECT id FROM users WHERE global_role = $1")
                .bind(role_filter)
                .fetch_all(&state.pool)
                .await
                .or_500()?
        };
        rows.into_iter().map(|(id,)| id).collect()
    };

    let mut sent = 0usize;
    for user_id in &target_ids {
        if let Ok(Some(_)) = crate::routes::v3::notifications::notify(
            &state.pool,
            *user_id,
            kind,
            &title,
            Some(message),
            None,
            json!({"fromAdmin": auth.user_id}),
        )
        .await
        {
            sent += 1;
        }
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_broadcast",
        "server",
        "broadcast",
        json!({ "message": message, "title": title, "kind": kind, "recipients": sent }),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "broadcast sent", "recipients": sent})))
}

pub async fn admin_shutdown(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ConfirmationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Owner).await?;

    if body.confirmation != "SHUTDOWN" {
        return Err((StatusCode::BAD_REQUEST, "confirmation required".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_shutdown_requested",
        "server",
        "shutdown",
        json!({}),
    )
    .await;

    // In this process model we cannot stop the Tokio runtime from inside an
    // HTTP handler without a shutdown handle. The action is logged; an operator
    // or orchestrator must terminate the process.
    Ok(Json(json!({"ok": true, "message": "shutdown requested — operator action required"})))
}

pub async fn admin_restart(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ConfirmationRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Owner).await?;

    if body.confirmation != "RESTART" {
        return Err((StatusCode::BAD_REQUEST, "confirmation required".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_restart_requested",
        "server",
        "restart",
        json!({}),
    )
    .await;

    // Same as shutdown: no in-process restart handle wired up yet.
    Ok(Json(json!({"ok": true, "message": "restart requested — operator action required"})))
}

pub async fn admin_metrics(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<(axum::http::header::HeaderMap, String), (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;

    let pool_active = state.pool.size() as i64;
    let db_ok = sqlx::query("SELECT 1")
        .fetch_one(&state.pool)
        .await
        .is_ok();
    let uptime = std::time::SystemTime::now()
        .duration_since(state.started_at)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let body = format!(
        "# HELP wall_uptime_seconds Server uptime in seconds\n\
         # TYPE wall_uptime_seconds gauge\n\
         wall_uptime_seconds {}\n\
         # HELP wall_db_pool_active Active DB connections\n\
         # TYPE wall_db_pool_active gauge\n\
         wall_db_pool_active {}\n\
         # HELP wall_db_ok Database connectivity (1 = ok, 0 = fail)\n\
         # TYPE wall_db_ok gauge\n\
         wall_db_ok {}\n",
        uptime,
        pool_active,
        if db_ok { 1 } else { 0 }
    );

    let mut headers = axum::http::header::HeaderMap::new();
    headers.insert(
        axum::http::header::CONTENT_TYPE,
        "text/plain; version=0.0.4; charset=utf-8".parse().unwrap(),
    );
    Ok((headers, body))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/users — search / filter / paginate
//
// The legacy `/api/admin/users` returns every user unfiltered. This is the V3
// replacement: free-text search over username/display_name/external_id, an
// optional exact global-role filter, and page/limit pagination.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminUserListQuery {
    /// Free-text match against username / display_name / external_id.
    pub q: Option<String>,
    /// Exact global role filter (member|moderator|admin|owner).
    pub role: Option<String>,
    pub page: Option<i64>,
    pub limit: Option<i64>,
}

pub async fn admin_list_users(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(params): Query<AdminUserListQuery>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;

    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let page = params.page.unwrap_or(1).max(1);
    let offset = (page - 1) * limit;
    // Wrap the search term in wildcards for ILIKE; empty/whitespace → no filter.
    let q = params
        .q
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("%{s}%"));
    let role = params
        .role
        .as_deref()
        .filter(|s| matches!(*s, "member" | "moderator" | "admin" | "owner"))
        .map(str::to_string);

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM users \
         WHERE ($1::text IS NULL OR username ILIKE $1 OR display_name ILIKE $1 OR external_id ILIKE $1) \
           AND ($2::text IS NULL OR global_role = $2)",
    )
    .bind(&q)
    .bind(&role)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    let users = sqlx::query_as::<_, User>(
        r#"SELECT id, external_id, username, discord_id, discord_username, role,
                  global_role, source, preferred_lang, bio, social_links,
                  telemetry_opt_in, created_at, updated_at, display_name
             FROM users
            WHERE ($1::text IS NULL OR username ILIKE $1 OR display_name ILIKE $1 OR external_id ILIKE $1)
              AND ($2::text IS NULL OR global_role = $2)
            ORDER BY created_at DESC
            LIMIT $3 OFFSET $4"#,
    )
    .bind(&q)
    .bind(&role)
    .bind(limit)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({
        "users": users,
        "page": page,
        "limit": limit,
        "total": total,
    })))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/admin/messages/{messageId} — force-remove any message
//
// Soft-delete (tombstone) so thread integrity and existing rendering hold, but
// reachable globally by a moderator without being a member of the chat. Content
// is blanked at the wire layer for deleted rows, same as the per-chat delete.
// ---------------------------------------------------------------------------

pub async fn admin_delete_message(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(message_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Moderator).await?;

    let result =
        sqlx::query("UPDATE messages SET deleted_at = NOW(), deleted_by = $1 WHERE id = $2 AND deleted_at IS NULL")
            .bind(auth.user_id)
            .bind(message_id)
            .execute(&state.pool)
            .await
            .or_500()?;
    if result.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            "message not found or already deleted".to_string(),
        ));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_delete_message",
        "message",
        &message_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "message deleted"})))
}

// ---------------------------------------------------------------------------
// GET /api/v3/admin/stats — JSON dashboard summary
//
// Complements `/api/v3/admin/metrics` (Prometheus text) with a small,
// human/UI-friendly JSON snapshot of platform totals.
// ---------------------------------------------------------------------------

pub async fn admin_stats(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(&state.pool)
        .await
        .or_500()?;
    let clans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM clans")
        .fetch_one(&state.pool)
        .await
        .or_500()?;
    let templates: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM templates")
        .fetch_one(&state.pool)
        .await
        .or_500()?;
    let messages: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE deleted_at IS NULL")
        .fetch_one(&state.pool)
        .await
        .or_500()?;
    let open_reports: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM reports WHERE status IN ('open', 'reviewing')")
            .fetch_one(&state.pool)
            .await
            .or_500()?;
    let active_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE expires_at > NOW()")
            .fetch_one(&state.pool)
            .await
            .or_500()?;

    Ok(Json(json!({
        "users": users,
        "clans": clans,
        "templates": templates,
        "messages": messages,
        "openReports": open_reports,
        "activeSessions": active_sessions,
    })))
}

// ---------------------------------------------------------------------------
// POST /api/v3/admin/clans/{clanId}/members/{userRef}/role
// POST /api/v3/admin/clans/{clanId}/transfer-owner
//
// Global-admin overrides for clan governance: set a member's clan role or
// transfer clan ownership without holding any rank inside the clan. Both are
// gated to global admin+ and audited.
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminClanRoleRequest {
    /// member | moderator | admin (ownership goes through transfer-owner).
    pub role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminTransferOwnerRequest {
    /// The new owner — user id, @username, or "me".
    pub user_ref: String,
}

/// Load `(owner_id, name)` for a clan; 404 when the clan doesn't exist.
async fn load_clan_owner(
    pool: &sqlx::PgPool,
    clan_id: Uuid,
) -> Result<(Option<Uuid>, String), (StatusCode, String)> {
    sqlx::query_as::<_, (Option<Uuid>, String)>(
        "SELECT owner_id, name FROM clans WHERE id = $1",
    )
    .bind(clan_id)
    .fetch_optional(pool)
    .await
    .or_500()?
    .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))
}

pub async fn admin_set_clan_member_role(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, user_ref)): Path<(Uuid, String)>,
    Json(body): Json<AdminClanRoleRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let target_id = resolve_user_ref(&state.pool, &user_ref, auth.user_id).await?;

    if !matches!(body.role.as_str(), "member" | "moderator" | "admin") {
        return Err((
            StatusCode::BAD_REQUEST,
            "role must be member, moderator, or admin (use transfer-owner for ownership)".to_string(),
        ));
    }

    let (owner_id, _name) = load_clan_owner(&state.pool, clan_id).await?;
    if owner_id == Some(target_id) {
        return Err((
            StatusCode::CONFLICT,
            "target is the clan owner — use transfer-owner instead".to_string(),
        ));
    }

    let result = sqlx::query(
        "UPDATE clan_memberships SET clan_role = $1
          WHERE clan_id = $2 AND user_id = $3 AND active = TRUE",
    )
    .bind(&body.role)
    .bind(clan_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "active clan membership not found".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_clan_role_set",
        "clan",
        &clan_id.to_string(),
        json!({ "userId": target_id, "role": body.role }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "clanId": clan_id,
        "userId": target_id,
        "role": body.role,
    })))
}

pub async fn admin_transfer_clan_owner(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<AdminTransferOwnerRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    require_role(&state.pool, auth.user_id, GlobalRole::Admin).await?;
    let new_owner_id = resolve_user_ref(&state.pool, &body.user_ref, auth.user_id).await?;

    let (old_owner_id, clan_name) = load_clan_owner(&state.pool, clan_id).await?;
    if old_owner_id == Some(new_owner_id) {
        return Err((StatusCode::BAD_REQUEST, "user already owns this clan".to_string()));
    }

    // One-clan-per-owner invariant (mirrors create_clan).
    let owns_other: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM clans WHERE owner_id = $1 AND id <> $2",
    )
    .bind(new_owner_id)
    .bind(clan_id)
    .fetch_optional(&state.pool)
    .await
    .or_500()?;
    if owns_other.is_some() {
        return Err((StatusCode::CONFLICT, "target user already owns another clan".to_string()));
    }

    let mut tx = state.pool.begin().await.or_500()?;

    sqlx::query("UPDATE clans SET owner_id = $1, updated_at = NOW() WHERE id = $2")
        .bind(new_owner_id)
        .bind(clan_id)
        .execute(&mut *tx)
        .await
        .or_500()?;

    // Ensure the new owner has an active membership. Ownership itself derives
    // from clans.owner_id; the membership row carries 'admin' like create_clan.
    sqlx::query(
        r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active, joined_at)
           VALUES (gen_random_uuid(), $1, $2, 'admin', TRUE, NOW())
           ON CONFLICT (user_id, clan_id) DO UPDATE
               SET active = TRUE, clan_role = 'admin'"#,
    )
    .bind(new_owner_id)
    .bind(clan_id)
    .execute(&mut *tx)
    .await
    .or_500()?;

    // Previous owner steps down to clan admin (membership row kept as-is
    // otherwise; their owner rank was derived from clans.owner_id).
    if let Some(old_id) = old_owner_id {
        sqlx::query(
            "UPDATE clan_memberships SET clan_role = 'admin'
              WHERE clan_id = $1 AND user_id = $2 AND active = TRUE",
        )
        .bind(clan_id)
        .bind(old_id)
        .execute(&mut *tx)
        .await
        .or_500()?;
    }

    tx.commit().await.or_500()?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "admin_clan_owner_transferred",
        "clan",
        &clan_id.to_string(),
        json!({ "from": old_owner_id, "to": new_owner_id }),
    )
    .await;

    // Best-effort heads-up for the new owner.
    let _ = crate::routes::v3::notifications::notify(
        &state.pool,
        new_owner_id,
        "mod_action",
        "Clan ownership transferred",
        Some(&format!("You are now the owner of clan \"{clan_name}\".")),
        None,
        json!({ "clanId": clan_id }),
    )
    .await;

    Ok(Json(json!({
        "ok": true,
        "clanId": clan_id,
        "ownerId": new_owner_id,
        "previousOwnerId": old_owner_id,
    })))
}
