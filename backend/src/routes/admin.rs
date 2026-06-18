use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

fn is_admin(role: &str) -> bool {
    matches!(role, "admin" | "owner")
}

async fn require_admin(auth: &AuthUser, pool: &sqlx::PgPool) -> Result<(), (StatusCode, String)> {
    let row: Option<(String,)> = sqlx::query_as("SELECT role FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let role = row
        .ok_or((StatusCode::UNAUTHORIZED, "user not found".to_string()))?
        .0;
    if !is_admin(&role) {
        return Err((StatusCode::FORBIDDEN, "admin only".to_string()));
    }
    Ok(())
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    #[serde(rename = "wall_id")]
    pub external_id: String,
    pub username: String,
    pub discord_id: Option<String>,
    pub role: String,
}

pub async fn list_users(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, UserRow>(
        "SELECT id, external_id, username, discord_id, role FROM users ORDER BY username",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

#[derive(Debug, Deserialize)]
pub struct SetRoleRequest {
    pub role: String,
}

pub async fn set_role(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
    Json(body): Json<SetRoleRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    sqlx::query("UPDATE users SET role = $1, updated_at = now() WHERE id = $2")
        .bind(&body.role)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::OK)
}

pub async fn delete_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_id): Path<Uuid>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM notifications WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM clan_messages WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM avatars WHERE user_id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(user_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

/// Admin broadcast to every user.
///
/// Lands as a single row in `mailbox_items` with `recipient_user_id = NULL`
/// and `recipient_clan_id = NULL`. The list_mailbox visibility rule
/// surfaces both `announcement` and `alert` global rows to every user.
///
/// `kind` controls how the client surfaces the item:
///   - `"announcement"` (default)  → News: toast + OS notif, no popup
///   - `"alert"`                   → Alert: critical popup + toast + OS notif
///
/// `clan_alert` and `mod_alert` are intentionally NOT acceptable here —
/// those live in clan-management flows with a clan recipient. Admin
/// broadcasts are global and distinct.
///
/// Legacy callers that POST `{title, body}` without `kind` still work —
/// they get the announcement treatment, matching the prior behaviour
/// modulo the storage location (mailbox vs the obsolete `notifications`
/// table).
pub async fn broadcast_notification(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<BroadcastRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    let kind = body.kind.as_deref().unwrap_or("announcement");
    if !matches!(kind, "announcement" | "alert") {
        return Err((
            StatusCode::BAD_REQUEST,
            "kind must be 'announcement' (news) or 'alert' (global popup)".into(),
        ));
    }
    sqlx::query(
        r#"INSERT INTO mailbox_items
               (id, kind, sender_id, recipient_user_id, recipient_clan_id,
                title, body, created_at)
           VALUES (gen_random_uuid(), $1, $2, NULL, NULL, $3, $4, NOW())"#,
    )
    .bind(kind)
    .bind(auth.user_id)
    .bind(&body.title)
    .bind(body.body.as_deref().unwrap_or(""))
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    tracing::info!(
        "admin {} broadcast kind={} title={:?}",
        auth.user_id, kind, body.title
    );
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Deserialize)]
pub struct BroadcastRequest {
    pub title: String,
    pub body: Option<String>,
    /// "announcement" (default — news/toast) or "clan_alert" (critical popup).
    #[serde(default)]
    pub kind: Option<String>,
}

pub async fn mod_applications(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    // LEFT JOIN LATERAL pulls the applicant's primary active clan (highest
    // role first), so the admin sees the context before approving / rejecting.
    // NULL fields mean the user has no clan membership.
    let rows = sqlx::query_as::<_, ModAppRow>(
        r#"SELECT ma.id, u.username, u.role AS current_role,
                  ma.message, ma.status, ma.created_at,
                  cm.clan_id, c.name AS clan_name, cm.clan_role
             FROM moderation_applications ma
             JOIN users u ON u.id = ma.user_id
        LEFT JOIN LATERAL (
                 SELECT clan_id, clan_role
                   FROM clan_memberships
                  WHERE user_id = ma.user_id AND active = TRUE
                  ORDER BY CASE clan_role
                             WHEN 'admin' THEN 0
                             WHEN 'moderator' THEN 1
                             ELSE 2
                           END
                  LIMIT 1
             ) cm ON TRUE
        LEFT JOIN clans c ON c.id = cm.clan_id
            ORDER BY ma.created_at DESC"#,
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct ModAppRow {
    pub id: Uuid,
    pub username: String,
    /// Applicant's current global role (user / admin / owner / moderator).
    pub current_role: String,
    pub message: Option<String>,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// Primary clan id, if the user is in one. NULL = no clan.
    pub clan_id: Option<Uuid>,
    pub clan_name: Option<String>,
    pub clan_role: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ModDecision {
    pub status: String,
    pub new_role: Option<String>,
}

pub async fn decide_mod_application(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(app_id): Path<Uuid>,
    Json(body): Json<ModDecision>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    sqlx::query("UPDATE moderation_applications SET status = $1 WHERE id = $2")
        .bind(&body.status)
        .bind(app_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Some(role) = &body.new_role {
        sqlx::query("UPDATE users SET role = $1 WHERE id = (SELECT user_id FROM moderation_applications WHERE id = $2)")
            .bind(role)
            .bind(app_id)
            .execute(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }
    Ok(StatusCode::OK)
}

// ---- notifications ----

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AdminNotifRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub title: String,
    pub body: Option<String>,
    pub read: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub async fn list_notifications(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, AdminNotifRow>(
        "SELECT id, user_id, title, body, read, created_at FROM notifications ORDER BY created_at DESC LIMIT 200"
    )
    .fetch_all(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

pub async fn delete_notification(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    sqlx::query("DELETE FROM notifications WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

// ---- templates ----

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct AdminTemplateRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    pub scope: String,
    pub status: String,
    pub author: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    /// For `scope = 'clan'` rows. NULL for global / public templates.
    pub clan_id: Option<Uuid>,
    /// Display name of the clan resolved by LEFT JOIN. NULL when the
    /// template isn't scoped to a clan, or when the clan has been deleted.
    pub clan_name: Option<String>,
}

pub async fn list_all_templates(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    let rows = sqlx::query_as::<_, AdminTemplateRow>(
        r#"SELECT t.id, t.user_id, t.name, t.x, t.y, t.scale, t.scope, t.status,
                  t.author, t.created_at, t.clan_id, c.name AS clan_name
             FROM templates t
        LEFT JOIN clans c ON c.id = t.clan_id
            ORDER BY t.created_at DESC
            LIMIT 500"#,
    )
    .fetch_all(&state.pool).await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(rows))
}

pub async fn delete_template_admin(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    require_admin(&auth, &state.pool).await?;
    sqlx::query("DELETE FROM template_reports WHERE template_id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .ok();
    sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}
