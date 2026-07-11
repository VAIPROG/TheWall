//! GET    /api/v3/clans/{id}/members          — paginated roster
//! GET    /api/v3/clans/{cid}/members/{uid}   — single member
//! PATCH  /api/v3/clans/{cid}/members/{uid}   — update member role (admin+)
//! DELETE /api/v3/clans/{cid}/members/{uid}   — kick member (moderator+)
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanMemberPage, ClanMemberRoleUpdate, ClanMemberView},
    routes::v3::utils::permissions::{ClanRole, effective_clan_role},
};

use super::load_clan;

// ---------------------------------------------------------------------------
// Permission helper
// ---------------------------------------------------------------------------

/// Numeric rank for a role: member=0, moderator=1, admin=2, owner=3.
fn role_rank(r: ClanRole) -> i32 {
    match r {
        ClanRole::Member => 0,
        ClanRole::Moderator => 1,
        ClanRole::Admin => 2,
        ClanRole::Owner => 3,
    }
}

/// Capability set derived from a clan role.
pub fn permissions_for(role: ClanRole) -> Vec<&'static str> {
    match role {
        ClanRole::Member => vec![],
        ClanRole::Moderator => vec![
            "moderate_chat",
            "kick_members",
            "invite_members",
            "manage_invites",
            "manage_templates",
        ],
        ClanRole::Admin => vec![
            "moderate_chat",
            "kick_members",
            "invite_members",
            "manage_invites",
            "manage_templates",
            "manage_members",
            "manage_roles",
            "manage_settings",
            "view_audit",
        ],
        ClanRole::Owner => vec![
            "moderate_chat",
            "kick_members",
            "invite_members",
            "manage_invites",
            "manage_templates",
            "manage_members",
            "manage_roles",
            "manage_settings",
            "view_audit",
            "disband_clan",
        ],
    }
}

// ---------------------------------------------------------------------------
// DB helper — fetch one member row
// ---------------------------------------------------------------------------

struct MemberRow {
    user_id: Uuid,
    username: String,
    display_name: Option<String>,
    clan_role: String,
    joined_at: DateTime<Utc>,
}

async fn fetch_member_row(
    pool: &sqlx::PgPool,
    clan_id: Uuid,
    user_id: Uuid,
) -> Result<Option<MemberRow>, (StatusCode, String)> {
    let row: Option<(Uuid, String, Option<String>, String, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT u.id, u.username, u.display_name, cm.clan_role, cm.joined_at
           FROM clan_memberships cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.clan_id = $1 AND cm.user_id = $2 AND cm.active = TRUE"#,
    )
    .bind(clan_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .or_500()?;

    Ok(row.map(|(uid, username, display_name, clan_role, joined_at)| MemberRow {
        user_id: uid,
        username,
        display_name,
        clan_role,
        joined_at,
    }))
}

fn build_member_view(row: MemberRow, owner_id: Option<Uuid>) -> ClanMemberView {
    let is_owner = owner_id.map(|o| o == row.user_id).unwrap_or(false);
    let role_enum = if is_owner {
        ClanRole::Owner
    } else {
        ClanRole::from_str(&row.clan_role)
    };
    let display_name = row
        .display_name
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| row.username.clone());
    ClanMemberView {
        user_id: row.user_id,
        username: row.username,
        display_name,
        avatar_url: None,
        role: role_enum.as_str().to_string(),
        joined_at: row.joined_at,
        role_rank: role_rank(role_enum),
        permissions: permissions_for(role_enum)
            .into_iter()
            .map(|s| s.to_string())
            .collect(),
        nickname: None,
        title: None,
        last_active_at: None,
    }
}

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct MemberListQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/members
// ---------------------------------------------------------------------------

pub async fn list_members(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Query(q): Query<MemberListQuery>,
) -> Result<Json<ClanMemberPage>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Roster is public only for discoverable clans; otherwise require an active
    // membership (effective_clan_role also grants global moderators+).
    if !clan.discoverable
        && effective_clan_role(&state.pool, auth.user_id, clan_id)
            .await
            .or_500()?
            .is_none()
    {
        return Err((StatusCode::FORBIDDEN, "clan roster is private".to_string()));
    }

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);
    let offset = (page - 1) * per_page;

    let total: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM clan_memberships WHERE clan_id = $1 AND active = TRUE",
    )
    .bind(clan_id)
    .fetch_one(&state.pool)
    .await
    .or_500()?;

    // Fetch rows; we derive role_rank in Rust so we ORDER BY after mapping.
    // Use a stable secondary key (joined_at ASC) and compute owner override.
    let rows: Vec<(Uuid, String, Option<String>, String, DateTime<Utc>)> = sqlx::query_as(
        r#"SELECT u.id, u.username, u.display_name, cm.clan_role, cm.joined_at
           FROM clan_memberships cm
           JOIN users u ON u.id = cm.user_id
           WHERE cm.clan_id = $1 AND cm.active = TRUE
           ORDER BY cm.joined_at ASC
           LIMIT $2 OFFSET $3"#,
    )
    .bind(clan_id)
    .bind(per_page)
    .bind(offset)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let owner_id = clan.owner_id;

    let mut items: Vec<ClanMemberView> = rows
        .into_iter()
        .map(|(uid, username, display_name, clan_role, joined_at)| {
            build_member_view(
                MemberRow { user_id: uid, username, display_name, clan_role, joined_at },
                owner_id,
            )
        })
        .collect();

    // Sort by role_rank DESC, joined_at ASC (stable — already sorted by joined_at from DB).
    items.sort_by(|a, b| b.role_rank.cmp(&a.role_rank).then(a.joined_at.cmp(&b.joined_at)));

    let total_pages = if per_page > 0 { (total + per_page - 1) / per_page } else { 0 };

    Ok(Json(ClanMemberPage { items, page, per_page, total, total_pages }))
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{cid}/members/{uid}
// ---------------------------------------------------------------------------

