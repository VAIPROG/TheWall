//! POST /api/v3/users/me/appeal — submit an appeal by a banned (or restricted) user.
//!
//! This endpoint is intentionally reachable even when the caller is globally
//! banned (it is listed in the ban allow-list). It lets the user explain their
//! side and request a review.

use axum::{
    Json,
    extract::State,
    http::StatusCode,
};
use serde_json::json;

use crate::{
    AppState,
    auth::AuthUser,
    models::{UserAppeal, UserAppealCreate},
    routes::v3::utils::audit,
};

pub async fn submit_appeal(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<UserAppealCreate>,
) -> Result<(StatusCode, Json<UserAppeal>), (StatusCode, String)> {
    let reason = body.reason.trim().to_string();
    if reason.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "reason cannot be empty".to_string()));
    }
    if reason.len() > 5000 {
        return Err((StatusCode::BAD_REQUEST, "reason must be \u{2264}5000 characters".to_string()));
    }

    // Best-effort: prevent flood of pending appeals from the same user.
    let pending: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM user_appeals WHERE user_id = $1 AND status = 'pending'",
    )
    .bind(auth.user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if pending.is_some() {
        return Err((StatusCode::CONFLICT, "you already have a pending appeal".to_string()));
    }

    let row = sqlx::query_as::<_, crate::models::UserAppealRow>(
        r#"INSERT INTO user_appeals (user_id, reason)
           VALUES ($1, $2)
           RETURNING id, user_id, reason, status, moderator_notes, created_at, resolved_at, resolved_by"#,
    )
    .bind(auth.user_id)
    .bind(&reason)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let _ = audit::log_action(
        &state.pool,
        auth.user_id,
        "appeal_submitted",
        "user",
        &auth.user_id.to_string(),
        json!({ "appealId": row.id }),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        Json(UserAppeal {
            id: row.id,
            user_id: row.user_id,
            reason: row.reason,
            status: row.status,
            created_at: row.created_at,
        }),
    ))
}
