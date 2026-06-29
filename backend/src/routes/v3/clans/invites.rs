//! GET    /api/v3/clans/{id}/invites         — list invites (mod+)
//! POST   /api/v3/clans/{id}/invites         — create invite (who_can_invite rank+)
//! DELETE /api/v3/clans/{cid}/invites/{iid}  — revoke invite (mod+ or creator)

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use chrono::Utc;
use rand::Rng;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanInviteCreate, ClanInviteView, ClanV3},
    routes::v3::utils::{permissions::{ClanRole, effective_clan_role}, sanctions},
};

use super::load_clan;

// ---------------------------------------------------------------------------
// who_can_invite helper
// ---------------------------------------------------------------------------

/// Parse `settings.chatPermissions.whoCanInvite` to the minimum ClanRole needed
/// to create an invite. Defaults to Moderator if absent or unrecognised.
fn who_can_invite_min(clan: &ClanV3) -> ClanRole {
    let val = clan
        .settings
        .get("chatPermissions")
        .and_then(|v| v.get("whoCanInvite"))
        .and_then(|v| v.as_str())
        .unwrap_or("moderators");

    match val {
        "owner" => ClanRole::Owner,
        "admins" => ClanRole::Admin,
        "moderators" => ClanRole::Moderator,
        "members" => ClanRole::Member,
        _ => ClanRole::Moderator,
    }
}

// ---------------------------------------------------------------------------
// Alphanumeric code generator
// ---------------------------------------------------------------------------

const INVITE_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

fn gen_code() -> String {
    let mut rng = rand::thread_rng();
    (0..8)
        .map(|_| INVITE_CHARS[rng.gen_range(0..INVITE_CHARS.len())] as char)
        .collect()
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/invites
// ---------------------------------------------------------------------------

pub async fn list_invites(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<Vec<ClanInviteView>>, (StatusCode, String)> {
    let _clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let actor_role = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !actor_role.map(|r| r.is_moderator()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    let rows: Vec<(Uuid, String, Option<Uuid>, Option<Uuid>, Option<i32>, i32, Option<chrono::DateTime<Utc>>, chrono::DateTime<Utc>)> =
        sqlx::query_as(
            r#"SELECT id, code, created_by, target_user_id, max_uses, use_count, expires_at, created_at
               FROM clan_invites
               WHERE clan_id = $1
               ORDER BY created_at DESC"#,
        )
        .bind(clan_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let invites = rows
        .into_iter()
        .map(|(id, code, created_by, target_user_id, max_uses, use_count, expires_at, created_at)| {
            ClanInviteView {
                id,
                code,
                created_by,
                target_user_id,
                max_uses,
                use_count,
                expires_at,
                created_at,
            }
        })
        .collect();

    Ok(Json(invites))
}

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{id}/invites
// ---------------------------------------------------------------------------

pub async fn create_invite(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanInviteCreate>,
) -> Result<(StatusCode, Json<ClanInviteView>), (StatusCode, String)> {
    // Enforcement: bans block all writes; InviteToClan blocks clan invites.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[
            (sanctions::Sanction::Ban, None),
            (sanctions::Sanction::InviteToClan, Some(clan_id)),
        ],
    )
    .await?;

    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    let min_role = who_can_invite_min(&clan);

    let actor_role = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let actor_role = actor_role.ok_or_else(|| (StatusCode::FORBIDDEN, "not a clan member".to_string()))?;

    if actor_role < min_role {
        return Err((StatusCode::FORBIDDEN, "insufficient rank to create invites".to_string()));
    }

    // Validate target_user_id if present
    if let Some(target_uid) = body.target_user_id {
        let exists: Option<(Uuid,)> = sqlx::query_as("SELECT id FROM users WHERE id = $1")
            .bind(target_uid)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if exists.is_none() {
            return Err((StatusCode::BAD_REQUEST, "target user not found".to_string()));
        }
    }

    // Compute expires_at with clamped range 1..=720 hours
    let expires_at = body.expires_in_hours.map(|h| {
        let clamped = h.clamp(1, 720);
        Utc::now() + chrono::Duration::hours(clamped)
    });

    // Generate unique code (retry on collision)
    let invite: (Uuid, String, Option<Uuid>, Option<Uuid>, Option<i32>, i32, Option<chrono::DateTime<Utc>>, chrono::DateTime<Utc>) = loop {
        let code = gen_code();
        let result = sqlx::query_as(
            r#"INSERT INTO clan_invites (clan_id, code, created_by, target_user_id, max_uses, expires_at)
               VALUES ($1, $2, $3, $4, $5, $6)
               RETURNING id, code, created_by, target_user_id, max_uses, use_count, expires_at, created_at"#,
        )
        .bind(clan_id)
        .bind(&code)
        .bind(auth.user_id)
        .bind(body.target_user_id)
        .bind(body.max_uses)
        .bind(expires_at)
        .fetch_one(&state.pool)
        .await;

        match result {
            Ok(row) => break row,
            Err(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("23505") => {
                // UNIQUE collision on code — retry
                continue;
            }
            Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        }
    };

    let view = ClanInviteView {
        id: invite.0,
        code: invite.1,
        created_by: invite.2,
        target_user_id: invite.3,
        max_uses: invite.4,
        use_count: invite.5,
        expires_at: invite.6,
        created_at: invite.7,
    };

    Ok((StatusCode::CREATED, Json(view)))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/clans/{cid}/invites/{iid}
// ---------------------------------------------------------------------------

pub async fn revoke_invite(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, invite_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Load the invite — must belong to this clan
    let invite: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
        "SELECT id, created_by FROM clan_invites WHERE id = $1 AND clan_id = $2",
    )
    .bind(invite_id)
    .bind(clan_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (_id, created_by) = invite
        .ok_or_else(|| (StatusCode::NOT_FOUND, "invite not found".to_string()))?;

    // Allowed if actor is moderator+ OR is the invite creator
    let actor_role = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let is_mod = actor_role.map(|r| r.is_moderator()).unwrap_or(false);
    let is_creator = created_by == Some(auth.user_id);

    if !is_mod && !is_creator {
        return Err((StatusCode::FORBIDDEN, "cannot revoke this invite".to_string()));
    }

    sqlx::query("DELETE FROM clan_invites WHERE id = $1")
        .bind(invite_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({"ok": true, "message": "invite revoked"})))
}
