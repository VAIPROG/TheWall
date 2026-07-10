//! Message reactions handler:
//!   POST   /api/v3/chats/{cid}/messages/{mid}/reactions
//!   DELETE /api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    models::{MessageJoinRow, MessageView, Reaction},
    routes::v3::utils::chat_messages,
};

use super::resolve::{can_access_chat, load_chat};

#[derive(Debug, Deserialize)]
pub struct ReactionBody {
    pub emoji: String,
}

// ---------------------------------------------------------------------------
// GET helper: attach reactions to a batch of messages
// ---------------------------------------------------------------------------

pub async fn attach_reactions(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    messages: &mut [MessageView],
) -> Result<(), (StatusCode, String)> {
    if messages.is_empty() {
        return Ok(());
    }

    let ids: Vec<Uuid> = messages.iter().map(|m| m.id).collect();

    let rows: Vec<(Uuid, String, i64, bool)> = sqlx::query_as(
        r#"SELECT message_id, emoji, COUNT(*) AS cnt,
                  BOOL_OR(account_id = $1) AS reacted_by_me
             FROM message_reactions
            WHERE message_id = ANY($2)
            GROUP BY message_id, emoji"#,
    )
    .bind(viewer_id)
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    for (message_id, emoji, count, reacted_by_me) in rows {
        if let Some(msg) = messages.iter_mut().find(|m| m.id == message_id) {
            msg.reactions.push(Reaction {
                emoji,
                count,
                reacted_by_me,
            });
        }
    }

    Ok(())
}

pub async fn attach_reactions_one(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    message: &mut MessageView,
) -> Result<(), (StatusCode, String)> {
    let mut slice = std::slice::from_mut(message);
    attach_reactions(pool, viewer_id, &mut slice).await
}

// ---------------------------------------------------------------------------
// POST /api/v3/chats/{chat_id}/messages/{message_id}/reactions
// ---------------------------------------------------------------------------

pub async fn add_reaction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(Uuid, Uuid, String)>,
) -> Result<(StatusCode, Json<serde_json::Value>), (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    let message_exists: Option<bool> = sqlx::query_scalar(
        "SELECT TRUE FROM messages WHERE id = $1 AND chat_id = $2 AND deleted_at IS NULL",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if message_exists.is_none() {
        return Err((StatusCode::NOT_FOUND, "message not found".to_string()));
    }

    let emoji = emoji.trim();
    if emoji.is_empty() || emoji.chars().count() > 16 {
        return Err((StatusCode::BAD_REQUEST, "invalid emoji".to_string()));
    }

    sqlx::query(
        "INSERT INTO message_reactions (message_id, account_id, emoji) \
         VALUES ($1, $2, $3) \
         ON CONFLICT (message_id, account_id, emoji) DO NOTHING",
    )
    .bind(message_id)
    .bind(auth.user_id)
    .bind(emoji)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok((StatusCode::CREATED, Json(json!({"ok": true}))))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/chats/{chat_id}/messages/{message_id}/reactions/{emoji}
// ---------------------------------------------------------------------------

pub async fn remove_reaction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(Uuid, Uuid, String)>,
) -> Result<Json<serde_json::Value>, (StatusCode, String)> {
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    sqlx::query(
        "DELETE FROM message_reactions \
         WHERE message_id = $1 AND account_id = $2 AND emoji = $3",
    )
    .bind(message_id)
    .bind(auth.user_id)
    .bind(emoji)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({"ok": true})))
}

// ---------------------------------------------------------------------------
// Internal helper for route modules that need to re-fetch a single message
// with reactions attached.
// ---------------------------------------------------------------------------

pub async fn load_message_with_reactions(
    pool: &sqlx::PgPool,
    viewer_id: Uuid,
    message_id: Uuid,
) -> Result<Option<MessageView>, (StatusCode, String)> {
    let cols = chat_messages::MESSAGE_COLUMNS;
    let mut rows: Vec<MessageView> = sqlx::query_as::<_, MessageJoinRow>(&format!(
        "SELECT {cols} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = $1"
    ))
    .bind(message_id)
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    .into_iter()
    .map(|r| r.into_view())
    .collect();

    if rows.is_empty() {
        return Ok(None);
    }

    attach_reactions(pool, viewer_id, &mut rows).await?;
    Ok(rows.into_iter().next())
}
