//! Clan endpoints for v2. Each route enforces the right minimum role.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use crate::http_error::ResultExt;
use sqlx::FromRow;
use uuid::Uuid;

use super::permissions::{self, ClanRole};
use crate::{AppState, auth::AuthUser};

// --- mine ----------------------------------------------------------------

#[derive(Debug, Serialize, FromRow)]
pub struct MyClan {
    pub clan_id: Uuid,
    pub clan_name: String,
    pub clan_display_name: Option<String>,
    pub clan_icon: Option<String>,
    pub clan_role: String,
}

pub async fn list_mine(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<MyClan>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, MyClan>(
        r#"SELECT m.clan_id, c.name AS clan_name, c.display_name AS clan_display_name,
                  c.icon AS clan_icon, m.clan_role
             FROM clan_memberships m JOIN clans c ON c.id = m.clan_id
            WHERE m.user_id = $1 AND m.active = TRUE
            ORDER BY m.joined_at"#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

// --- members -------------------------------------------------------------

#[derive(Debug, Serialize, FromRow)]
pub struct ClanMemberView {
    pub user_id: Uuid,
    pub username: String,
    pub discord_username: Option<String>,
    pub clan_role: String,
    pub global_role: String,
    pub has_custom_avatar: bool,
}

pub async fn members(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<Vec<ClanMemberView>>, (StatusCode, String)> {
    // Must at least be a member of the clan, or a global admin.
    permissions::effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?
        .ok_or((StatusCode::FORBIDDEN, "not in clan".into()))?;

    let rows = sqlx::query_as::<_, ClanMemberView>(
        r#"SELECT u.id AS user_id, u.username, u.discord_username,
                  m.clan_role, u.global_role,
                  EXISTS(SELECT 1 FROM avatars a WHERE a.user_id = u.id) AS has_custom_avatar
             FROM clan_memberships m JOIN users u ON u.id = m.user_id
            WHERE m.clan_id = $1 AND m.active = TRUE
            ORDER BY
              CASE m.clan_role WHEN 'admin' THEN 0 WHEN 'moderator' THEN 1 ELSE 2 END,
              u.username"#,
    )
    .bind(clan_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

// --- clan announcements (clan_admin only) --------------------------------

#[derive(Debug, Deserialize)]
pub struct AnnouncementBody {
    pub title: String,
    pub body: String,
}

pub async fn post_announcement(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(b): Json<AnnouncementBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_clan_admin(&auth, &state.pool, clan_id).await?;
    sqlx::query(
        r#"INSERT INTO mailbox_items
                (id, kind, sender_id, recipient_clan_id, title, body)
           VALUES (gen_random_uuid(), 'clan_announcement', $1, $2, $3, $4)"#,
    )
    .bind(auth.user_id)
    .bind(clan_id)
    .bind(&b.title)
    .bind(&b.body)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::CREATED)
}

// --- clan alerts (clan_mod+; pushed to all members) -----------------------

#[derive(Debug, Deserialize)]
pub struct AlertBody {
    pub title: String,
    pub body: String,
}

pub async fn post_alert(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(b): Json<AlertBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_clan_mod(&auth, &state.pool, clan_id).await?;
    sqlx::query(
        r#"INSERT INTO mailbox_items
                (id, kind, sender_id, recipient_clan_id, title, body)
           VALUES (gen_random_uuid(), 'clan_alert', $1, $2, $3, $4)"#,
    )
    .bind(auth.user_id)
    .bind(clan_id)
    .bind(&b.title)
    .bind(&b.body)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::CREATED)
}

// --- mod_dm (member → all mods of clan as DMs) ---------------------------

#[derive(Debug, Deserialize)]
pub struct ModDmBody {
    pub body: String,
}

pub async fn mod_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(b): Json<ModDmBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Anyone in the clan can ping the mods.
    let me_role = permissions::effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?
        .ok_or((StatusCode::FORBIDDEN, "not in clan".into()))?;
    let _ = me_role; // any clan role is fine
    if b.body.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty body".into()));
    }

    // Fan out one mailbox item per moderator/admin in this clan.
    sqlx::query(
        r#"INSERT INTO mailbox_items (id, kind, sender_id, recipient_user_id, recipient_clan_id, title, body)
           SELECT gen_random_uuid(), 'mod_alert', $1, m.user_id, $2, 'Member message to mods', $3
             FROM clan_memberships m
            WHERE m.clan_id = $2 AND m.active = TRUE
              AND m.clan_role IN ('admin', 'moderator')"#,
    )
    .bind(auth.user_id).bind(clan_id).bind(&b.body)
    .execute(&state.pool).await
    .or_500()?;
    Ok(StatusCode::CREATED)
}

// --- modmail thread (member opens, mods reply) ---------------------------

#[derive(Debug, Deserialize)]
pub struct OpenModmailBody {
    pub subject: String,
    pub body: String,
}

pub async fn open_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(b): Json<OpenModmailBody>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    // Opener must be a member of the clan (any role).
    permissions::effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?
        .ok_or((StatusCode::FORBIDDEN, "not in clan".into()))?;

    let mut tx = state
        .pool
        .begin()
        .await
        .or_500()?;

    let thread_id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO clan_modmail_threads (id, clan_id, opener_user_id, subject)
           VALUES (gen_random_uuid(), $1, $2, $3)
           RETURNING id"#,
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .bind(&b.subject)
    .fetch_one(&mut *tx)
    .await
    .or_500()?;

    // Root mailbox item — addressed to the clan (so all mods see it).
    let root_id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO mailbox_items
                (id, kind, sender_id, recipient_clan_id, thread_id, title, body, payload)
           VALUES (gen_random_uuid(), 'modmail', $1, $2, $3, $4, $5,
                   jsonb_build_object('modmail_thread', $3::text))
           RETURNING id"#,
    )
    .bind(auth.user_id)
    .bind(clan_id)
    .bind(thread_id)
    .bind(&b.subject)
    .bind(&b.body)
    .fetch_one(&mut *tx)
    .await
    .or_500()?;

    tx.commit()
        .await
        .or_500()?;

    Ok(Json(serde_json::json!({
        "thread_id": thread_id,
        "root_mailbox_item_id": root_id,
    })))
}