pub async fn get_member(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<ClanMemberView>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    if !clan.discoverable
        && effective_clan_role(&state.pool, auth.user_id, clan_id)
            .await
            .or_500()?
            .is_none()
    {
        return Err((StatusCode::FORBIDDEN, "clan roster is private".to_string()));
    }

    let row = fetch_member_row(&state.pool, clan_id, user_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "membership not found".to_string()))?;

    Ok(Json(build_member_view(row, clan.owner_id)))
}

// ---------------------------------------------------------------------------
// PATCH /api/v3/clans/{cid}/members/{uid}
// ---------------------------------------------------------------------------

pub async fn update_member_role(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, user_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<ClanMemberRoleUpdate>,
) -> Result<Json<ClanMemberView>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Actor authorization — must be admin+
    let actor_effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?
        .ok_or_else(|| (StatusCode::FORBIDDEN, "not a clan member".to_string()))?;

    if !actor_effective.is_admin() {
        return Err((StatusCode::FORBIDDEN, "clan admin required".to_string()));
    }

    // Cannot target self
    if auth.user_id == user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot change your own role".to_string()));
    }

    // Cannot target the owner
    if clan.owner_id == Some(user_id) {
        return Err((StatusCode::FORBIDDEN, "cannot change the owner's role".to_string()));
    }

    // Target must be an active member
    let target_row = fetch_member_row(&state.pool, clan_id, user_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "membership not found".to_string()))?;

    let target_current_role = ClanRole::from_str(&target_row.clan_role);

    // Validate new role value
    let new_role = match body.role.as_str() {
        "admin" => ClanRole::Admin,
        "moderator" => ClanRole::Moderator,
        "member" => ClanRole::Member,
        _ => return Err((StatusCode::BAD_REQUEST, "role must be admin, moderator, or member".to_string())),
    };

    // Hierarchy: actor's rank must be STRICTLY greater than BOTH the target's
    // current rank AND the requested new rank.
    let actor_rank = role_rank(actor_effective);
    let target_current_rank = role_rank(target_current_role);
    let new_rank = role_rank(new_role);

    if actor_rank <= target_current_rank || actor_rank <= new_rank {
        return Err((StatusCode::FORBIDDEN, "insufficient rank to assign this role".to_string()));
    }

    // Execute update
    sqlx::query(
        "UPDATE clan_memberships SET clan_role = $1 WHERE clan_id = $2 AND user_id = $3",
    )
    .bind(new_role.as_str())
    .bind(clan_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    // Re-fetch and return updated view
    let updated_row = fetch_member_row(&state.pool, clan_id, user_id)
        .await?
        .ok_or_else(|| (StatusCode::INTERNAL_SERVER_ERROR, "member vanished after update".to_string()))?;

    Ok(Json(build_member_view(updated_row, clan.owner_id)))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/clans/{cid}/members/{uid}  (kick)
// ---------------------------------------------------------------------------

pub async fn kick_member(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, user_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Actor must be moderator+
    let actor_effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .or_500()?
        .ok_or_else(|| (StatusCode::FORBIDDEN, "not a clan member".to_string()))?;

    if !actor_effective.is_moderator() {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    // Cannot kick self
    if auth.user_id == user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot kick yourself — use leave".to_string()));
    }

    // Cannot kick the owner
    if clan.owner_id == Some(user_id) {
        return Err((StatusCode::FORBIDDEN, "cannot kick the clan owner".to_string()));
    }

    // Target must be an active member
    let target_row = fetch_member_row(&state.pool, clan_id, user_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "membership not found".to_string()))?;

    let target_current_role = ClanRole::from_str(&target_row.clan_role);
    let actor_rank = role_rank(actor_effective);
    let target_rank = role_rank(target_current_role);

    // Actor's rank must be STRICTLY greater than target's rank
    if actor_rank <= target_rank {
        return Err((StatusCode::FORBIDDEN, "insufficient rank to kick this member".to_string()));
    }

    // Soft-remove
    sqlx::query(
        "UPDATE clan_memberships SET active = FALSE WHERE clan_id = $1 AND user_id = $2",
    )
    .bind(clan_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({"ok": true, "message": "member removed"})))
}
