use axum::{
    extract::{Json, State},
    http::StatusCode,
};

use crate::{
    AppState,
    auth::AuthUser,
    models::{AccountPublic, ProviderLink, SiteIdentity, User},
};

// ---------------------------------------------------------------------------
// GET /api/v3/auth/session — current account + identities + providers
// ---------------------------------------------------------------------------

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub user: AccountPublic,
    pub site_identities: Vec<SiteIdentity>,
    pub providers: Vec<ProviderLink>,
}

pub async fn session(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<SessionInfo>, StatusCode> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(auth.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    let site_identities = sqlx::query_as::<_, SiteIdentity>(
        "SELECT * FROM site_identities WHERE account_id = $1 ORDER BY linked_at",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let providers = sqlx::query_as::<_, ProviderLink>(
        "SELECT * FROM provider_links WHERE account_id = $1 ORDER BY linked_at",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(SessionInfo {
        user: super::account_public(&user),
        site_identities,
        providers,
    }))
}
