use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{AckRequest, Notification},
};

/// GET /api/notifications
///
/// Returns all unread notifications for the authenticated user,
/// ordered by creation time descending.
pub async fn list(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Vec<Notification>>, StatusCode> {
    let notifications = sqlx::query_as::<_, Notification>(
        r#"
        SELECT id, user_id, title, body, read, created_at
        FROM notifications
        WHERE user_id = $1
          AND read = false
        ORDER BY created_at DESC
        "#,
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(Json(notifications))
}

/// POST /api/notifications/ack
///
/// Marks the given notification IDs as read, scoped to the authenticated user.
/// Returns 204 No Content on success.
pub async fn ack(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<AckRequest>,
) -> Result<impl IntoResponse, StatusCode> {
    let ids: Vec<Uuid> = body.ids;
    sqlx::query(
        r#"
        UPDATE notifications
        SET read = true
        WHERE id = ANY($1)
          AND user_id = $2
        "#,
    )
    .bind(&ids[..])
    .bind(auth.user_id)
    .execute(&state.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    Ok(StatusCode::NO_CONTENT)
}
