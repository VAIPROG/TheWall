use axum::{
    extract::{Json, State},
    http::{HeaderMap, StatusCode},
};
use chrono::Utc;

use crate::{
    AppState,
    auth::{AuthUser, hash_token, issue_session_pair},
    models::{Session, User, V3AuthResponse, V3RefreshRequest},
};

// ---------------------------------------------------------------------------
// POST /api/v3/auth/refresh
// ---------------------------------------------------------------------------

pub async fn refresh(
    State(state): State<AppState>,
    Json(body): Json<V3RefreshRequest>,
) -> Result<Json<V3AuthResponse>, StatusCode> {
    let refresh_hash = hash_token(&body.refresh_token);
    let now = Utc::now();

    let session = sqlx::query_as::<_, Session>(
        "SELECT * FROM sessions WHERE refresh_hash = $1 AND expires_at > $2 LIMIT 1",
    )
    .bind(&refresh_hash)
    .bind(now)
    .fetch_optional(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .ok_or(StatusCode::UNAUTHORIZED)?;

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(session.user_id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        .ok_or(StatusCode::UNAUTHORIZED)?;

    // Delete old session.
    sqlx::query("DELETE FROM sessions WHERE id = $1")
        .bind(session.id)
        .execute(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    // Issue new session pair.
    let (access, new_refresh) = issue_session_pair(&state.pool, &state.config.jwt_secret, user.id)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(super::v3_response(access, new_refresh, &user)))
}

// ---------------------------------------------------------------------------
// POST /api/v3/auth/logout
// ---------------------------------------------------------------------------
//
// NOTE (slice 1 simplification): deletes ALL sessions for the user — i.e.,
// logs out everywhere. A future slice can narrow this to delete only the
// session matching the Bearer token's hash.

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthUser,
    _headers: HeaderMap,
) -> Result<StatusCode, StatusCode> {
    sqlx::query("DELETE FROM sessions WHERE user_id = $1")
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}
