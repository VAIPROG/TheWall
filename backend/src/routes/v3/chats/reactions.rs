//! Reaction endpoints:
//!   PUT    /api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}
//!   DELETE /api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}

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
    models::{MessageJoinRow, MessageView, Reaction},
    routes::v3::utils::sanctions,
};

use super::resolve::{can_access_chat, load_chat};

/// The MSG_COLS constant duplicated here to avoid cross-module coupling.
const MSG_COLS: &str = r#"
    m.id, m.chat_id, m.author_id, m.content, m.reply_to_id,
    m.edited_at, m.edit_count, m.deleted_at, m.deleted_by,
    m.is_system, m.version, m.created_at,
    u.username AS author_username
"#;

// ---------------------------------------------------------------------------
// Helper — attach reactions for a single message
// ---------------------------------------------------------------------------

/// Fetch reactions for a single message and attach them to the view.
pub async fn attach_reactions_one(
    pool: &sqlx::PgPool,
    viewer: Uuid,
    view: &mut MessageView,
) -> Result<(), (StatusCode, String)> {
    attach_reactions(pool, viewer, std::slice::from_mut(view)).await
}

/// Fetch reactions for a slice of messages (keyed by id) and attach them.
/// The slice is mutated in-place.
pub async fn attach_reactions(
    pool: &sqlx::PgPool,
    viewer: Uuid,
    views: &mut [MessageView],
) -> Result<(), (StatusCode, String)> {
    if views.is_empty() {
        return Ok(());
    }

    let ids: Vec<Uuid> = views.iter().map(|v| v.id).collect();

    // One query: aggregate per (message_id, emoji), flag whether the viewer reacted.
    let rows = sqlx::query_as::<_, ReactionRow>(
        "SELECT message_id, emoji, \
                COUNT(*) AS count, \
                BOOL_OR(account_id = $1) AS reacted_by_me \
         FROM message_reactions \
         WHERE message_id = ANY($2) \
         GROUP BY message_id, emoji \
         ORDER BY MIN(created_at)",
    )
    .bind(viewer)
    .bind(&ids[..])
    .fetch_all(pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Distribute reactions back to the appropriate view.
    for row in rows {
        if let Some(view) = views.iter_mut().find(|v| v.id == row.message_id) {
            view.reactions.push(Reaction {
                emoji: row.emoji,
                count: row.count,
                reacted_by_me: row.reacted_by_me,
            });
        }
    }

    Ok(())
}

#[derive(sqlx::FromRow)]
struct ReactionRow {
    message_id: Uuid,
    emoji: String,
    count: i64,
    reacted_by_me: bool,
}

// ---------------------------------------------------------------------------
// PUT /api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}
// ---------------------------------------------------------------------------

pub async fn add_reaction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(Uuid, Uuid, String)>,
) -> Result<Json<MessageView>, (StatusCode, String)> {
    // Validate emoji: non-empty and at most 32 bytes.
    let emoji = emoji.trim().to_string();
    if emoji.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "emoji cannot be empty".to_string()));
    }
    if emoji.len() > 32 {
        return Err((StatusCode::BAD_REQUEST, "emoji exceeds 32 bytes".to_string()));
    }

    // Access control.
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    // Enforcement: mutes block social reactions (add only) in this chat context.
    sanctions::check_sanctions(
        &state.pool,
        auth.user_id,
        &[(sanctions::Sanction::Mute, chat.clan_id)],
    )
    .await?;

    // Verify message exists in this chat and is not deleted.
    let msg_exists: Option<(bool,)> = sqlx::query_as(
        "SELECT (deleted_at IS NULL) \
         FROM messages WHERE id = $1 AND chat_id = $2",
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    match msg_exists {
        None => return Err((StatusCode::NOT_FOUND, "message not found".to_string())),
        Some((false,)) => return Err((StatusCode::CONFLICT, "message is deleted".to_string())),
        Some((true,)) => {}
    }

    // Upsert (idempotent).
    sqlx::query(
        "INSERT INTO message_reactions (message_id, account_id, emoji) \
         VALUES ($1, $2, $3) \
         ON CONFLICT DO NOTHING",
    )
    .bind(message_id)
    .bind(auth.user_id)
    .bind(&emoji)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // Re-fetch the message view + attach reactions.
    let row = sqlx::query_as::<_, MessageJoinRow>(&format!(
        "SELECT {MSG_COLS} \
         FROM messages m \
         LEFT JOIN users u ON u.id = m.author_id \
         WHERE m.id = $1"
    ))
    .bind(message_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut view = row.into_view();
    attach_reactions_one(&state.pool, auth.user_id, &mut view).await?;

    Ok(Json(view))
}

// ---------------------------------------------------------------------------
// DELETE /api/v3/chats/{cid}/messages/{mid}/reactions/{emoji}
// ---------------------------------------------------------------------------

pub async fn remove_reaction(
    auth: AuthUser,
    State(state): State<AppState>,
    Path((chat_id, message_id, emoji)): Path<(Uuid, Uuid, String)>,
) -> Result<Json<Value>, (StatusCode, String)> {
    let emoji = emoji.trim().to_string();

    // Access control.
    let chat = load_chat(&state.pool, chat_id)
        .await?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "chat not found".to_string()))?;

    if !can_access_chat(&state.pool, auth.user_id, &chat).await? {
        return Err((StatusCode::FORBIDDEN, "access denied".to_string()));
    }

    // Delete (no-op if not present — that's fine).
    sqlx::query(
        "DELETE FROM message_reactions \
         WHERE message_id = $1 AND account_id = $2 AND emoji = $3",
    )
    .bind(message_id)
    .bind(auth.user_id)
    .bind(&emoji)
    .execute(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(json!({"ok": true})))
}
