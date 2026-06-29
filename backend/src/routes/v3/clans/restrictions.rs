//! GET /api/v3/clans/{id}/restrictions — list clan-scoped restrictions (stub).
//!
//! restrictions backend is part of the moderation subsystem (not yet implemented);
//! returns empty until then.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};
use crate::routes::v3::utils::permissions::effective_clan_role;

use super::load_clan;

// ---------------------------------------------------------------------------
// Query params
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct RestrictionsQuery {
    pub page: Option<i64>,
    pub per_page: Option<i64>,
}

// ---------------------------------------------------------------------------
// Empty response shape (RestrictionPage)
// ---------------------------------------------------------------------------

/// Stub paginated response — matches `RestrictionPage` in
/// openapi/components/schemas/restrictions.yaml.
/// Returns empty until the moderation subsystem implements the restrictions table.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestrictionPage {
    pub items: Vec<serde_json::Value>,
    pub page: i64,
    pub per_page: i64,
    pub total: i64,
    pub total_pages: i64,
}

// ---------------------------------------------------------------------------
// GET /api/v3/clans/{id}/restrictions
// ---------------------------------------------------------------------------

pub async fn list_clan_restrictions(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(clan_id): Path<Uuid>,
    Query(q): Query<RestrictionsQuery>,
) -> Result<Json<RestrictionPage>, (StatusCode, String)> {
    // ── clan existence check ──────────────────────────────────────────────────
    load_clan(&state.pool, clan_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "clan not found".to_string()))?;

    // ── require clan moderator or higher ─────────────────────────────────────
    let effective = effective_clan_role(&state.pool, auth.user_id, clan_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if !effective.map(|r| r.is_moderator()).unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, "clan moderator required".to_string()));
    }

    let page = q.page.unwrap_or(1).max(1);
    let per_page = q.per_page.unwrap_or(50).clamp(1, 100);

    // restrictions backend is part of the moderation subsystem (not yet implemented);
    // returns empty until then.
    Ok(Json(RestrictionPage {
        items: vec![],
        page,
        per_page,
        total: 0,
        total_pages: 0,
    }))
}
