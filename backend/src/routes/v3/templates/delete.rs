//! DELETE /api/v3/templates/{id}
//!
//! Permission matrix:
//!   - Owner of the template (user_id = auth.user_id) — always allowed.
//!   - Global admin / owner (global_role_of().is_admin()) — always allowed.
//!   - Clan moderator+ of the template's clan (effective_clan_role().is_moderator())
//!     — allowed for clan-scoped templates.
//!
//! Note: the "membersCanDeleteOwnTemplates" clan setting is deferred to a
//! later slice. For this slice, the owner may always delete their own template.

use axum::{
    extract::{Path, State},
    http::StatusCode,
};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    routes::v3::utils::permissions,
};

pub async fn delete(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<StatusCode, (StatusCode, String)> {
    // Load the template's ownership + scope + clan for permission checks.
    let row: Option<(Uuid, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT user_id, scope, clan_id FROM templates WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (owner_id, scope, clan_id) = row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    // ── Permission check ─────────────────────────────────────────────────────
    let is_owner = owner_id == auth.user_id;

    let global_role = permissions::global_role_of(&state.pool, auth.user_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let is_global_admin = global_role.is_admin();

    let is_clan_mod = if scope == "clan" {
        if let Some(cid) = clan_id {
            permissions::effective_clan_role(&state.pool, auth.user_id, cid)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
                .map(|r| r.is_moderator())
                .unwrap_or(false)
        } else {
            false
        }
    } else {
        false
    };

    if !is_owner && !is_global_admin && !is_clan_mod {
        return Err((StatusCode::FORBIDDEN, "forbidden".into()));
    }

    // ── Delete ───────────────────────────────────────────────────────────────
    sqlx::query("DELETE FROM templates WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}
