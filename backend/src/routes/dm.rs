use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
};
use serde::{Deserialize, Serialize};
use crate::http_error::ResultExt;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser};

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct DmRow {
    pub id: Uuid,
    pub from_user_id: Uuid,
    pub to_user_id: Uuid,
    pub text: String,
    pub read: bool,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct DmQuery {
    pub peer: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
pub struct SendDmRequest {
    pub to: Uuid,
    pub text: String,
}

// GET /api/dm?peer=<uuid>  → conversation, or inbox if no peer
pub async fn list_dms(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<DmQuery>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let rows = if let Some(peer) = q.peer {
        sqlx::query_as::<_, DmRow>(
            "SELECT * FROM direct_messages WHERE (from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1) ORDER BY created_at ASC LIMIT 200"
        )
        .bind(auth.user_id)
        .bind(peer)
        .fetch_all(&state.pool)
        .await
    } else {
        sqlx::query_as::<_, DmRow>(
            "SELECT * FROM direct_messages WHERE to_user_id = $1 ORDER BY created_at DESC LIMIT 50"
        )
        .bind(auth.user_id)
        .fetch_all(&state.pool)
        .await
    }
    .or_500()?;
    Ok(Json(rows))
}

// POST /api/dm
pub async fn send_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<SendDmRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    if body.text.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "empty text".to_string()));
    }
    if body.text.len() > 4000 {
        return Err((StatusCode::PAYLOAD_TOO_LARGE, "max 4000 chars".to_string()));
    }
    sqlx::query(
        "INSERT INTO direct_messages (id, from_user_id, to_user_id, text, read, created_at) VALUES (gen_random_uuid(), $1, $2, $3, false, NOW())"
    )
    .bind(auth.user_id)
    .bind(body.to)
    .bind(&body.text)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok((StatusCode::CREATED, Json(serde_json::json!({"ok": true}))))
}

// POST /api/dm/read — mark all from peer as read
#[derive(Debug, Deserialize)]
pub struct DmReadBody {
    pub peer: Uuid,
}
pub async fn mark_dm_read(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DmReadBody>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    sqlx::query(
        "UPDATE direct_messages SET read = true WHERE to_user_id = $1 AND from_user_id = $2",
    )
    .bind(auth.user_id)
    .bind(body.peer)
    .execute(&state.pool)
    .await
    .or_500()?;
    Ok(StatusCode::NO_CONTENT)
}

// DELETE /api/dm/{id}
pub async fn delete_dm(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    sqlx::query("DELETE FROM direct_messages WHERE id = $1 AND from_user_id = $2")
        .bind(id)
        .bind(auth.user_id)
        .execute(&state.pool)
        .await
        .or_500()?;
    Ok(StatusCode::NO_CONTENT)
}
