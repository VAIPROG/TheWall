use axum::{Json, extract::State, http::StatusCode, response::IntoResponse};
use serde::Serialize;

use crate::AppState;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct LeaderboardEntry {
    pub username: String,
    pub messages: i64,
}

pub async fn leaderboard(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, LeaderboardEntry>(
        r#"
        SELECT u.username, COUNT(cm.id) AS messages
        FROM users u
        LEFT JOIN clan_messages cm ON cm.user_id = u.id
        GROUP BY u.id, u.username
        ORDER BY messages DESC
        LIMIT 20
        "#,
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(rows))
}
