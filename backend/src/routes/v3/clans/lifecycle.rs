//! POST /api/v3/clans/{id}/leave    — leave a clan (non-owners only)
//! POST /api/v3/clans/{id}/disband  — disband a clan (owner or global admin+)

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
    models::ConfirmRequest,
    routes::v3::utils::permissions::global_role_of,
};

use super::load_clan;

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{id}/leave
// ---------------------------------------------------------------------------

pub async fn leave_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Owner cannot leave — must transfer ownership first
    if clan.owner_id == Some(auth.user_id) {
        return Err((StatusCode::CONFLICT, "transfer ownership before leaving".to_string()));
    }

    // Check active membership exists
    let rows_updated = sqlx::query(
        "UPDATE clan_memberships SET active = FALSE WHERE clan_id = $1 AND user_id = $2 AND active = TRUE",
    )
    .bind(clan_id)
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .rows_affected();

    if rows_updated == 0 {
        return Err((StatusCode::CONFLICT, "not a member".to_string()));
    }

    Ok(Json(json!({"ok": true, "message": "left clan"})))
}

// ---------------------------------------------------------------------------
// POST /api/v3/clans/{id}/disband
// ---------------------------------------------------------------------------

pub async fn disband_clan(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Json(body): Json<ConfirmRequest>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let clan = load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // Authorization: clan owner OR global admin+
    let is_owner = clan.owner_id == Some(auth.user_id);
    if !is_owner {
        let global_role = global_role_of(&state.pool, auth.user_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        if !global_role.is_admin() {
            return Err((StatusCode::FORBIDDEN, "only the clan owner or a global admin may disband this clan".to_string()));
        }
    }

    // Require explicit confirmation
    if !body.confirm {
        return Err((StatusCode::BAD_REQUEST, "confirm must be true to disband the clan".to_string()));
    }

    // Delete — FKs on clan_memberships and chats reference clans ON DELETE CASCADE
    sqlx::query("DELETE FROM clans WHERE id = $1")
        .bind(clan_id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({"ok": true, "message": "clan disbanded"})))
}
