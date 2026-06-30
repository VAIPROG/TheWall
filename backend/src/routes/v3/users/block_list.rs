//! Block list endpoints:
//!   GET    /api/v3/users/me/block-list
//!   POST   /api/v3/users/{user_ref}/block
//!   POST   /api/v3/users/{user_ref}/unblock

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
    models::UserProfilePublic,
    routes::v3::utils::audit,
};

use super::profile::{avatar_url_for, load_user, resolve_user_ref};

pub async fn get_block_list(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<UserProfilePublic>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, (Uuid,)>(
        "SELECT blocked_id FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at DESC",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut users = Vec::new();
    for (uid,) in rows {
        if let Some(user) = load_user(&state.pool, uid).await? {
            let avatar_url = avatar_url_for(&state.pool, uid).await?;
            users.push(UserProfilePublic {
                id: user.id,
                username: user.username,
                display_name: user.display_name,
                bio: user.bio,
                avatar_url,
                role: user.global_role,
                clan_id: None,
                created_at: user.created_at,
                social_accounts: vec![],
            });
        }
    }

    Ok(Json(users))
}

pub async fn block_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    if target_id == auth.user_id {
        return Err((StatusCode::BAD_REQUEST, "cannot block yourself".to_string()));
    }

    let result = sqlx::query(
        "INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await;

    match result {
        Ok(_) => {}
        Err(sqlx::Error::Database(db_err)) if db_err.code().as_deref() == Some("23505") => {
            return Ok(Json(json!({"ok": true, "message": "already blocked"})));
        }
        Err(e) => return Err((StatusCode::INTERNAL_SERVER_ERROR, e.to_string())),
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "user_blocked",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "blocked"})))
}

pub async fn unblock_user(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(user_ref): Path<String>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let target_id = resolve_user_ref(&state.pool, &user_ref).await?;

    let result = sqlx::query(
        "DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2",
    )
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if result.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "not blocked".to_string()));
    }

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "user_unblocked",
        "user",
        &target_id.to_string(),
        json!({}),
    )
    .await;

    Ok(Json(json!({"ok": true, "message": "unblocked"})))
}
