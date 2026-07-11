//! Read-state endpoint:
//!   POST /api/v3/chats/{cid}/read
use crate::http_error::ResultExt;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::ChatReadRequest,
};

use super::resolve::{can_access_chat, load_chat};

// ---------------------------------------------------------------------------
// POST /api/v3/chats/{chat_id}/read
// ---------------------------------------------------------------------------

pub async fn mark_read(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(chat_id): Path<Uuid>,
    Json(body): Json<ChatReadRequest>,
) -> Result<Json<Value>, (StatusCode, String)> {
    // Load and access-check the chat.
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    // Resolve the target message id.
    let target_id: Option<Uuid> = if let Some(msg_id) = body.message_id {
        // Caller specified a message — validate it belongs to this chat.
        let exists: Option<bool> = sqlx::query_scalar(
            "SELECT TRUE FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL",
        )
        .bind(msg_id)
        .bind(chat_id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?;

        if exists.is_none() {
            return Err((StatusCode::BAD_REQUEST, "message not found in this chat".to_string()));
        }
        Some(msg_id)
    } else {
        // No message specified — use the latest non-deleted message.
        sqlx::query_scalar::<_, Uuid>(
            "SELECT id FROM messages \
             WHERE chat_id = $1 AND deleted_at IS NULL \
             ORDER BY created_at DESC \
             LIMIT 1",
        )
        .bind(chat_id)
        .fetch_optional(&state.pool)
        .await
        .or_500()?
    };

    // Upsert the read state (even if target_id is None — empty chat is still "read").
    sqlx::query(
        "INSERT INTO chat_reads (chat_id, account_id, last_read_message_id, updated_at) \
         VALUES ($1, $2, $3, NOW()) \
         ON CONFLICT (chat_id, account_id) DO UPDATE \
             SET last_read_message_id = EXCLUDED.last_read_message_id, \
                 updated_at = NOW()",
    )
    .bind(chat_id)
    .bind(auth.user_id)
    .bind(target_id)
    .execute(&state.pool)
    .await
    .or_500()?;

    Ok(Json(json!({"ok": true})))
}
