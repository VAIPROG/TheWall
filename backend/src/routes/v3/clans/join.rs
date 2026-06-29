//! POST /api/v3/clans/{id}/join            — join a clan (open/invite/approval flows)
//! POST /api/v3/clans/{cid}/apply/{role}  — apply for a staff role (admin/moderator)

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ClanJoinRequest, ClanRoleApplicationReq},
    routes::v3::utils::permissions::effective_clan_role,
};

use super::load_clan;

// ---------------------------------------------------------------------------
// Membership upsert helper
// ---------------------------------------------------------------------------

async fn add_membership(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    clan_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    sqlx::query(
        r#"INSERT INTO clan_memberships (id, user_id, clan_id, clan_role, active)
           VALUES (gen_random_uuid(), $1, $2, 'member', TRUE)
           ON CONFLICT (user_id, clan_id) DO UPDATE SET active = TRUE, clan_role = 'member'"#,
    )
    .bind(user_id)
    .bind(clan_id)
    .execute(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{id}/join
// ---------------------------------------------------------------------------

pub async fn join_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ClanJoinRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Already an active member?
    let is_active: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM clan_memberships WHERE user_id = $1 AND clan_id = $2 AND active = TRUE",
    )
    .bind(auth.user_id)
    .bind(clan_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let is_owner = clan.owner_id == Some(auth.user_id);

    if is_owner || is_active.is_some() {
        return Err((StatusCode::CONFLICT, "already a member".to_string()));
    }

    // Capacity check
    if let Some(max) = clan.max_members {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM clan_memberships WHERE clan_id = $1 AND active = TRUE",
        )
        .bind(clan_id)
        .fetch_one(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if count >= max as i64 {
            return Err((StatusCode::CONFLICT, "clan is full".to_string()));
        }
    }

    // Resolve invite code (if provided)
    struct InviteInfo {
        id: Uuid,
    }

    let invite_info: Option<InviteInfo> = if let Some(ref code) = body.invite_code {
        let row: Option<(Uuid, Option<Uuid>)> = sqlx::query_as(
            r#"SELECT id, target_user_id
               FROM clan_invites
               WHERE clan_id = $1
                 AND code = $2
                 AND (expires_at IS NULL OR expires_at > NOW())
                 AND (max_uses IS NULL OR use_count < max_uses)"#,
        )
        .bind(clan_id)
        .bind(code)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        match row {
            None => {
                return Err((StatusCode::BAD_REQUEST, "invite code is invalid or expired".to_string()));
            }
            Some((invite_id, target_uid)) => {
                // If the invite targets a specific user, it must be the caller
                if let Some(target) = target_uid {
                    if target != auth.user_id {
                        return Err((StatusCode::FORBIDDEN, "this invite is for a different user".to_string()));
                    }
                }
                Some(InviteInfo { id: invite_id })
            }
        }
    } else {
        None
    };

    let has_valid_invite = invite_info.is_some();

    // Branch on join_policy
    match clan.join_policy.as_str() {
        "open" => {
            add_membership(&state.pool, auth.user_id, clan_id).await?;
            if let Some(inv) = invite_info {
                increment_invite_use(&state.pool, inv.id).await?;
            }
            Ok(Json(json!({"ok": true, "message": "joined"})))
        }
        "invite_only" => {
            if !has_valid_invite {
                return Err((StatusCode::FORBIDDEN, "invite required".to_string()));
            }
            add_membership(&state.pool, auth.user_id, clan_id).await?;
            if let Some(inv) = invite_info {
                increment_invite_use(&state.pool, inv.id).await?;
            }
            Ok(Json(json!({"ok": true, "message": "joined"})))
        }
        "approval_required" => {
            if has_valid_invite {
                // Invite bypasses approval
                add_membership(&state.pool, auth.user_id, clan_id).await?;
                if let Some(inv) = invite_info {
                    increment_invite_use(&state.pool, inv.id).await?;
                }
                return Ok(Json(json!({"ok": true, "message": "joined"})));
            }

            // Check for existing pending application
            let already_pending: Option<bool> = sqlx::query_scalar(
                "SELECT TRUE FROM clan_join_applications WHERE clan_id = $1 AND applicant_id = $2 AND status = 'pending'",
            )
            .bind(clan_id)
            .bind(auth.user_id)
            .fetch_optional(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            if already_pending.is_some() {
                return Err((StatusCode::CONFLICT, "application already pending".to_string()));
            }

            sqlx::query(
                "INSERT INTO clan_join_applications (clan_id, applicant_id) VALUES ($1, $2)",
            )
            .bind(clan_id)
            .bind(auth.user_id)
            .execute(&state.pool)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

            Ok(Json(json!({"ok": true, "message": "application submitted"})))
        }
        other => {
            // Unknown policy — treat as open for forward-compat
            tracing::warn!("unknown join_policy '{}' for clan {}, treating as open", other, clan_id);
            add_membership(&state.pool, auth.user_id, clan_id).await?;
            if let Some(inv) = invite_info {
                increment_invite_use(&state.pool, inv.id).await?;
            }
            Ok(Json(json!({"ok": true, "message": "joined"})))
        }
    }
}

async fn increment_invite_use(
    pool: &sqlx::PgPool,
    invite_id: Uuid,
) -> Result<(), (StatusCode, String)> {
    sqlx::query("UPDATE clan_invites SET use_count = use_count + 1 WHERE id = $1")
        .bind(invite_id)
        .execute(pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{cid}/apply/{role}
// ---------------------------------------------------------------------------

pub async fn apply_for_role(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((clan_id, role)): Path<(Uuid, String)>,
    Json(body): Json<ClanRoleApplicationReq>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let _clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Role must be admin or moderator
    if role != "admin" && role != "moderator" {
        return Err((StatusCode::BAD_REQUEST, "role must be 'admin' or 'moderator'".to_string()));
    }

    // Caller must be an active member
    let effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if effective.is_none() {
        return Err((StatusCode::FORBIDDEN, "must be a member".to_string()));
    }

    // Message length limit
    if let Some(ref msg) = body.message {
        if msg.chars().count() > 1000 {
            return Err((StatusCode::BAD_REQUEST, "message must be ≤1000 characters".to_string()));
        }
    }

    // Insert, 409 if pending already exists (unique index on pending)
    let result = sqlx::query(
        r#"INSERT INTO clan_role_applications (clan_id, applicant_id, requested_role, message)
           VALUES ($1, $2, $3, $4)"#,
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .bind(&role)
    .bind(&body.message)
    .execute(&state.pool)
    .await;

    match result {
        Err(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("23505") => {
            Err((StatusCode::CONFLICT, "application already pending for this role".to_string()))
        }
        Err(e) => Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
        Ok(_) => Ok(Json(json!({"ok": true, "message": "application submitted"}))),
    }
}
