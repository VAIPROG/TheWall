//! `GET /api/v3/clans/mine` — the caller's own clans, resolved directly instead
//! of scanning the paginated public list and filtering by membership.

use axum::{Json, extract::State, http::StatusCode};
use uuid::Uuid;

use super::{build_clan_view, load_clan};
use crate::http_error::ResultExt;
use crate::models::ClanView;
use crate::{AppState, auth::AuthUser};

// GET /api/v3/clans/mine — active memberships plus owned clans (usually 0–1).
pub async fn get_my_clans(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ClanView>>, (StatusCode, String)> {
    // Owners are tracked on `clans.owner_id` and may lack a membership row, so
    // union both sources. Deduped by UNION.
    let clan_ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT clan_id FROM clan_memberships WHERE user_id = $1 AND active = TRUE \
         UNION \
         SELECT id FROM clans WHERE owner_id = $1",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .or_500()?;

    let mut out = Vec::with_capacity(clan_ids.len());
    for id in clan_ids {
        if let Some(clan) = load_clan(&state.pool, id).await? {
            out.push(build_clan_view(&state.pool, Some(auth.user_id), clan).await?);
        }
    }
    Ok(Json(out))
}