#[derive(Debug, Serialize, FromRow)]
pub struct ModmailThreadView {
    pub id: Uuid,
    pub opener_user_id: Uuid,
    pub opener_username: String,
    pub subject: String,
    pub status: String,
    pub last_activity: chrono::DateTime<chrono::Utc>,
}

pub async fn list_modmail(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<Vec<ModmailThreadView>>, (StatusCode, String)> {
    permissions::require_clan_mod(&auth, &state.pool, clan_id).await?;
    let rows = sqlx::query_as::<_, ModmailThreadView>(
        r#"SELECT t.id, t.opener_user_id,
                  (SELECT username FROM users WHERE id = t.opener_user_id) AS opener_username,
                  t.subject, t.status, t.last_activity
             FROM clan_modmail_threads t
            WHERE t.clan_id = $1
            ORDER BY t.last_activity DESC"#,
    )
    .bind(clan_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;
    Ok(Json(rows))
}

// --- role management (clan_admin only) -----------------------------------

#[derive(Debug, Deserialize)]
pub struct SetRoleBody {
    pub role: String,
}

pub async fn set_member_role(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, user_id)): Path<(Uuid, Uuid)>,
    Json(b): Json<SetRoleBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    permissions::require_clan_admin(&auth, &state.pool, clan_id).await?;
    let new_role = ClanRole::from_str(&b.role);
    sqlx::query("UPDATE clan_memberships SET clan_role = $1 WHERE clan_id = $2 AND user_id = $3")
        .bind(new_role.as_str())
        .bind(clan_id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    Ok(StatusCode::OK)
}
