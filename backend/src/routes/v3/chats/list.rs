//! Chat list handler:
//!   GET /api/v3/chats — all chats visible to the caller with unread counts

use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use serde::Deserialize;

use crate::{
    AppState,
    auth::AuthUser,
    models::{ChatSummaryView, ChatV3},
    routes::v3::utils::chat_messages,
};

use super::resolve::{can_access_chat, dm_key_for};

#[derive(Debug, Deserialize)]
pub struct ChatListQuery {
    pub clan_id: Option<uuid::Uuid>,
}

// ---------------------------------------------------------------------------
// GET /api/v3/chats
// ---------------------------------------------------------------------------

pub async fn list_chats(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<ChatListQuery>,
) -> Result<Json<Vec<ChatSummaryView>>, (StatusCode, String)> {
    let mut chats: Vec<ChatV3> = Vec::new();

    // Always include the global chat.
    let global: Vec<ChatV3> = sqlx::query_as(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at, opener_id \
         FROM chats WHERE type = 'global'",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    chats.extend(global);

    // Clan chats the user is a member of.
    let clan_chats: Vec<ChatV3> = if let Some(cid) = q.clan_id {
        sqlx::query_as(
            "SELECT c.id, c.type, c.clan_id, c.dm_key, c.topic, c.slowmode_seconds, c.created_at, c.opener_id \
             FROM chats c \
             JOIN clan_memberships m ON m.clan_id = c.clan_id \
             WHERE c.type = 'clan' AND c.clan_id = $1 \
               AND m.user_id = $2 AND m.active = TRUE",
        )
        .bind(cid)
        .bind(auth.user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        sqlx::query_as(
            "SELECT c.id, c.type, c.clan_id, c.dm_key, c.topic, c.slowmode_seconds, c.created_at, c.opener_id \
             FROM chats c \
             JOIN clan_memberships m ON m.clan_id = c.clan_id \
             WHERE c.type = 'clan' AND m.user_id = $1 AND m.active = TRUE",
        )
        .bind(auth.user_id)
        .fetch_all(&state.pool)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };
    chats.extend(clan_chats);

    // DM chats where the user is one of the two participants.
    // Use an exact match on the canonical dm_key to avoid prefix/suffix bugs.
    let dm_key_1 = dm_key_for(auth.user_id, uuid::Uuid::nil());
    let dm_key_2 = dm_key_for(uuid::Uuid::nil(), auth.user_id);
    let dm_chats: Vec<ChatV3> = sqlx::query_as(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at, opener_id \
         FROM chats \
         WHERE type = 'dm' AND (dm_key = $1 OR dm_key = $2)"
    )
    .bind(&dm_key_1)
    .bind(&dm_key_2)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    chats.extend(dm_chats);

    // Modmail thread for the caller.
    let modmail: Vec<ChatV3> = sqlx::query_as(
        "SELECT id, type, clan_id, dm_key, topic, slowmode_seconds, created_at, opener_id \
         FROM chats WHERE type = 'modmail' AND opener_id = $1",
    )
    .bind(auth.user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    chats.extend(modmail);

    // Filter to chats the caller can actually access.
    let mut accessible = Vec::new();
    for chat in chats {
        if can_access_chat(&state.pool, auth.user_id, &chat).await? {
            accessible.push(chat);
        }
    }

    // Batch compute unread counts and last message timestamps.
    let chat_ids: Vec<uuid::Uuid> = accessible.iter().map(|c| c.id).collect();
    let read_states =
        chat_messages::batch_chat_unread_and_last_message(&state.pool, &chat_ids, auth.user_id).await?;

    let mut summaries: Vec<ChatSummaryView> = accessible
        .into_iter()
        .map(|chat| {
            let (unread_count, last_message_at) = read_states
                .get(&chat.id)
                .copied()
                .unwrap_or((0, None));
            ChatSummaryView {
                id: chat.id,
                chat_type: chat.chat_type,
                clan_id: chat.clan_id,
                dm_key: chat.dm_key,
                topic: chat.topic,
                slowmode_seconds: chat.slowmode_seconds,
                created_at: chat.created_at,
                unread_count,
                last_message_at,
            }
        })
        .collect();

    // Sort by last message desc, then creation desc.
    summaries.sort_by(|a, b| {
        b.last_message_at
            .cmp(&a.last_message_at)
            .then_with(|| b.created_at.cmp(&a.created_at))
    });

    Ok(Json(summaries))
}
